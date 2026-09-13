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
    net::{Ipv4Addr, TcpListener},
    sync::Arc,
};
use tokio::sync::RwLock;

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct ReadonlyProxyService {
    port: u16,
    client: reqwest::Client,
    config: Arc<RwLock<Option<ProxyConfig>>>,
}

#[derive(Clone)]
struct ProxyConfig {
    project_id: String,
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
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let service = Self {
            port,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .user_agent("Showit/0.1 readonly-proxy")
                .build()
                .map_err(|error| error.to_string())?,
            config: Arc::new(RwLock::new(None)),
        };
        let router = Router::new()
            .fallback(proxy_request)
            .with_state(service.clone());
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                return;
            };
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("只读代理异常退出: {error}");
            }
        });
        Ok(service)
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
        *self.config.write().await = Some(ProxyConfig {
            project_id,
            target_origin,
            allowed_write_paths,
            request_headers: safe_headers,
        });
        Ok(ReadonlyProxyTarget {
            url: self.proxy_url(&page),
        })
    }

    pub async fn clear(&self, project_id: &str) {
        let mut config = self.config.write().await;
        if config
            .as_ref()
            .is_some_and(|current| current.project_id == project_id)
        {
            *config = None;
        }
    }

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
    let rewritten = value
        .split(';')
        .filter(|part| {
            !part
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("domain=")
        })
        .collect::<Vec<_>>()
        .join(";");
    HeaderValue::from_str(&rewritten).ok()
}

fn rewrite_origin(value: &HeaderValue, target_origin: &str, proxy_origin: &str) -> HeaderValue {
    value
        .to_str()
        .ok()
        .and_then(|value| HeaderValue::from_str(&value.replace(target_origin, proxy_origin)).ok())
        .unwrap_or_else(|| value.clone())
}

async fn proxy_request(State(service): State<ReadonlyProxyService>, request: Request) -> Response {
    let Some(config) = service.config.read().await.clone() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "SHOWIT_PROXY_NOT_CONFIGURED",
        );
    };
    let (parts, body) = request.into_parts();
    if !write_allowed(&parts.method, parts.uri.path(), &config.allowed_write_paths) {
        return error_response(StatusCode::FORBIDDEN, "SHOWIT_PRESENTATION_READ_ONLY");
    }
    let body = match to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(
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
        let proxy_origin = format!("http://127.0.0.1:{}", service.port);
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
    let upstream = service
        .client
        .request(parts.method.clone(), &target)
        .headers(request_headers)
        .body(body);
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return error_response(StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_UPSTREAM_UNAVAILABLE")
        }
    };
    if upstream
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return error_response(StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_RESPONSE_TOO_LARGE");
    }
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut bytes = match upstream.bytes().await {
        Ok(bytes) if bytes.len() as u64 <= MAX_RESPONSE_BYTES => bytes.to_vec(),
        _ => return error_response(StatusCode::BAD_GATEWAY, "SHOWIT_PROXY_RESPONSE_INVALID"),
    };
    let proxy_origin = format!("http://127.0.0.1:{}", service.port);
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
        if name == header::SET_COOKIE {
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
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

#[cfg(test)]
mod tests {
    use super::{allowed_url, safe_path, write_allowed, ConnectorHeader, ReadonlyProxyService};
    use axum::http::{Method, StatusCode};
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener},
        sync::mpsc,
        thread,
        time::Duration,
    };

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
                proxy_origin.as_str()
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
