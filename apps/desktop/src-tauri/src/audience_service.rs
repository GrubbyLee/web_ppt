use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use futures_util::{stream, SinkExt, StreamExt};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{broadcast, RwLock};
use tokio_stream::wrappers::BroadcastStream;

#[derive(Clone)]
pub struct AudienceService {
    local_port: u16,
    rooms: Arc<RwLock<HashMap<String, AudienceRoom>>>,
    listeners: Arc<RwLock<HashMap<IpAddr, u16>>>,
    sfu: Arc<Mutex<SfuManager>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AudienceDeliveryMode {
    P2p,
    Sfu,
}

impl AudienceDeliveryMode {
    fn from_snapshot(snapshot: &Value) -> Self {
        if snapshot
            .pointer("/project/audienceCapacityMode")
            .and_then(Value::as_str)
            == Some("sfu-20")
        {
            Self::Sfu
        } else {
            Self::P2p
        }
    }

    fn capacity(self) -> usize {
        match self {
            Self::P2p => 5,
            Self::Sfu => 20,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::P2p => "p2p",
            Self::Sfu => "sfu",
        }
    }
}

struct SfuProcess {
    url: String,
    room_name: String,
    api_key: String,
    api_secret: String,
    config_path: PathBuf,
    child: Child,
}

struct SfuManager {
    binary: Option<PathBuf>,
    sessions: HashMap<String, SfuProcess>,
}

#[derive(Clone)]
struct AudienceRoom {
    token: String,
    local_token: String,
    publisher_token: String,
    snapshot: Value,
    sender: broadcast::Sender<Value>,
    audience_count: Arc<AtomicUsize>,
    signal_sender: broadcast::Sender<Value>,
    viewers: Arc<RwLock<HashMap<String, AudienceViewer>>>,
    approval_required: bool,
    delivery_mode: AudienceDeliveryMode,
    sfu_url: Option<String>,
    sfu_room: Option<String>,
    sfu_api_key: Option<String>,
    sfu_api_secret: Option<String>,
}

impl AudienceRoom {
    fn sfu_credentials(&self) -> Option<SfuCredentials> {
        Some(SfuCredentials {
            url: self.sfu_url.clone()?,
            room_name: self.sfu_room.clone()?,
            api_key: self.sfu_api_key.clone()?,
            api_secret: self.sfu_api_secret.clone()?,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudienceShare {
    pub url: String,
    pub local_url: String,
    pub signal_url: String,
    pub session_id: String,
    pub token: String,
    pub network_name: String,
    pub network_address: String,
    pub delivery_mode: String,
    pub sfu_url: Option<String>,
    pub sfu_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudienceNetworkInterface {
    pub name: String,
    pub address: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudienceSessionStatus {
    pub audience_count: usize,
    pub capacity: usize,
    pub viewers: Vec<AudienceViewer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudienceViewer {
    pub id: String,
    pub display_name: String,
    pub ip: String,
    pub requested_at: u64,
    pub status: String,
    pub quality: String,
}

#[derive(Debug, Deserialize, Default)]
struct AudienceJoinQuery {
    name: Option<String>,
}

impl AudienceService {
    pub fn start(livekit_binary: Option<PathBuf>) -> Result<Self, String> {
        let local_address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let listener = TcpListener::bind((local_address, 0)).map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let service = Self {
            local_port: port,
            rooms: Arc::new(RwLock::new(HashMap::new())),
            listeners: Arc::new(RwLock::new(HashMap::from([(local_address, port)]))),
            sfu: Arc::new(Mutex::new(SfuManager {
                binary: livekit_binary,
                sessions: HashMap::new(),
            })),
        };
        spawn_listener(listener, service.clone());
        Ok(service)
    }

    pub fn network_interfaces() -> Vec<AudienceNetworkInterface> {
        let preferred = local_ip_address::local_ip().ok();
        let mut interfaces = local_ip_address::list_afinet_netifas()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(name, address)| match address {
                IpAddr::V4(address) if !address.is_unspecified() && !address.is_multicast() => {
                    Some(AudienceNetworkInterface {
                        name,
                        address: address.to_string(),
                        is_default: preferred == Some(IpAddr::V4(address)),
                    })
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        interfaces.sort_by_key(|item| {
            (
                !item.is_default,
                item.address == Ipv4Addr::LOCALHOST.to_string(),
                item.name.clone(),
            )
        });
        let mut seen_addresses = HashSet::new();
        interfaces.retain(|item| seen_addresses.insert(item.address.clone()));
        if interfaces.is_empty() {
            interfaces.push(AudienceNetworkInterface {
                name: "本机回环".to_string(),
                address: Ipv4Addr::LOCALHOST.to_string(),
                is_default: true,
            });
        }
        interfaces
    }

    async fn listener_for(
        &self,
        requested_address: Option<&str>,
    ) -> Result<(String, IpAddr, u16), String> {
        let interfaces = Self::network_interfaces();
        let selected = match requested_address {
            Some(address) => interfaces
                .iter()
                .find(|item| item.address == address)
                .ok_or_else(|| "所选网络接口已不可用，请重新选择".to_string())?,
            None => interfaces
                .iter()
                .find(|item| item.is_default)
                .or_else(|| interfaces.first())
                .ok_or_else(|| "未找到可用的 IPv4 网络接口".to_string())?,
        };
        let address = selected
            .address
            .parse::<IpAddr>()
            .map_err(|_| "网络接口地址无效".to_string())?;
        if let Some(port) = self.listeners.read().await.get(&address).copied() {
            return Ok((selected.name.clone(), address, port));
        }
        let mut listeners = self.listeners.write().await;
        if let Some(port) = listeners.get(&address).copied() {
            return Ok((selected.name.clone(), address, port));
        }
        let listener = TcpListener::bind((address, 0))
            .map_err(|error| format!("无法监听网络接口 {}: {error}", selected.name))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listeners.insert(address, port);
        drop(listeners);
        spawn_listener(listener, self.clone());
        Ok((selected.name.clone(), address, port))
    }

    pub async fn local_url(&self, session_id: &str) -> Result<String, String> {
        let rooms = self.rooms.read().await;
        let room = rooms
            .get(session_id)
            .ok_or_else(|| "观众会话尚未启动".to_string())?;
        Ok(format!(
            "http://127.0.0.1:{}/audience/{session_id}/{}",
            self.local_port, room.local_token
        ))
    }

    pub async fn create_session(
        &self,
        session_id: &str,
        snapshot: Value,
        network_address: Option<&str>,
    ) -> Result<AudienceShare, String> {
        if !valid_identifier(session_id) {
            return Err("会话 ID 无效".to_string());
        }
        let (network_name, address, port) = self.listener_for(network_address).await?;
        let delivery_mode = AudienceDeliveryMode::from_snapshot(&snapshot);
        if let Some(existing) = self.rooms.read().await.get(session_id) {
            if existing.delivery_mode != delivery_mode {
                return Err("当前观众会话已使用另一种容量模式启动，请先停止分享后重试".to_string());
            }
        }
        let sfu = if delivery_mode == AudienceDeliveryMode::Sfu {
            Some(
                self.sfu
                    .lock()
                    .map_err(|_| "本地 SFU 状态不可用".to_string())?
                    .start_session(session_id, address)?,
            )
        } else {
            None
        };
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(session_id.to_string()).or_insert_with(|| {
            let (sender, _) = broadcast::channel(32);
            let (signal_sender, _) = broadcast::channel(128);
            let approval_required = snapshot
                .pointer("/project/audienceJoinMode")
                .and_then(Value::as_str)
                == Some("approval");
            AudienceRoom {
                token: random_token(),
                local_token: random_token(),
                publisher_token: random_token(),
                snapshot: snapshot.clone(),
                sender,
                audience_count: Arc::new(AtomicUsize::new(0)),
                signal_sender,
                viewers: Arc::new(RwLock::new(HashMap::new())),
                approval_required,
                delivery_mode,
                sfu_url: sfu.as_ref().map(|credentials| credentials.url.clone()),
                sfu_room: sfu
                    .as_ref()
                    .map(|credentials| credentials.room_name.clone()),
                sfu_api_key: sfu.as_ref().map(|credentials| credentials.api_key.clone()),
                sfu_api_secret: sfu
                    .as_ref()
                    .map(|credentials| credentials.api_secret.clone()),
            }
        });
        room.snapshot = snapshot;
        room.approval_required = room
            .snapshot
            .pointer("/project/audienceJoinMode")
            .and_then(Value::as_str)
            == Some("approval");
        let _ = room.sender.send(room.snapshot.clone());
        let host = match address {
            IpAddr::V4(address) => address.to_string(),
            IpAddr::V6(address) => format!("[{address}]"),
        };
        let sfu_token = match room.sfu_credentials() {
            Some(credentials) => Some(livekit_token(&credentials, "showit-publisher", true)?),
            None => None,
        };
        Ok(AudienceShare {
            url: format!("http://{host}:{port}/audience/{session_id}/{}", room.token),
            local_url: format!(
                "http://127.0.0.1:{}/audience/{session_id}/{}",
                self.local_port, room.local_token
            ),
            signal_url: format!(
                "ws://127.0.0.1:{}/signal/{session_id}/{}/publisher",
                self.local_port, room.publisher_token
            ),
            session_id: session_id.to_string(),
            token: room.token.clone(),
            network_name,
            network_address: address.to_string(),
            delivery_mode: room.delivery_mode.as_str().to_string(),
            sfu_url: room.sfu_url.clone(),
            sfu_token,
        })
    }

    pub async fn disconnect_all_viewers(&self, session_id: &str) -> Result<(), String> {
        if !valid_identifier(session_id) {
            return Err("观众会话标识无效".to_string());
        }
        let room = self
            .rooms
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "观众会话尚未启动".to_string())?;
        let viewer_ids = room
            .viewers
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        room.viewers.write().await.clear();
        for viewer_id in viewer_ids {
            let _ = room
                .signal_sender
                .send(json!({ "type": "viewer-disconnected", "to": viewer_id }));
        }
        Ok(())
    }
}

fn spawn_listener(listener: TcpListener, service: AudienceService) {
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/assets/livekit-client.js", get(livekit_client))
        .route("/audience/{session_id}/{token}", get(audience_page))
        .route(
            "/events/{session_id}/{token}/{peer_id}",
            get(audience_events),
        )
        .route(
            "/signal/{session_id}/{token}/{role}/{peer_id}",
            get(signal_socket),
        )
        .route("/sfu-token/{session_id}/{token}/{peer_id}", get(sfu_token))
        .with_state(service.clone());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("观众服务监听器启动失败: {error}");
                return;
            }
        };
        if let Err(error) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            eprintln!("观众服务异常退出: {error}");
        }
    });
}

const LIVEKIT_CLIENT_JS: &str = include_str!("../resources/livekit-client.umd.js");

async fn livekit_client() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/javascript; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        LIVEKIT_CLIENT_JS,
    )
        .into_response()
}

impl AudienceService {
    pub async fn publish(&self, session_id: &str, snapshot: Value) -> Result<(), String> {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .get_mut(session_id)
            .ok_or_else(|| "观众会话尚未启动".to_string())?;
        room.snapshot = snapshot.clone();
        let _ = room.sender.send(snapshot);
        Ok(())
    }

