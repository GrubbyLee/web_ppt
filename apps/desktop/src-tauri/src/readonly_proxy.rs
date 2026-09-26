use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, TcpListener},
    sync::Arc,
};
use tokio::sync::{watch, Mutex, RwLock};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

// Each (project, business origin) pair gets its own loopback listener, so every
// business origin keeps a stable and isolated browser cookie jar: alternating
// demo pages between two connectors never destroys the session of the other,
// and cookies issued for one demo target can never be replayed to another
// target that happens to share the proxy origin.
#[derive(Clone)]
pub struct ReadonlyProxyService {
    client: reqwest::Client,
    instances: Arc<Mutex<HashMap<(String, String), ProxyInstance>>>,
}

struct ProxyInstance {
    port: u16,
    target_origin: String,
    config: Arc<RwLock<Option<ProxyConfig>>>,
    shutdown: watch::Sender<bool>,
}

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
    port: u16,
    config: Arc<RwLock<Option<ProxyConfig>>>,
}

#[derive(Clone)]
struct ProxyConfig {
    target_origin: String,
    allowed_write_paths: Vec<String>,
    request_headers: HeaderMap,
}

#[derive(Deserialize)]
pub struct ConnectorHeader {
    pub name: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadonlyProxyTarget {
    pub url: String,
}

impl ReadonlyProxyService {
    pub fn start() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("Showit/0.1 readonly-proxy")
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            instances: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn configure(
        &self,
        project_id: String,
        origin: String,
        page_url: String,
        allowed_write_paths: Vec<String>,
        request_headers: Vec<ConnectorHeader>,
    ) -> Result<ReadonlyProxyTarget, String> {
        let origin_url = allowed_url(&origin).ok_or_else(|| "只读代理 Origin 无效".to_string())?;
        let page = allowed_url(&page_url).ok_or_else(|| "只读代理页面 URL 无效".to_string())?;
        let target_origin = origin_url.origin().ascii_serialization();
        if page.origin().ascii_serialization() != target_origin {
            return Err("页面 URL 不属于只读代理 Origin".to_string());
        }
        let allowed_write_paths = allowed_write_paths
            .into_iter()
            .filter(|path| safe_path(path))
            .take(40)
            .collect();
        let mut safe_headers = HeaderMap::new();
        for item in request_headers.into_iter().take(20) {
            let Ok(name) = header::HeaderName::from_bytes(item.name.as_bytes()) else {
                continue;
            };
            let lower = name.as_str().to_ascii_lowercase();
            if [
                "authorization",
                "cookie",
                "token",
                "secret",
                "credential",
                "api-key",
                "api_key",
            ]
            .iter()
            .any(|blocked| lower.contains(blocked))
                || !safe_config_header(&name)
            {
                continue;
            }
            let Ok(value) = HeaderValue::from_str(&item.value) else {
                continue;
            };
            safe_headers.insert(name, value);
        }
        let config = ProxyConfig {
            target_origin: target_origin.clone(),
            allowed_write_paths,
            request_headers: safe_headers,
        };
        let mut instances = self.instances.lock().await;
        let key = (project_id, target_origin);
        if let Some(instance) = instances.get(&key) {
            *instance.config.write().await = Some(config);
            return Ok(ReadonlyProxyTarget {
                url: instance.proxy_url(&page),
            });
        }
        let instance = spawn_proxy_instance(self.client.clone(), config)?;
        let url = instance.proxy_url(&page);
        instances.insert(key, instance);
        Ok(ReadonlyProxyTarget { url })
    }