    pub async fn stop_session(&self, session_id: &str) {
        if let Some(room) = self.rooms.write().await.remove(session_id) {
            let _ = room.signal_sender.send(json!({ "type": "session-ended" }));
        }
        if let Ok(mut manager) = self.sfu.lock() {
            manager.stop_session(session_id);
        }
    }

    pub async fn session_status(&self, session_id: &str) -> Option<AudienceSessionStatus> {
        if !valid_identifier(session_id) {
            return None;
        }
        let room = self.rooms.read().await.get(session_id).cloned()?;
        let mut viewers: Vec<_> = room.viewers.read().await.values().cloned().collect();
        viewers.sort_by_key(|viewer| viewer.requested_at);
        Some(AudienceSessionStatus {
            audience_count: room.audience_count.load(Ordering::SeqCst),
            capacity: room.delivery_mode.capacity(),
            viewers,
        })
    }

    pub async fn decide_viewer(
        &self,
        session_id: &str,
        viewer_id: &str,
        approve: bool,
    ) -> Result<(), String> {
        if !valid_identifier(session_id) || !valid_identifier(viewer_id) {
            return Err("观众控制标识无效".to_string());
        }
        let room = self
            .rooms
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "观众会话尚未启动".to_string())?;
        let mut viewers = room.viewers.write().await;
        if viewers.get(viewer_id).map(|viewer| viewer.status.as_str()) != Some("pending") {
            return Err("观众申请不存在或已处理".to_string());
        }
        if approve {
            viewers.get_mut(viewer_id).expect("checked above").status = "approved".to_string();
        } else {
            viewers.remove(viewer_id);
        }
        let _ = room.signal_sender.send(json!({ "type": if approve { "viewer-approved" } else { "viewer-rejected" }, "to": viewer_id }));
        Ok(())
    }

    pub async fn disconnect_viewer(&self, session_id: &str, viewer_id: &str) -> Result<(), String> {
        if !valid_identifier(session_id) || !valid_identifier(viewer_id) {
            return Err("观众控制标识无效".to_string());
        }
        let room = self
            .rooms
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "观众会话尚未启动".to_string())?;
        if room.viewers.write().await.remove(viewer_id).is_none() {
            return Err("观众不存在".to_string());
        }
        let _ = room
            .signal_sender
            .send(json!({ "type": "viewer-disconnected", "to": viewer_id }));
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn random_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

#[derive(Clone)]
struct SfuCredentials {
    url: String,
    room_name: String,
    api_key: String,
    api_secret: String,
}

impl SfuManager {
    fn start_session(
        &mut self,
        session_id: &str,
        address: IpAddr,
    ) -> Result<SfuCredentials, String> {
        if let Some(process) = self.sessions.get_mut(session_id) {
            if process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(process.credentials());
            }
        }
        self.stop_session(session_id);
        let binary = self
            .binary
            .as_ref()
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                "20 人 SFU 组件不可用，请重新安装完整版本或运行 livekit:prepare".to_string()
            })?;
        let api_reservation = TcpListener::bind((address, 0))
            .map_err(|error| format!("无法分配 SFU API 端口: {error}"))?;
        let rtc_tcp_reservation = TcpListener::bind((address, 0))
            .map_err(|error| format!("无法分配 SFU TCP 端口: {error}"))?;
        let rtc_udp_reservation = UdpSocket::bind((address, 0))
            .map_err(|error| format!("无法分配 SFU UDP 端口: {error}"))?;
        let api_port = api_reservation
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let rtc_tcp_port = rtc_tcp_reservation
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let rtc_udp_port = rtc_udp_reservation
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let api_key = format!("showit{}", random_token());
        let api_secret = format!("{}{}", random_token(), random_token());
        let room_name = format!("showit-{session_id}");
        let config_path = std::env::temp_dir().join(format!(
            "showit-livekit-{session_id}-{}.yaml",
            random_token()
        ));
        let config = format!(
            "port: {api_port}\nbind_addresses:\n  - \"{address}\"\nrtc:\n  udp_port: {rtc_udp_port}\n  tcp_port: {rtc_tcp_port}\n  use_external_ip: false\n  use_mdns: false\n  stun_servers: []\nkeys:\n  \"{api_key}\": \"{api_secret}\"\nroom:\n  empty_timeout: 60\n  departure_timeout: 10\n  max_participants: 21\nturn:\n  enabled: false\nlogging:\n  level: warn\n"
        );
        std::fs::write(&config_path, config)
            .map_err(|error| format!("无法写入 SFU 配置: {error}"))?;
        drop(api_reservation);
        drop(rtc_tcp_reservation);
        drop(rtc_udp_reservation);
        let mut child = Command::new(binary)
            .arg("--config")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动本地 SFU: {error}"))?;
        let socket = SocketAddr::new(address, api_port);
        let mut ready = false;
        for _ in 0..60 {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                break;
            }
            if std::net::TcpStream::connect_timeout(&socket, Duration::from_millis(100)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !ready {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&config_path);
            return Err("本地 SFU 未能在 6 秒内启动".to_string());
        }
        let process = SfuProcess {
            url: format!("ws://{address}:{api_port}"),
            room_name,
            api_key,
            api_secret,
            config_path,
            child,
        };
        let credentials = process.credentials();
        self.sessions.insert(session_id.to_string(), process);
        Ok(credentials)
    }

    fn stop_session(&mut self, session_id: &str) {
        if let Some(mut process) = self.sessions.remove(session_id) {
            let _ = process.child.kill();
            let _ = process.child.wait();
            let _ = std::fs::remove_file(process.config_path);
        }
    }
}

impl SfuProcess {
    fn credentials(&self) -> SfuCredentials {
        SfuCredentials {
            url: self.url.clone(),
            room_name: self.room_name.clone(),
            api_key: self.api_key.clone(),
            api_secret: self.api_secret.clone(),
        }
    }
}

impl Drop for SfuManager {
    fn drop(&mut self) {
        for (_, mut process) in self.sessions.drain() {
            let _ = process.child.kill();
            let _ = process.child.wait();
            let _ = std::fs::remove_file(process.config_path);
        }
    }
}