    pub async fn clear(&self, project_id: &str) {
        let mut instances = self.instances.lock().await;
        let stale: Vec<(String, String)> = instances
            .keys()
            .filter(|(project, _origin)| project == project_id)
            .cloned()
            .collect();
        for key in stale {
            if let Some(instance) = instances.remove(&key) {
                let _ = instance.shutdown.send(true);
            }
        }
    }
}

impl ProxyInstance {
    fn proxy_url(&self, target: &Url) -> String {
        let mut value = format!("http://127.0.0.1:{}{}", self.port, target.path());
        if let Some(query) = target.query() {
            value.push('?');
            value.push_str(query);
        }
        if let Some(fragment) = target.fragment() {
            value.push('#');
            value.push_str(fragment);
        }
        value
    }
}

fn spawn_proxy_instance(
    client: reqwest::Client,
    config: ProxyConfig,
) -> Result<ProxyInstance, String> {
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let target_origin = config.target_origin.clone();
    let config = Arc::new(RwLock::new(Some(config)));
    let (shutdown, mut shutdown_signal) = watch::channel(false);
    let state = ProxyState {
        client,
        port,
        config: config.clone(),
    };
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let server = axum::serve(
            listener,
            Router::new().fallback(proxy_request).with_state(state),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_signal.wait_for(|stop| *stop).await;
        });
        if let Err(error) = server.await {
            eprintln!("只读代理异常退出: {error}");
        }
    });
    Ok(ProxyInstance {
        port,
        target_origin,
        config,
        shutdown,
    })
}

fn allowed_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query_pairs().any(|(key, _)| sensitive_url_key(&key))
    {
        return None;
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    (url.scheme() == "https" || (url.scheme() == "http" && local)).then_some(url)
}

fn sensitive_url_key(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "password",
        "passwd",
        "secret",
        "token",
        "cookie",
        "authorization",
        "credential",
        "apikey",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn safe_path(path: &str) -> bool {
    canonical_path(path).is_some()
}

fn canonical_path(path: &str) -> Option<String> {
    let mut decoded = path.to_string();
    for _ in 0..4 {
        let bytes = decoded.as_bytes();
        let mut next = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] != b'%' {
                next.push(bytes[index]);
                index += 1;
                continue;
            }
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            next.push(((high << 4) | low) as u8);
            index += 3;
        }
        let next = String::from_utf8(next).ok()?;
        if next == decoded {
            break;
        }
        decoded = next;
    }
    if decoded.contains('%')
        || !decoded.starts_with('/')
        || decoded.starts_with("//")
        || decoded.contains(['?', '#', '\\'])
        || decoded
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }
    Some(decoded)
}

fn write_allowed(method: &Method, path: &str, allowed_paths: &[String]) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    if !matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return false;
    }
    let Some(path) = canonical_path(path) else {
        return false;
    };
    allowed_paths
        .iter()
        .filter_map(|allowed| canonical_path(allowed))
        .any(|allowed| {
            path == allowed
                || path
                    .strip_prefix(&allowed)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
}

fn error_response(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        format!(r#"{{"error":"{code}"}}"#),
    )
        .into_response()
}

/// Main-frame navigations would otherwise render raw JSON; give the presenter
/// a readable page while subresources keep the machine-readable code.
fn error_document(status: StatusCode, code: &'static str) -> Response {
    let (title, description) = match code {
        "SHOWIT_PRESENTATION_READ_ONLY" => (
            "写入请求已被演示保护拦截",
            "演示期间业务页面保持只读。如需登录或切换角色，请使用项目中配置的放行路径。",
        ),
        "SHOWIT_PROXY_NOT_CONFIGURED" => (
            "只读代理尚未配置",
            "请退出演示后重新进入，让 Showit 重新建立本机只读代理。",
        ),
        "SHOWIT_PROXY_HOST_REJECTED" => (
            "请求主机不受信任",
            "该请求的 Host 不是本机只读代理地址，已被拒绝。",
        ),
        "SHOWIT_PROXY_REDIRECT_BLOCKED" => (
            "跳转已被拦截",
            "业务系统尝试跳转到其他域名；为保持只读保护，此类跳转被阻止。",
        ),
        _ => ("业务画面暂时不可用", "请检查业务系统状态后重试。"),
    };
    let page = format!(
        concat!(
            r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">"#,
            r#"<meta name="viewport" content="width=device-width,initial-scale=1">"#,
            r#"<title>Showit 演示保护</title><style>"#,
            r#"body{{margin:0;min-height:100vh;display:grid;place-items:center;"#,
            r#"font:15px/1.7 system-ui,-apple-system,sans-serif;background:#172533;color:#e8eef4}}"#,
            r#"main{{max-width:520px;margin:24px;padding:28px 32px;background:#1f2f40;"#,
            r#"border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.35)}}"#,
            r#"h1{{font-size:18px;margin:0 0 10px}}p{{margin:0 0 12px;color:#c4d2e0}}"#,
            r#"code{{font:13px/1.5 ui-monospace,monospace;color:#9fb6cc}}"#,
            r#"</style></head><body><main><h1>{title}</h1>"#,
            r#"<p>{description}</p><p>错误码：<code>{code}</code></p></main></body></html>"#
        ),
        title = title,
        description = description,
        code = code
    );
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        page,
    )
        .into_response()
}