#[derive(Serialize)]
struct LiveKitClaims {
    iss: String,
    sub: String,
    nbf: u64,
    exp: u64,
    video: LiveKitVideoGrant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveKitVideoGrant {
    room_join: bool,
    room: String,
    can_publish: bool,
    can_subscribe: bool,
    can_publish_data: bool,
}

fn livekit_token(
    credentials: &SfuCredentials,
    identity: &str,
    publish: bool,
) -> Result<String, String> {
    let now = unix_millis() / 1_000;
    encode(
        &Header::new(Algorithm::HS256),
        &LiveKitClaims {
            iss: credentials.api_key.clone(),
            sub: identity.to_string(),
            nbf: now.saturating_sub(5),
            exp: now + 6 * 60 * 60,
            video: LiveKitVideoGrant {
                room_join: true,
                room: credentials.room_name.clone(),
                can_publish: publish,
                can_subscribe: !publish,
                can_publish_data: false,
            },
        },
        &EncodingKey::from_secret(credentials.api_secret.as_bytes()),
    )
    .map_err(|error| format!("无法签发 SFU 访问令牌: {error}"))
}

async fn room(
    service: &AudienceService,
    session_id: &str,
    token: &str,
) -> Option<(AudienceRoom, bool)> {
    let room = service.rooms.read().await.get(session_id).cloned()?;
    if room.token == token {
        Some((room, false))
    } else if room.local_token == token {
        Some((room, true))
    } else {
        None
    }
}

async fn audience_page(
    State(service): State<AudienceService>,
    Path((session_id, token)): Path<(String, String)>,
) -> Response {
    let Some((room, local_viewer)) = room(&service, &session_id, &token).await else {
        return (StatusCode::NOT_FOUND, "观众会话无效或已结束").into_response();
    };
    let sfu_connect = room.sfu_url.as_deref().unwrap_or("");
    let csp = format!("default-src 'none'; script-src 'nonce-{token}'; style-src 'unsafe-inline'; connect-src 'self' {sfu_connect}; frame-src 'self' data:; media-src blob: data:; img-src 'self' data:");
    let headers = [
        (
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&csp).unwrap_or(HeaderValue::from_static("default-src 'none'")),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
    ];
    (
        headers,
        Html(audience_html(
            &session_id,
            &token,
            if local_viewer { "local" } else { "audience" },
            room.delivery_mode.as_str(),
        )),
    )
        .into_response()
}

async fn audience_events(
    State(service): State<AudienceService>,
    Path((session_id, token, peer_id)): Path<(String, String, String)>,
) -> Response {
    let Some(room) = service.rooms.read().await.get(&session_id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let local_viewer = room.local_token == token;
    if room.token != token && !local_viewer {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !local_viewer
        && room
            .viewers
            .read()
            .await
            .get(&peer_id)
            .map(|viewer| viewer.status.as_str())
            != Some("connected")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let initial = room.snapshot;
    let updates = BroadcastStream::new(room.sender.subscribe())
        .filter_map(|message| async move { message.ok() });
    let mut controls = room.signal_sender.subscribe();
    let stop = async move {
        loop {
            let Ok(value) = controls.recv().await else {
                continue;
            };
            let message_type = value.get("type").and_then(Value::as_str);
            let addressed = value.get("to").and_then(Value::as_str) == Some(peer_id.as_str());
            if message_type == Some("session-ended")
                || (addressed
                    && matches!(
                        message_type,
                        Some("viewer-rejected" | "viewer-disconnected")
                    ))
            {
                break;
            }
        }
    };
    let values = stream::once(async move { initial })
        .chain(updates)
        .take_until(stop);
    let events =
        values.map(|value| Ok::<Event, Infallible>(Event::default().data(value.to_string())));
    Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(10))
                .text("ping"),
        )
        .into_response()
}

async fn sfu_token(
    State(service): State<AudienceService>,
    Path((session_id, token, peer_id)): Path<(String, String, String)>,
) -> Response {
    if !valid_identifier(&peer_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(room) = service.rooms.read().await.get(&session_id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let local_viewer = room.local_token == token;
    if room.token != token && !local_viewer {
        return StatusCode::NOT_FOUND.into_response();
    }
    if room.delivery_mode != AudienceDeliveryMode::Sfu {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !local_viewer
        && room
            .viewers
            .read()
            .await
            .get(&peer_id)
            .map(|viewer| viewer.status.as_str())
            != Some("connected")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(credentials) = room.sfu_credentials() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match livekit_token(&credentials, &format!("showit-viewer-{peer_id}"), false) {
        Ok(token) => Json(json!({ "url": credentials.url, "token": token })).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn signal_socket(
    upgrade: WebSocketUpgrade,
    State(service): State<AudienceService>,
    Path((session_id, token, role, peer_id)): Path<(String, String, String, String)>,
    Query(query): Query<AudienceJoinQuery>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if !valid_peer_id_for_role(&role, &peer_id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(room) = service.rooms.read().await.get(&session_id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let valid_token = match role.as_str() {
        "publisher" => room.publisher_token == token,
        "audience" => room.token == token,
        "local" => room.local_token == token && remote.ip().is_loopback(),
        _ => false,
    };
    if !valid_token {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut audience_guard = None;
    if role == "audience" {
        let mut viewers = room.viewers.write().await;
        if viewers.contains_key(&peer_id) {
            return (StatusCode::CONFLICT, "观众标识已存在").into_response();
        }
        if !room.approval_required {
            let Some(guard) = AudienceConnection::try_acquire(
                room.audience_count.clone(),
                room.delivery_mode.capacity(),
            ) else {
                return (StatusCode::TOO_MANY_REQUESTS, "观众人数已达到容量上限").into_response();
            };
            audience_guard = Some(guard);
        }
        let display_name = query
            .name
            .unwrap_or_else(|| "观众".to_string())
            .trim()
            .chars()
            .take(40)
            .collect::<String>();
        viewers.insert(
            peer_id.clone(),
            AudienceViewer {
                id: peer_id.clone(),
                display_name: if display_name.is_empty() {
                    "观众".to_string()
                } else {
                    display_name
                },
                ip: remote.ip().to_string(),
                requested_at: unix_millis(),
                status: if room.approval_required {
                    "pending".to_string()
                } else {
                    "connected".to_string()
                },
                quality: "waiting".to_string(),
            },
        );
    }
    upgrade
        .on_upgrade(move |socket| handle_signal_socket(socket, room, role, peer_id, audience_guard))
}

async fn handle_signal_socket(
    socket: WebSocket,
    room: AudienceRoom,
    role: String,
    peer_id: String,
    mut audience_guard: Option<AudienceConnection>,
) {
    let (mut outgoing, mut incoming) = socket.split();
    let sender = room.signal_sender.clone();
    let mut receiver = sender.subscribe();
    if role == "audience" && audience_guard.is_none() {
        let _ = outgoing
            .send(Message::Text(
                json!({ "type": "viewer-pending" }).to_string().into(),
            ))
            .await;
        loop {
            tokio::select! {
                incoming_message = incoming.next() => { if !matches!(incoming_message, Some(Ok(_))) { room.viewers.write().await.remove(&peer_id); return; } }
                decision = receiver.recv() => {
                    let Ok(value) = decision else { continue };
                    if value.get("to").and_then(Value::as_str) != Some(peer_id.as_str()) { continue; }
                    match value.get("type").and_then(Value::as_str) {
                        Some("viewer-approved") => {
                            let Some(guard) = AudienceConnection::try_acquire(room.audience_count.clone(), room.delivery_mode.capacity()) else { let _ = outgoing.send(Message::Text(json!({"type":"viewer-full"}).to_string().into())).await; room.viewers.write().await.remove(&peer_id); return; };
                            audience_guard = Some(guard);
                            if let Some(viewer) = room.viewers.write().await.get_mut(&peer_id) { viewer.status = "connected".to_string(); }
                            let _ = outgoing.send(Message::Text(value.to_string().into())).await;
                            break;
                        }
                        Some("viewer-rejected" | "viewer-disconnected") => { let _ = outgoing.send(Message::Text(value.to_string().into())).await; room.viewers.write().await.remove(&peer_id); return; }
                        _ => {}
                    }
                }
            }
        }
    } else if matches!(role.as_str(), "audience" | "local") {
        let _ = outgoing
            .send(Message::Text(
                json!({ "type": "viewer-approved", "to": peer_id })
                    .to_string()
                    .into(),
            ))
            .await;
    }
    let joined = if role == "publisher" {
        json!({ "type": "publisher-ready", "from": peer_id, "role": role })
    } else {
        json!({ "type": "join", "from": peer_id, "role": role, "to": "publisher" })
    };
    let _ = sender.send(joined);

    loop {
        tokio::select! {
            incoming_message = incoming.next() => {
                let Some(Ok(message)) = incoming_message else { break };
                let Message::Text(text) = message else { continue };
                if text.len() > 262_144 { break; }
                let Ok(mut value) = serde_json::from_str::<Value>(&text) else { continue };
                let message_type = value.get("type").and_then(Value::as_str).unwrap_or_default();
                if message_type == "quality" && role == "audience" {
                    let quality = value.get("quality").and_then(Value::as_str).unwrap_or_default();
                    if matches!(quality, "good" | "fair" | "poor") {
                        if let Some(viewer) = room.viewers.write().await.get_mut(&peer_id) {
                            viewer.quality = quality.to_string();
                        }
                    }
                    continue;
                }
                if !valid_client_signal(&role, message_type, value.get("to").and_then(Value::as_str)) {
                    continue;
                }
                if let Some(object) = value.as_object_mut() {
                    object.insert("from".to_string(), Value::String(peer_id.clone()));
                    object.insert("role".to_string(), Value::String(role.clone()));
                }
                let _ = sender.send(value);
            }
            outgoing_message = receiver.recv() => {
                let Ok(value) = outgoing_message else { continue };
                if !signal_message_is_for_peer(&value, &role, &peer_id) { continue; }
                if outgoing.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
        }
    }
    if role != "publisher" {
        let _ = sender
            .send(json!({ "type": "leave", "from": peer_id, "role": role, "to": "publisher" }));
    }
    if role == "audience" {
        room.viewers.write().await.remove(&peer_id);
    }
    drop(audience_guard);
}

fn valid_peer_id_for_role(role: &str, peer_id: &str) -> bool {
    matches!(role, "publisher" | "audience" | "local")
        && valid_identifier(peer_id)
        && peer_id
            .strip_prefix(role)
            .is_some_and(|suffix| suffix.starts_with('-') && suffix.len() > 1)
}

fn valid_client_signal(role: &str, message_type: &str, target: Option<&str>) -> bool {
    let Some(target) = target else {
        return false;
    };
    match role {
        "publisher" => {
            matches!(message_type, "offer" | "ice")
                && valid_identifier(target)
                && (target.starts_with("audience-") || target.starts_with("local-"))
        }
        "audience" | "local" => match message_type {
            "join" | "preference" => target == "publisher",
            "answer" | "ice" => valid_identifier(target) && target.starts_with("publisher-"),
            _ => false,
        },
        _ => false,
    }
}

fn signal_message_is_for_peer(value: &Value, role: &str, peer_id: &str) -> bool {
    if value.get("from").and_then(Value::as_str) == Some(peer_id) {
        return false;
    }
    match value.get("to").and_then(Value::as_str) {
        Some(target) => target == peer_id || (target == "publisher" && role == "publisher"),
        None => {
            let message_type = value.get("type").and_then(Value::as_str);
            message_type == Some("session-ended")
                || (message_type == Some("publisher-ready") && matches!(role, "audience" | "local"))
        }
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn audience_html(session_id: &str, token: &str, role: &str, delivery_mode: &str) -> String {
    r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link id="favicon" rel="icon"><title>Showit 观众屏</title>
<style>*{box-sizing:border-box}html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden;color:#f5f8fb;background:#0d1015;font:14px system-ui,sans-serif}#stream,#offline-image,#offline-video,#offline-frame,#frozen{position:absolute;inset:0;display:none;width:100%;height:100%;border:0;background:#0b0f13;object-fit:contain}#offline-frame{background:#eef3f7}#annotations{position:absolute;z-index:1;inset:0;width:100%;height:100%;pointer-events:none}#annotations ellipse{fill:none;stroke:#ff4d5d;stroke-width:3;vector-effect:non-scaling-stroke}#annotations circle{fill:#ff344d;stroke:#fff;stroke-width:1.5;vector-effect:non-scaling-stroke}#privacy-masks{position:absolute;z-index:2;inset:0;pointer-events:none}#privacy-masks span{position:absolute;display:block;min-width:1px;min-height:1px;background:#111820}#privacy-masks span.blur{background:#12182052;backdrop-filter:blur(14px)}#empty,#cover{position:absolute;inset:0;display:grid;place-content:center;gap:8px;padding:24px;text-align:center}#empty span,#cover span{color:#91a0b0;font-size:12px}#cover{display:none;z-index:3}#status{position:fixed;z-index:4;right:12px;bottom:10px;display:flex;align-items:center;gap:10px;border:1px solid #303b49;border-radius:5px;padding:6px 9px;background:#12171eee;font:11px ui-monospace,monospace}#connection{color:#37d0ba}#offline-badge{display:none;color:#ffe3a0}#quality{border:1px solid #303b49;border-radius:3px;padding:2px;color:#dbe6ef;background:#12171e;font:11px system-ui,sans-serif}#fullscreen{width:24px;height:24px;border:0;color:#f5f8fb;background:transparent;font-size:17px;cursor:pointer}@media(max-width:600px){#status{right:8px;bottom:8px}}</style></head>
<body><main><video id="stream" autoplay playsinline muted></video><canvas id="frozen"></canvas><img id="offline-image" alt="离线备用画面"><video id="offline-video" autoplay loop playsinline muted></video><iframe id="offline-frame" title="离线备用画面" sandbox="" referrerpolicy="no-referrer"></iframe><svg id="annotations" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg><div id="privacy-masks"></div><section id="empty"><strong id="title">等待演讲者</strong><span id="label">正在连接会话</span></section><section id="cover"><strong id="cover-title"></strong><span id="cover-label"></span></section><aside id="status"><span id="connection">连接中</span><span id="offline-badge">离线备用</span><select id="quality" aria-label="画质"><option value="auto">自动画质</option><option value="high">高清</option><option value="low">流畅</option></select><strong id="page">--/--</strong><button id="fullscreen" type="button" title="全屏" aria-label="全屏">&#x26F6;</button></aside></main>
<script nonce="__TOKEN__" src="/assets/livekit-client.js"></script><script nonce="__TOKEN__">
const sessionId='__SESSION__';const token='__TOKEN__';const role='__ROLE__';const streamMode='__DELIVERY_MODE__';
const stream=document.querySelector('#stream');const frozen=document.querySelector('#frozen');const image=document.querySelector('#offline-image');const video=document.querySelector('#offline-video');const frame=document.querySelector('#offline-frame');const empty=document.querySelector('#empty');const cover=document.querySelector('#cover');const badge=document.querySelector('#offline-badge');const masks=document.querySelector('#privacy-masks');const annotations=document.querySelector('#annotations');const connection=document.querySelector('#connection');const quality=document.querySelector('#quality');const favicon=document.querySelector('#favicon');
let hasStream=false;let remoteStream=null;let latest=null;let source=null;let ws=null;let pc=null;let sfuRoom=null;let sfuPublication=null;let peerId='';let reconnectTimer=0;let reconnectAttempt=0;let stopped=false;let terminal=false;let lastMode='normal';const displayName=role==='local'?'本机观众屏':`观众 ${Math.random().toString(36).slice(-4).toUpperCase()}`;
const hideMedia=()=>{stream.style.display='none';image.style.display='none';video.style.display='none';frame.style.display='none';video.pause();video.removeAttribute('src');image.removeAttribute('src');frame.removeAttribute('srcdoc')};
const isolatedHtml=(content)=>{const policy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`;return /<head(?:\s[^>]*)?>/i.test(content)?content.replace(/<head(?:\s[^>]*)?>/i,(head)=>head+policy):policy+content};
const renderMasks=(items)=>{masks.replaceChildren(...items.slice(0,30).map((mask)=>{const node=document.createElement('span');const x=Math.min(mask.x1,mask.x2);const y=Math.min(mask.y1,mask.y2);node.style.left=`${x*100}%`;node.style.top=`${y*100}%`;node.style.width=`${Math.abs(mask.x2-mask.x1)*100}%`;node.style.height=`${Math.abs(mask.y2-mask.y1)*100}%`;if(mask.mode==='blur')node.className='blur';return node}))};
const svgNode=(name,values)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(values).forEach(([key,value])=>node.setAttribute(key,String(value)));return node};const renderAnnotations=(state)=>{const nodes=(Array.isArray(state?.circles)?state.circles:[]).slice(0,100).map((circle)=>{const x=Math.min(circle.x1,circle.x2);const y=Math.min(circle.y1,circle.y2);return svgNode('ellipse',{cx:x+Math.abs(circle.x2-circle.x1)/2,cy:y+Math.abs(circle.y2-circle.y1)/2,rx:Math.abs(circle.x2-circle.x1)/2,ry:Math.abs(circle.y2-circle.y1)/2})});if(state?.laser&&state.laser.expiresAt>Date.now())nodes.push(svgNode('circle',{cx:state.laser.x,cy:state.laser.y,r:.015}));annotations.replaceChildren(...nodes)};
const render=()=>{if(!latest)return;const project=latest.project;const state=latest.session;const item=latest.page;const mode=state?.screenMode??'normal';document.title=project?.brand?.audienceTitle||'Showit 观众屏';if(/^data:image\/(png|jpeg|webp);base64,/.test(project?.brand?.logoDataUrl||''))favicon.href=project.brand.logoDataUrl;else favicon.removeAttribute('href');document.querySelector('#page').textContent=`${(state?.currentPageIndex??0)+1}/${state?.pageCount??0}`;document.querySelector('#title').textContent=item?.title??'等待演讲者';document.querySelector('#label').textContent=item?.businessLabel??'';renderMasks(Array.isArray(item?.privacyMasks)?item.privacyMasks:[]);renderAnnotations(state);hideMedia();const useOffline=item?.offline;badge.style.display=useOffline?'inline':'none';badge.textContent=project?.brand?.offlineLabel||'离线备用';if(useOffline?.kind==='image'&&/^data:image\/(png|jpeg|webp);base64,/.test(useOffline.dataUrl||'')){image.src=useOffline.dataUrl;image.style.display='block';empty.style.display='none'}else if(useOffline?.kind==='video'&&/^data:video\/(mp4|webm);base64,/.test(useOffline.dataUrl||'')){video.src=useOffline.dataUrl;video.style.display='block';empty.style.display='none';video.play().catch(()=>undefined)}else if(useOffline?.kind==='html'&&typeof useOffline.content==='string'){frame.srcdoc=isolatedHtml(useOffline.content);frame.style.display='block';empty.style.display='none'}else if(hasStream){if(stream.srcObject!==remoteStream)stream.srcObject=remoteStream;stream.style.display='block';stream.play().catch(()=>undefined);empty.style.display='none'}else{empty.style.display='grid'}if(mode==='normal'){frozen.style.display='none';cover.style.display='none'}else{if(mode==='frozen'&&lastMode!=='frozen'&&stream.videoWidth&&stream.videoHeight){frozen.width=stream.videoWidth;frozen.height=stream.videoHeight;frozen.getContext('2d')?.drawImage(stream,0,0,frozen.width,frozen.height)}if(mode==='frozen'&&frozen.width){frozen.style.display='block'}else{frozen.style.display='none'}if(mode==='privacy'){hideMedia();stream.srcObject=null;frozen.getContext('2d')?.clearRect(0,0,frozen.width,frozen.height);frozen.width=0;frozen.height=0}stream.style.display='none';cover.style.display='grid';cover.style.background=mode==='white'?'#fff':mode==='black'?'#050607':mode==='frozen'?'rgb(8 13 18 / 28%)':project?.brand?.statusBackgroundColor||'#18212c';cover.style.color=mode==='white'?'#17212a':'#f5f8fb';document.querySelector('#cover-title').textContent=mode==='ended'?project?.brand?.endTitle||'演示结束':mode==='privacy'?project?.brand?.privacyMessage||'演示准备中':mode==='frozen'?'画面冻结':mode==='white'?'白屏':'黑屏';document.querySelector('#cover-label').textContent=mode==='ended'?project?.brand?.endDescription||'':item?.businessLabel??''}lastMode=mode};
const closeTransport=()=>{source?.close();source=null;if(pc){pc.onconnectionstatechange=null;pc.close();pc=null}if(sfuRoom){sfuRoom.disconnect();sfuRoom=null}sfuPublication=null;if(ws){ws.onclose=null;ws.close();ws=null}hasStream=false;remoteStream=null;stream.srcObject=null;render()};
const scheduleReconnect=()=>{if(stopped||terminal||reconnectTimer)return;closeTransport();connection.textContent='重连中';const delay=Math.min(10000,500*2**Math.min(reconnectAttempt++,5));reconnectTimer=setTimeout(()=>{reconnectTimer=0;connect()},delay)};
const startSource=()=>{source?.close();source=new EventSource(`/events/${sessionId}/${token}/${peerId}`);source.onopen=()=>{connection.textContent='已同步';reconnectAttempt=0};source.onerror=()=>{connection.textContent='重连中'};source.onmessage=(event)=>{try{latest=JSON.parse(event.data);render()}catch{connection.textContent='数据异常'}}};
const send=(message)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message))};
const startSfu=async()=>{const response=await fetch(`/sfu-token/${sessionId}/${token}/${peerId}`,{cache:'no-store'});if(!response.ok)throw new Error('SFU 访问未获批准');const access=await response.json();if(!window.LivekitClient)throw new Error('SFU 客户端不可用');sfuRoom=new window.LivekitClient.Room({adaptiveStream:true,dynacast:true});sfuRoom.on(window.LivekitClient.RoomEvent.TrackSubscribed,(track,publication)=>{if(track.kind!=='video')return;sfuPublication=publication;hasStream=true;remoteStream=new MediaStream([track.mediaStreamTrack]);render()});sfuRoom.on(window.LivekitClient.RoomEvent.Disconnected,()=>{if(!stopped&&!terminal)scheduleReconnect()});await sfuRoom.connect(access.url,access.token,{autoSubscribe:true});send({type:'quality',quality:'good'})};
const connect=()=>{if(stopped||terminal)return;closeTransport();peerId=`${role}-${Math.random().toString(36).slice(2)}`;if(streamMode==='p2p'){pc=new RTCPeerConnection({iceServers:[]});pc.onicecandidate=(event)=>{if(event.candidate)send({type:'ice',to:'publisher',candidate:event.candidate})};pc.ontrack=(event)=>{hasStream=true;remoteStream=event.streams[0];render()};pc.onconnectionstatechange=()=>{if(pc?.connectionState==='failed')scheduleReconnect()}};ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/signal/${sessionId}/${token}/${role}/${peerId}?name=${encodeURIComponent(displayName)}`);ws.onopen=()=>{connection.textContent='正在同步'};ws.onmessage=async(event)=>{try{const message=JSON.parse(event.data);if(message.to&&message.to!==peerId&&message.to!==role)return;if(message.type==='viewer-pending')connection.textContent='等待演讲者批准';if(message.type==='viewer-approved'){startSource();if(streamMode==='sfu'){await startSfu();connection.textContent='已同步';reconnectAttempt=0;return}send({type:'join',to:'publisher'});send({type:'preference',to:'publisher',mode:quality.value})}if(message.type==='viewer-rejected'||message.type==='viewer-disconnected'||message.type==='viewer-full'||message.type==='session-ended'){terminal=true;connection.textContent=message.type==='viewer-rejected'?'加入申请被拒绝':message.type==='viewer-full'?'观众人数已满':message.type==='session-ended'?'演示已结束':'已被演讲者断开';closeTransport();return}if(streamMode==='p2p'&&(message.type==='publisher-ready'||message.type==='join'))send({type:'join',to:'publisher'});if(streamMode==='p2p'&&message.type==='offer'&&pc){await pc.setRemoteDescription(message.description);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'answer',to:message.from,description:pc.localDescription});send({type:'preference',to:'publisher',mode:quality.value})}if(streamMode==='p2p'&&message.type==='ice'&&message.candidate&&pc)await pc.addIceCandidate(message.candidate)}catch{connection.textContent='流连接异常'}};ws.onclose=()=>scheduleReconnect();ws.onerror=()=>{connection.textContent='连接异常'}};
quality.addEventListener('change',()=>{if(streamMode==='sfu'){if(sfuPublication)sfuPublication.setVideoQuality(quality.value==='low'?window.LivekitClient.VideoQuality.Low:window.LivekitClient.VideoQuality.High);return}send({type:'preference',to:'publisher',mode:quality.value})});
setInterval(async()=>{if(pc?.connectionState!=='connected'||ws?.readyState!==WebSocket.OPEN)return;try{const stats=await pc.getStats();let lost=0,received=0,jitter=0;stats.forEach((item)=>{if(item.type==='inbound-rtp'&&item.kind==='video'){lost+=item.packetsLost||0;received+=item.packetsReceived||0;jitter=Math.max(jitter,item.jitter||0)}});const loss=lost/Math.max(1,lost+received);send({type:'quality',quality:loss>0.05||jitter>0.1?'poor':loss>0.02||jitter>0.05?'fair':'good'})}catch{}},3000);
document.querySelector('#fullscreen').addEventListener('click',()=>{if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen().catch(()=>undefined)});document.addEventListener('visibilitychange',()=>{if(document.hidden){stream.pause();video.pause()}else{render();if(!ws&&!terminal)connect()}});window.addEventListener('beforeunload',()=>{stopped=true;clearTimeout(reconnectTimer);closeTransport()});connect();
</script></body></html>"#
        .replace("__SESSION__", session_id)
        .replace("__TOKEN__", token)
        .replace("__ROLE__", role)
        .replace("__DELIVERY_MODE__", delivery_mode)
}

struct AudienceConnection {
    count: Arc<AtomicUsize>,
}

impl AudienceConnection {
    fn try_acquire(count: Arc<AtomicUsize>, capacity: usize) -> Option<Self> {
        if count.fetch_add(1, Ordering::SeqCst) >= capacity {
            count.fetch_sub(1, Ordering::SeqCst);
            None
        } else {
            Some(Self { count })
        }
    }
}

impl Drop for AudienceConnection {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_session_identifiers() {
        assert!(valid_identifier("session-test-1"));
        assert!(!valid_identifier("../session"));
        assert!(!valid_identifier(""));
    }

    #[test]
    fn validates_signal_roles_and_routes_messages_only_to_the_target() {
        assert!(valid_peer_id_for_role("publisher", "publisher-test"));
        assert!(!valid_peer_id_for_role("audience", "publisher-test"));
        assert!(valid_client_signal(
            "publisher",
            "offer",
            Some("audience-one")
        ));
        assert!(!valid_client_signal(
            "audience",
            "offer",
            Some("audience-two")
        ));
        assert!(!valid_client_signal("audience", "publisher-ready", None));
        assert!(valid_client_signal(
            "audience",
            "answer",
            Some("publisher-one")
        ));

        let offer = json!({ "type": "offer", "from": "publisher-one", "to": "audience-one" });
        assert!(signal_message_is_for_peer(
            &offer,
            "audience",
            "audience-one"
        ));
        assert!(!signal_message_is_for_peer(
            &offer,
            "audience",
            "audience-two"
        ));
        let join = json!({ "type": "join", "from": "audience-one", "to": "publisher" });
        assert!(signal_message_is_for_peer(
            &join,
            "publisher",
            "publisher-one"
        ));
        assert!(!signal_message_is_for_peer(
            &join,
            "audience",
            "audience-two"
        ));
    }

    #[test]
    fn audience_html_uses_a_nonce_and_escaped_format_braces() {
        let html = audience_html("session-test", "token123", "audience", "p2p");
        assert!(html.contains("nonce=\"token123\""));
        assert!(html.contains(
            "const sessionId='session-test';const token='token123';const role='audience'"
        ));
        assert!(html.contains("/events/${sessionId}/${token}/${peerId}"));
        assert!(html.contains("let source=null"));
        assert!(html.contains("viewer-pending"));
        assert!(html.contains("encodeURIComponent(displayName)"));
        assert!(html.contains("/signal/${sessionId}/${token}/${role}/${peerId}"));
        assert!(html.contains("${(state?.currentPageIndex??0)+1}"));
        assert!(html.contains("id=\"offline-frame\" title=\"离线备用画面\" sandbox=\"\""));
        assert!(html.contains("script-src 'none'; connect-src 'none'"));
        assert!(html.contains("const item=latest.page"));
        assert!(html.contains("state?.pageCount??0"));
        assert!(html.contains("renderMasks(Array.isArray(item?.privacyMasks)"));
        assert!(html.contains("id=\"annotations\""));
        assert!(html.contains("renderAnnotations(state)"));
        assert!(html.contains("id=\"frozen\""));
        assert!(html.contains("drawImage(stream"));
        assert!(html.contains("clearRect(0,0,frozen.width,frozen.height)"));
        assert!(html.contains("pc.getStats()"));
        assert!(html.contains("type:'quality'"));
        assert!(html.contains("type:'preference'"));
        assert!(html.contains("scheduleReconnect"));
        assert!(!html.contains("frame.src=item.url"));
    }

    #[test]
    fn audience_capacity_is_reserved_and_released() {
        let count = Arc::new(AtomicUsize::new(0));
        let guards: Vec<_> = (0..5)
            .map(|_| AudienceConnection::try_acquire(count.clone(), 5).unwrap())
            .collect();
        assert!(AudienceConnection::try_acquire(count.clone(), 5).is_none());
        drop(guards);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(AudienceConnection::try_acquire(count, 5).is_some());
    }

    #[test]
    fn starts_a_local_health_endpoint_and_creates_a_share() {
        let service = AudienceService::start(None).unwrap();
        let share = tauri::async_runtime::block_on(service.create_session(
            "session-test",
            json!({ "project": {}, "session": {} }),
            None,
        ))
        .unwrap();
        assert!(share.url.contains("/audience/session-test/"));
        assert!(share.local_url.starts_with("http://127.0.0.1:"));
        assert_ne!(share.local_url, share.url);
        assert!(share.signal_url.ends_with("/publisher"));
        let status =
            tauri::async_runtime::block_on(service.session_status("session-test")).unwrap();
        assert_eq!(status.audience_count, 0);
        assert_eq!(status.capacity, 5);

        let mut response = String::new();
        for _ in 0..20 {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", service.local_port))
            {
                use std::io::{Read, Write};
                stream
                    .write_all(
                        b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                    )
                    .unwrap();
                stream.read_to_string(&mut response).unwrap();
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(response.ends_with("ok"));
    }

    #[test]
    fn invalidates_audience_tokens_when_a_share_is_stopped_or_regenerated() {
        let service = AudienceService::start(None).unwrap();
        tauri::async_runtime::block_on(async {
            let first = service
                .create_session("session-token-reset", json!({ "project": {}, "session": {} }), None)
                .await
                .unwrap();
            let first_page = audience_page(
                State(service.clone()),
                Path(("session-token-reset".to_string(), first.token.clone())),
            )
            .await;
            assert_eq!(first_page.status(), StatusCode::OK);

            service.stop_session("session-token-reset").await;
            let stopped_page = audience_page(
                State(service.clone()),
                Path(("session-token-reset".to_string(), first.token.clone())),
            )
            .await;
            assert_eq!(stopped_page.status(), StatusCode::NOT_FOUND);

            let second = service
                .create_session("session-token-reset", json!({ "project": {}, "session": {} }), None)
                .await
                .unwrap();
            assert_ne!(first.token, second.token);
            let stale_page = audience_page(
                State(service.clone()),
                Path(("session-token-reset".to_string(), first.token)),
            )
            .await;
            assert_eq!(stale_page.status(), StatusCode::NOT_FOUND);
        });
    }

    #[test]
    fn starts_and_stops_the_local_sfu_capacity_mode() {
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("livekit-server-x86_64-unknown-linux-gnu");
        if !binary.is_file() {
            return;
        }
        let service = AudienceService::start(Some(binary)).unwrap();
        tauri::async_runtime::block_on(async {
            let share = service
                .create_session(
                    "session-sfu",
                    json!({
                        "project": { "audienceCapacityMode": "sfu-20" },
                        "session": {}
                    }),
                    Some("127.0.0.1"),
                )
                .await
                .unwrap();
            assert_eq!(share.delivery_mode, "sfu");
            assert!(share
                .sfu_url
                .as_deref()
                .is_some_and(|url| url.starts_with("ws://127.0.0.1:")));
            assert!(share
                .sfu_token
                .as_deref()
                .is_some_and(|token| token.split('.').count() == 3));
            let local_token = share.local_url.rsplit('/').next().unwrap().to_string();
            let token_response = sfu_token(
                State(service.clone()),
                Path((
                    "session-sfu".to_string(),
                    local_token.clone(),
                    "local-sfu-test".to_string(),
                )),
            )
            .await;
            assert_eq!(token_response.status(), StatusCode::OK);
            let page_response = audience_page(
                State(service.clone()),
                Path(("session-sfu".to_string(), local_token)),
            )
            .await;
            assert!(page_response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains(share.sfu_url.as_deref().unwrap())));
            assert_eq!(
                service
                    .session_status("session-sfu")
                    .await
                    .unwrap()
                    .capacity,
                20
            );
            service.stop_session("session-sfu").await;
            assert!(service.session_status("session-sfu").await.is_none());
        });
    }

    #[test]
    fn rejects_sfu_mode_when_the_sidecar_is_unavailable() {
        let service = AudienceService::start(None).unwrap();
        let error = tauri::async_runtime::block_on(service.create_session(
            "session-sfu-missing",
            json!({
                "project": { "audienceCapacityMode": "sfu-20" },
                "session": {}
            }),
            Some("127.0.0.1"),
        ))
        .unwrap_err();
        assert!(error.contains("SFU 组件不可用"));
    }

    #[test]
    fn local_viewer_uses_a_separate_token_without_consuming_capacity() {
        let service = AudienceService::start(None).unwrap();
        let share = tauri::async_runtime::block_on(service.create_session(
            "session-local",
            json!({ "project": {}, "session": {} }),
            None,
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let local_token = share.local_url.rsplit('/').next().unwrap();
        let url = format!(
            "ws://127.0.0.1:{}/signal/session-local/{local_token}/local/local-test",
            service.local_port
        );
        let (mut local_viewer, _) = tungstenite::connect(url.as_str()).unwrap();
        let approved = local_viewer.read().unwrap().into_text().unwrap();
        assert!(approved.contains("viewer-approved"));
        let status =
            tauri::async_runtime::block_on(service.session_status("session-local")).unwrap();
        assert_eq!(status.audience_count, 0);
        assert!(status.viewers.is_empty());
    }

    #[test]
    fn disconnects_all_pending_viewers() {
        let service = AudienceService::start(None).unwrap();
        let share = tauri::async_runtime::block_on(service.create_session(
            "session-disconnect-all",
            json!({
                "project": { "audienceJoinMode": "approval" },
                "session": {}
            }),
            None,
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let url = format!(
            "ws://127.0.0.1:{}/signal/session-disconnect-all/{}/audience/audience-one",
            service.local_port, share.token
        );
        let (mut viewer, _) = tungstenite::connect(url.as_str()).unwrap();
        assert!(viewer
            .read()
            .unwrap()
            .into_text()
            .unwrap()
            .contains("viewer-pending"));
        tauri::async_runtime::block_on(service.disconnect_all_viewers("session-disconnect-all"))
            .unwrap();
        assert!(viewer
            .read()
            .unwrap()
            .into_text()
            .unwrap()
            .contains("viewer-disconnected"));
        let status =
            tauri::async_runtime::block_on(service.session_status("session-disconnect-all"))
                .unwrap();
        assert!(status.viewers.is_empty());
    }

    #[test]
    fn approval_gates_snapshot_access_and_exposes_viewer_state() {
        let service = AudienceService::start(None).unwrap();
        tauri::async_runtime::block_on(async {
            let share = service
                .create_session(
                    "session-approval",
                    json!({
                        "project": { "audienceJoinMode": "approval" },
                        "session": {}
                    }),
                    None,
                )
                .await
                .unwrap();
            std::thread::sleep(Duration::from_millis(30));
            let url = format!(
                "ws://127.0.0.1:{}/signal/session-approval/{}/audience/audience-test?name=Regression",
                service.local_port, share.token
            );
            let (mut viewer, _) = tungstenite::connect(url.as_str()).unwrap();
            let pending = viewer.read().unwrap().into_text().unwrap();
            assert!(pending.contains("viewer-pending"));

            let status = service.session_status("session-approval").await.unwrap();
            assert_eq!(status.audience_count, 0);
            assert_eq!(status.viewers[0].status, "pending");
            assert_eq!(status.viewers[0].quality, "waiting");
            assert_eq!(status.viewers[0].display_name, "Regression");
            let denied = audience_events(
                State(service.clone()),
                Path((
                    "session-approval".to_string(),
                    share.token.clone(),
                    "audience-test".to_string(),
                )),
            )
            .await;
            assert_eq!(denied.status(), StatusCode::FORBIDDEN);

            service
                .decide_viewer("session-approval", "audience-test", true)
                .await
                .unwrap();
            let approved = viewer.read().unwrap().into_text().unwrap();
            assert!(approved.contains("viewer-approved"));
            let allowed = audience_events(
                State(service.clone()),
                Path((
                    "session-approval".to_string(),
                    share.token.clone(),
                    "audience-test".to_string(),
                )),
            )
            .await;
            assert_eq!(allowed.status(), StatusCode::OK);
            service
                .disconnect_viewer("session-approval", "audience-test")
                .await
                .unwrap();
        });
    }

    #[test]
    fn relays_signaling_messages_from_publisher_to_audience() {
        let service = AudienceService::start(None).unwrap();
        let share = tauri::async_runtime::block_on(service.create_session(
            "session-signal",
            json!({ "project": {}, "session": {} }),
            None,
        ))
        .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let (mut publisher, _) =
            tungstenite::connect(format!("{}/publisher-test", share.signal_url).as_str()).unwrap();
        let audience_url = format!(
            "ws://127.0.0.1:{}/signal/session-signal/{}/audience/audience-test",
            service.local_port, share.token
        );
        let (mut audience, _) = tungstenite::connect(audience_url.as_str()).unwrap();

        let join = publisher.read().unwrap().into_text().unwrap();
        assert!(join.contains("\"type\":\"join\""));
        publisher.send(tungstenite::Message::Text(json!({ "type": "offer", "to": "audience-test", "description": { "type": "offer" } }).to_string().into())).unwrap();
        let mut offer = String::new();
        for _ in 0..4 {
            let message = audience.read().unwrap().into_text().unwrap();
            if message.contains("\"type\":\"offer\"") {
                offer = message.to_string();
                break;
            }
        }
        assert!(offer.contains("\"type\":\"offer\""));
        audience
            .send(tungstenite::Message::Text(
                json!({ "type": "quality", "quality": "good" })
                    .to_string()
                    .into(),
            ))
            .unwrap();
        let mut quality = String::new();
        for _ in 0..20 {
            let status =
                tauri::async_runtime::block_on(service.session_status("session-signal")).unwrap();
            quality = status.viewers[0].quality.clone();
            if quality == "good" {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(quality, "good");
    }
}