fn request_error(parts: &axum::http::request::Parts, status: StatusCode, code: &'static str) -> Response {
    let document = parts
        .headers
        .get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok())
        == Some("document");
    if document {
        error_document(status, code)
    } else {
        error_response(status, code)
    }
}

fn should_forward_header(name: &header::HeaderName) -> bool {
    let value = name.as_str();
    !matches!(
        value,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "content-encoding"
            | "keep-alive"
            | "upgrade"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "te"
            | "trailer"
            | "forwarded"
            | "via"
            | "x-real-ip"
    ) && !value.starts_with("x-forwarded-")
}

fn safe_config_header(name: &header::HeaderName) -> bool {
    should_forward_header(name)
        && !matches!(
            name.as_str(),
            "origin" | "referer" | "accept-encoding" | "forwarded"
        )
        && !name.as_str().starts_with("x-forwarded-")
        && !name.as_str().starts_with("sec-")
}

fn rewrite_set_cookie(value: &HeaderValue) -> Option<HeaderValue> {
    let value = value.to_str().ok()?;
    // The presenter app and this loopback proxy are different sites, so the
    // business iframe and credentialed probes only receive cookies marked
    // SameSite=None; browsers require Secure alongside it, which loopback
    // origins are allowed to set. Strip any conflicting attributes first so
    // the cookie carries exactly one SameSite/Secure pair.
    let rewritten = value
        .split(';')
        .filter(|part| {
            let part = part.trim_start();
            let lower = part.to_ascii_lowercase();
            !(lower.starts_with("domain=")
                || lower.starts_with("samesite=")
                || lower == "secure")
        })
        .collect::<Vec<_>>()
        .join(";");
    HeaderValue::from_str(&format!("{rewritten}; SameSite=None; Secure")).ok()
}

fn rewrite_origin(value: &HeaderValue, target_origin: &str, proxy_origin: &str) -> HeaderValue {
    value
        .to_str()
        .ok()
        .and_then(|value| HeaderValue::from_str(&value.replace(target_origin, proxy_origin)).ok())
        .unwrap_or_else(|| value.clone())
}

fn rewrite_content_security_policy(
    value: &HeaderValue,
    target_origin: &str,
    proxy_origin: &str,
) -> Option<HeaderValue> {
    let value = value.to_str().ok()?;
    let rewritten = value
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            !directive
                .split_ascii_whitespace()
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
        })
        .collect::<Vec<_>>()
        .join("; ")
        .replace(target_origin, proxy_origin);
    HeaderValue::from_str(&rewritten).ok()
}

fn showit_client_origin(value: &HeaderValue) -> Option<HeaderValue> {
    matches!(
        value.to_str().ok()?,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:4173"
            | "http://127.0.0.1:4173"
    )
    .then(|| value.clone())
}

async fn proxy_request(State(state): State<ProxyState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let Some(config) = state.config.read().await.clone() else {
        return request_error(
            &parts,
            StatusCode::SERVICE_UNAVAILABLE,
            "SHOWIT_PROXY_NOT_CONFIGURED",
        );
    };
    // Defeat DNS rebinding: a public domain resolved to this loopback port
    // would otherwise ride the proxy into the business origin with the
    // presenter's session. Only the exact loopback Host the iframe uses is
    // accepted.
    let expected_host = format!("127.0.0.1:{}", state.port);
    let host_valid = parts
        .headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(&expected_host));
    if !host_valid {
        return request_error(&parts, StatusCode::FORBIDDEN, "SHOWIT_PROXY_HOST_REJECTED");
    }
    let client_origin = parts
        .headers
        .get(header::ORIGIN)
        .and_then(showit_client_origin);
    if !write_allowed(&parts.method, parts.uri.path(), &config.allowed_write_paths) {
        return request_error(&parts, StatusCode::FORBIDDEN, "SHOWIT_PRESENTATION_READ_ONLY");
    }
    let body = match to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return request_error(
                &parts,
                StatusCode::PAYLOAD_TOO_LARGE,
                "SHOWIT_PROXY_REQUEST_TOO_LARGE",
            )
        }
    };
    let target = format!(
        "{}{}{}",
        config.target_origin,
        parts.uri.path(),
        parts
            .uri
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    let mut request_headers = HeaderMap::new();
    for (name, value) in &parts.headers {
        if should_forward_header(name) {
            request_headers.append(name, value.clone());
        }
    }
    if parts.headers.contains_key(header::ORIGIN) {
        if let Ok(value) = HeaderValue::from_str(&config.target_origin) {
            request_headers.insert(header::ORIGIN, value);
        }
    }
    if let Some(referer) = parts
        .headers
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok())
    {
        let proxy_origin = format!("http://127.0.0.1:{}", state.port);
        if let Ok(value) =
            HeaderValue::from_str(&referer.replace(&proxy_origin, &config.target_origin))
        {
            request_headers.insert(header::REFERER, value);
        }
    }
    for (name, value) in &config.request_headers {
        request_headers.insert(name, value.clone());
    }
    request_headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let upstream = state
        .client
        .request(parts.method.clone(), &target)
        .headers(request_headers)
        .body(body);
    let mut upstream = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return request_error(&parts, StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_UPSTREAM_UNAVAILABLE")
        }
    };
    if upstream
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return request_error(&parts, StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_RESPONSE_TOO_LARGE");
    }
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    // A redirect that leaves the business origin would carry the iframe out of
    // the proxy, silently dropping write protection. Same-origin (including
    // relative and protocol-relative blocked below) targets stay allowed.
    if status.is_redirection() {
        if let Some(location) = upstream_headers
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
        {
            if location.starts_with("//")
                || Url::parse(location)
                    .ok()
                    .is_some_and(|url| url.origin().ascii_serialization() != config.target_origin)
            {
                return request_error(&parts, StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_REDIRECT_BLOCKED");
            }
        }
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = match upstream.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => return request_error(&parts, StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_RESPONSE_INVALID"),
        };
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES as usize {
            return request_error(&parts, StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_RESPONSE_TOO_LARGE");
        }
        bytes.extend_from_slice(&chunk);
    }
    let proxy_origin = format!("http://127.0.0.1:{}", state.port);
    let textual = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.starts_with("text/") || value.contains("javascript") || value.contains("json")
        });
    if textual {
        if let Ok(text) = String::from_utf8(bytes.clone()) {
            bytes = text
                .replace(&config.target_origin, &proxy_origin)
                .into_bytes();
        }
    }
    let mut response_headers = HeaderMap::new();
    for (name, value) in &upstream_headers {
        if !should_forward_header(name) {
            continue;
        }
        if name == header::X_FRAME_OPTIONS {
            continue;
        }
        if name == header::CONTENT_SECURITY_POLICY {
            if let Some(policy) =
                rewrite_content_security_policy(value, &config.target_origin, &proxy_origin)
            {
                response_headers.append(name, policy);
            }
        } else if name == header::SET_COOKIE {
            if let Some(cookie) = rewrite_set_cookie(value) {
                response_headers.append(name, cookie);
            }
        } else {
            response_headers.append(
                name,
                rewrite_origin(value, &config.target_origin, &proxy_origin),
            );
        }
    }
    // The presenter checks session state from its own Tauri/Vite origin while the
    // business iframe is served from this loopback origin. Only reflect known
    // Showit origins, and require explicit credential support for that probe.
    if let Some(origin) = client_origin {
        response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response_headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        response_headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_url, rewrite_content_security_policy, rewrite_set_cookie, safe_path,
        showit_client_origin, write_allowed, ConnectorHeader, ReadonlyProxyService,
    };
    use axum::http::{HeaderValue, Method, StatusCode};
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        sync::mpsc,
        thread,
        time::Duration,
    };

    #[test]
    fn allows_only_known_showit_origins() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ] {
            assert_eq!(
                showit_client_origin(&HeaderValue::from_static(origin)).unwrap(),
                origin
            );
        }
        for origin in [
            "https://tauri.localhost.evil.example",
            "http://localhost:4174",
            "https://attacker.example",
            "null",
        ] {
            assert!(showit_client_origin(&HeaderValue::from_static(origin)).is_none());
        }
    }

    #[test]
    fn forces_cross_site_cookies_to_samesite_none_and_secure() {
        let value = HeaderValue::from_static(
            "session=abc; Path=/; Domain=business.example; Secure; HttpOnly; SameSite=Lax",
        );
        assert_eq!(
            rewrite_set_cookie(&value).unwrap(),
            "session=abc; Path=/; HttpOnly; SameSite=None; Secure"
        );
        let bare = HeaderValue::from_static("token=t");
        assert_eq!(
            rewrite_set_cookie(&bare).unwrap(),
            "token=t; SameSite=None; Secure"
        );
    }

    #[test]
    fn removes_upstream_frame_ancestors_while_preserving_other_csp_directives() {
        let value = HeaderValue::from_static(
            "default-src 'self'; frame-ancestors 'self' https://host.example; connect-src https://host.example",
        );
        assert_eq!(
            rewrite_content_security_policy(
                &value,
                "https://host.example",
                "http://127.0.0.1:4567"
            )
            .unwrap(),
            "default-src 'self'; connect-src http://127.0.0.1:4567"
        );
    }

    #[test]
    fn blocks_writes_except_explicit_auth_paths() {
        let allowed = vec!["/login".to_string(), "/logout".to_string()];
        assert!(write_allowed(&Method::GET, "/orders", &allowed));
        assert!(!write_allowed(&Method::POST, "/orders", &allowed));
        assert!(write_allowed(&Method::POST, "/login", &allowed));
        assert!(write_allowed(&Method::POST, "/login/mfa", &allowed));
        assert!(!write_allowed(&Method::POST, "/login-attack", &allowed));
        assert!(!write_allowed(
            &Method::POST,
            "/login/%2e%2e/orders",
            &allowed
        ));
        assert!(!write_allowed(
            &Method::POST,
            "/login/%252e%252e/orders",
            &allowed
        ));
        assert!(!write_allowed(
            &Method::POST,
            "/login%2f..%2forders",
            &allowed
        ));
    }

    #[test]
    fn rejects_ambiguous_write_allowlist_paths() {
        assert!(safe_path("/sso/callback"));
        assert!(!safe_path("//example.com"));
        assert!(!safe_path("/login?next=/"));
        assert!(!safe_path("/../admin"));
        assert!(!safe_path("/login/%2e%2e/admin"));
        assert!(!safe_path("/login/%252e%252e/admin"));
        assert!(!safe_path("/login%2f..%2fadmin"));
    }

    #[test]
    fn rejects_urls_with_embedded_or_query_credentials() {
        assert!(allowed_url("https://example.com/orders").is_some());
        assert!(allowed_url("https://demo:password@example.com/orders").is_none());
        assert!(allowed_url("https://example.com/orders?api_key=private").is_none());
    }

    #[test]
    fn keeps_separate_proxy_instances_per_business_origin() {
        tauri::async_runtime::block_on(async {
            let proxy = ReadonlyProxyService::start().unwrap();
            let first = proxy
                .configure(
                    "project-multi".to_string(),
                    "https://one.example.com".to_string(),
                    "https://one.example.com/app".to_string(),
                    vec![],
                    vec![],
                )
                .await
                .unwrap();
            let second = proxy
                .configure(
                    "project-multi".to_string(),
                    "https://two.example.com".to_string(),
                    "https://two.example.com/app".to_string(),
                    vec![],
                    vec![],
                )
                .await
                .unwrap();
            // Alternating pages between two connectors must not evict the
            // other origin's listener (and with it its cookie jar).
            let first_again = proxy
                .configure(
                    "project-multi".to_string(),
                    "https://one.example.com".to_string(),
                    "https://one.example.com/other".to_string(),
                    vec![],
                    vec![],
                )
                .await
                .unwrap();
            let port = |url: &str| url.rsplit_once(':').map(|(_, rest)| rest.split('/').next().unwrap_or("").to_string()).unwrap_or_default();
            assert_ne!(port(&first.url), port(&second.url));
            assert_eq!(port(&first.url), port(&first_again.url));
            assert_eq!(proxy.instances.lock().await.len(), 2);
            proxy.clear("project-multi").await;
            assert!(proxy.instances.lock().await.is_empty());
        });
    }

    #[test]
    fn rejects_requests_with_a_rebound_public_host() {
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        upstream.set_nonblocking(false).unwrap();
        let upstream_origin = format!("http://{}", upstream.local_addr().unwrap());

        tauri::async_runtime::block_on(async {
            let proxy = ReadonlyProxyService::start().unwrap();
            let target = proxy
                .configure(
                    "project-rebind".to_string(),
                    upstream_origin.clone(),
                    format!("{upstream_origin}/orders"),
                    vec![],
                    vec![],
                )
                .await
                .unwrap();
            let port = reqwest::Url::parse(&target.url)
                .unwrap()
                .port()
                .unwrap();
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let request = format!(
                "GET /orders HTTP/1.1\r\nHost: attacker.example:{port}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 403"), "{response}");
            assert!(response.contains("SHOWIT_PROXY_HOST_REJECTED"));
        });
    }

    #[test]
    fn proxies_reads_with_safe_headers_and_blocks_writes_before_upstream() {
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        upstream.set_nonblocking(false).unwrap();
        let upstream_origin = format!("http://{}", upstream.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        let response_origin = upstream_origin.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&buffer[..size]).to_string())
                .unwrap();
            let body = format!("link={response_origin}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {response_origin}\r\nContent-Security-Policy: connect-src {response_origin}\r\nLocation: {response_origin}/next\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        tauri::async_runtime::block_on(async {
            let proxy = ReadonlyProxyService::start().unwrap();
            let target = proxy
                .configure(
                    "project-test".to_string(),
                    upstream_origin.clone(),
                    format!("{upstream_origin}/orders"),
                    vec!["/login".to_string()],
                    vec![
                        ConnectorHeader {
                            name: "X-Demo-Tenant".to_string(),
                            value: "customer-a".to_string(),
                        },
                        ConnectorHeader {
                            name: "Origin".to_string(),
                            value: "https://attacker.example".to_string(),
                        },
                        ConnectorHeader {
                            name: "X-Forwarded-Host".to_string(),
                            value: "attacker.example".to_string(),
                        },
                    ],
                )
                .await
                .unwrap();
            let client = reqwest::Client::new();
            let response = client
                .get(&target.url)
                .header("Origin", "tauri://localhost")
                .header("Forwarded", "host=client-spoof.example")
                .header("X-Forwarded-Host", "client-spoof.example")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let proxy_origin = reqwest::Url::parse(&target.url)
                .unwrap()
                .origin()
                .ascii_serialization();
            assert_eq!(
                response
                    .headers()
                    .get("access-control-allow-origin")
                    .unwrap(),
                "tauri://localhost"
            );
            assert_eq!(
                response
                    .headers()
                    .get("access-control-allow-credentials")
                    .unwrap(),
                "true"
            );
            assert_eq!(
                response.headers().get("content-security-policy").unwrap(),
                format!("connect-src {proxy_origin}").as_str()
            );
            assert_eq!(
                response.headers().get("location").unwrap(),
                format!("{proxy_origin}/next").as_str()
            );
            assert_eq!(
                response.text().await.unwrap(),
                format!("link={proxy_origin}")
            );
            let blocked = client.post(&target.url).body("write").send().await.unwrap();
            assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
            assert!(blocked
                .text()
                .await
                .unwrap()
                .contains("SHOWIT_PRESENTATION_READ_ONLY"));
            let blocked_document = client
                .post(&target.url)
                .header("Sec-Fetch-Dest", "document")
                .body("write")
                .send()
                .await
                .unwrap();
            assert_eq!(blocked_document.status(), StatusCode::FORBIDDEN);
            assert_eq!(
                blocked_document.headers().get("content-type").unwrap(),
                "text/html; charset=utf-8"
            );
            assert!(blocked_document
                .text()
                .await
                .unwrap()
                .contains("写入请求已被演示保护拦截"));
        });
        let request = request_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .to_ascii_lowercase();
        assert!(request.starts_with("get /orders "));
        assert!(request.contains("x-demo-tenant: customer-a"));
        assert!(!request.contains("attacker.example"));
        assert!(!request.contains("client-spoof.example"));
        server.join().unwrap();
    }
}
