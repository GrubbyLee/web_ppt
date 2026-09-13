use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    project: Value,
    session: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UrlHealth {
    ok: bool,
    status: Option<u16>,
    elapsed_ms: u64,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserProfileStatus {
    exists: bool,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DistributionInfo {
    kind: String,
    can_install_update: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnosticEntry {
    trace_id: String,
    at: i64,
    area: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MonitorFingerprint {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn monitor_fingerprint(monitor: &tauri::Monitor) -> MonitorFingerprint {
    MonitorFingerprint {
        name: monitor.name().cloned(),
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

fn secondary_monitor_index(
    monitors: &[MonitorFingerprint],
    presenter: Option<&MonitorFingerprint>,
) -> Option<usize> {
    if monitors.len() < 2 {
        return None;
    }
    presenter
        .and_then(|current| monitors.iter().position(|monitor| monitor != current))
        .or(Some(1))
}

fn is_allowed_business_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query_pairs().any(|(key, _)| is_sensitive_url_key(&key))
    {
        return false;
    }
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn is_sensitive_url_key(value: &str) -> bool {
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

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "外部链接无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("外部链接必须使用 HTTPS".to_string());
    }
    #[cfg(target_os = "linux")]
    Command::new("xdg-open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开外部链接: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer.exe")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|error| format!("无法打开外部链接: {error}"))?;
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return Err("当前平台不支持打开外部链接".to_string());
    Ok(())
}

fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn resolve_portable_data_path(
    executable: &Path,
    explicit: Option<&Path>,
    marker_exists: bool,
) -> Option<PathBuf> {
    if let Some(path) = explicit.filter(|path| path.is_absolute()) {
        return Some(path.to_path_buf());
    }
    marker_exists.then(|| executable.parent().unwrap_or(Path::new(".")).join("data"))
}

fn application_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let marker = executable
        .parent()
        .unwrap_or(Path::new("."))
        .join("portable-data.enabled");
    let explicit = std::env::var_os("SHOWIT_PORTABLE_DATA_DIR").map(PathBuf::from);
    let directory = resolve_portable_data_path(&executable, explicit.as_deref(), marker.is_file())
        .unwrap_or(
            app.path()
                .app_data_dir()
                .map_err(|error| error.to_string())?,
        );
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    Ok(directory)
}

fn livekit_sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    let executable_name = if cfg!(target_os = "windows") {
        "livekit-server.exe"
    } else {
        "livekit-server"
    };
    let target_name = if cfg!(target_os = "windows") {
        "livekit-server-x86_64-pc-windows-msvc.exe"
    } else {
        "livekit-server-x86_64-unknown-linux-gnu"
    };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("SHOWIT_LIVEKIT_BIN")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        candidates.push(path);
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(target_name),
    );
    if let Ok(current) = std::env::current_exe() {
        candidates.push(
            current
                .parent()
                .unwrap_or(Path::new("."))
                .join(executable_name),
        );
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("binaries").join(target_name));
        candidates.push(resources.join(executable_name));
        candidates.push(resources.join(target_name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[tauri::command]
fn distribution_info() -> DistributionInfo {
    let executable = std::env::current_exe().ok();
    let portable = executable.as_deref().is_some_and(|path| {
        path.parent()
            .unwrap_or(Path::new("."))
            .join("showit-portable.enabled")
            .is_file()
    });
    if portable {
        return DistributionInfo {
            kind: "portable".to_string(),
            can_install_update: false,
        };
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        return DistributionInfo {
            kind: "appimage".to_string(),
            can_install_update: true,
        };
    }
    #[cfg(target_os = "linux")]
    return DistributionInfo {
        kind: "linux-package".to_string(),
        can_install_update: false,
    };
    #[cfg(target_os = "windows")]
    return DistributionInfo {
        kind: "installer".to_string(),
        can_install_update: true,
    };
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    DistributionInfo {
        kind: "unsupported".to_string(),
        can_install_update: false,
    }
}

fn redact_native_diagnostic(value: &str) -> String {
    static SENSITIVE_ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static SENSITIVE_QUERY: OnceLock<Regex> = OnceLock::new();
    static SENSITIVE_HEADER: OnceLock<Regex> = OnceLock::new();
    static CREDENTIAL_TOKEN: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    let assignment = SENSITIVE_ASSIGNMENT.get_or_init(|| {
        Regex::new(r#"(?i)\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_ ]?secret|(?:access|id|refresh)?[-_ ]?token|api[-_ ]?key)\b["']?(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;}&]+)"#)
            .expect("valid sensitive assignment expression")
    });
    let query = SENSITIVE_QUERY.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_ ]?secret|(?:access|id|refresh)?[-_ ]?token|api[-_ ]?key)=)[^&#\s]+")
            .expect("valid sensitive query expression")
    });
    let header = SENSITIVE_HEADER.get_or_init(|| {
        Regex::new(r"(?i)\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_ ]?secret|(?:access|id|refresh)?[-_ ]?token|api[-_ ]?key)\b\s*:\s*[^\r\n]+")
            .expect("valid sensitive header expression")
    });
    let credential = CREDENTIAL_TOKEN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*").expect("valid credential expression")
    });
    let url =
        URL.get_or_init(|| Regex::new(r#"https?://[^\s"')]+"#).expect("valid URL expression"));
    let redacted = header.replace_all(value, "$1: [REDACTED]");
    let redacted = credential.replace_all(&redacted, "[REDACTED_CREDENTIAL]");
    let redacted = query.replace_all(&redacted, "$1[REDACTED]");
    let redacted = assignment.replace_all(&redacted, "$1$2[REDACTED]");
    url.replace_all(&redacted, "[REDACTED_URL]")
    .chars()
    .filter(|character| !character.is_control())
    .take(1_000)
    .collect()
}

fn sanitize_native_diagnostic(
    entry: NativeDiagnosticEntry,
) -> Result<NativeDiagnosticEntry, String> {
    let trace_id = entry.trace_id.trim();
    let area = entry.area.trim();
    if trace_id.is_empty() || trace_id.len() > 120 || area.is_empty() || area.len() > 80 {
        return Err("诊断记录字段无效".to_string());
    }
    let now = unix_millis()? as i64;
    if entry.at <= 0 || entry.at > now.saturating_add(60_000) {
        return Err("诊断记录时间无效".to_string());
    }
    let message = redact_native_diagnostic(&entry.message);
    if message.is_empty() {
        return Err("诊断记录内容无效".to_string());
    }
    Ok(NativeDiagnosticEntry {
        trace_id: trace_id.to_string(),
        at: entry.at,
        area: area.to_string(),
        message,
    })
}

fn dedicated_profile_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    if !is_safe_identifier(project_id) {
        return Err("项目 ID 无效".to_string());
    }
    Ok(application_data_dir(app)?
        .join("browser-profiles")
        .join(project_id))
}

fn directory_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(file_type) = entry.file_type() else {
                return 0;
            };
            if file_type.is_symlink() {
                return 0;
            }
            if file_type.is_dir() {
                directory_size(&entry.path())
            } else {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            }
        })
        .sum()
}

#[cfg(target_os = "linux")]
fn chromium_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/google-chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(target_os = "windows")]
fn chromium_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(root) = std::env::var_os(variable) {
            roots.push(PathBuf::from(root));
        }
    }
    roots
        .into_iter()
        .flat_map(|root| {
            [
                root.join("Google/Chrome/Application/chrome.exe"),
                root.join("Microsoft/Edge/Application/msedge.exe"),
                root.join("Chromium/Application/chrome.exe"),
            ]
        })
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn chromium_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[tauri::command]
fn open_business_browser(
    app: AppHandle,
    url: String,
    project_id: String,
    dedicated: bool,
) -> Result<String, String> {
    if !is_allowed_business_url(&url) {
        return Err("业务 URL 不在允许范围内".to_string());
    }
    if !dedicated {
        #[cfg(target_os = "linux")]
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("无法打开默认浏览器: {error}"))?;
        #[cfg(target_os = "windows")]
        Command::new("explorer.exe")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("无法打开默认浏览器: {error}"))?;
        return Ok("default".to_string());
    }
    let executable = chromium_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 Chrome、Edge 或 Chromium，无法启动专用演示环境".to_string())?;
    let profile = dedicated_profile_path(&app, &project_id)?;
    fs::create_dir_all(&profile).map_err(|error| format!("无法创建专用浏览器目录: {error}"))?;
    Command::new(&executable)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(&url)
        .spawn()
        .map_err(|error| format!("无法启动专用浏览器: {error}"))?;
    Ok(executable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Chromium")
        .to_string())
}

#[tauri::command]
fn dedicated_browser_profile_status(
    app: AppHandle,
    project_id: String,
) -> Result<BrowserProfileStatus, String> {
    let path = dedicated_profile_path(&app, &project_id)?;
    Ok(BrowserProfileStatus {
        exists: path.is_dir(),
        bytes: directory_size(&path),
    })
}

#[tauri::command]
fn clear_dedicated_browser_profile(app: AppHandle, project_id: String) -> Result<(), String> {
    let path = dedicated_profile_path(&app, &project_id)?;
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        } else if metadata.is_dir() {
            fs::remove_dir_all(path)
                .map_err(|error| format!("无法清理专用浏览器目录，请先关闭该浏览器: {error}"))?;
        }
    }
    Ok(())
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(application_data_dir(app)?.join("showit.sqlite3"))
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app)?).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS workspace (
              key TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspaces (
              project_id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS project_versions (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              content TEXT NOT NULL,
              snapshot_kind TEXT NOT NULL DEFAULT 'publish',
              created_at INTEGER NOT NULL,
              UNIQUE(project_id, version)
            );
            CREATE TABLE IF NOT EXISTS rehearsals (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              content TEXT NOT NULL,
              ended_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_sessions (
              project_id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS native_diagnostics (
              trace_id TEXT PRIMARY KEY,
              at INTEGER NOT NULL,
              area TEXT NOT NULL,
              message TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    let _ = connection.execute(
        "ALTER TABLE project_versions ADD COLUMN snapshot_kind TEXT NOT NULL DEFAULT 'publish'",
        [],
    );
    Ok(connection)
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceRecord>, String> {
    let connection = open_database(&app)?;
    let mut statement = connection
        .prepare("SELECT content FROM workspaces ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut workspaces = Vec::new();
    for record in records {
        let content = record.map_err(|error| error.to_string())?;
        let workspace = serde_json::from_str(&content)
            .map_err(|error| format!("本地项目数据格式无效: {error}"))?;
        workspaces.push(workspace);
    }
    Ok(workspaces)
}

#[tauri::command]
fn load_workspace(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<Option<WorkspaceRecord>, String> {
    let connection = open_database(&app)?;
    let requested = match project_id {
        Some(id) => Some(id),
        None => connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'active_project_id'",
                [],
                |row| row.get(0),
            )
            .ok(),
    };

    let stored: Result<String, _> = match requested {
        Some(id) => connection.query_row(
            "SELECT content FROM workspaces WHERE project_id = ?1",
            params![id],
            |row| row.get(0),
        ),
        None => connection.query_row(
            "SELECT content FROM workspaces ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        ),
    };

    match stored {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("本地项目数据格式无效: {error}")),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let legacy: Result<String, _> = connection.query_row(
                "SELECT content FROM workspace WHERE key = 'active'",
                [],
                |row| row.get(0),
            );
            match legacy {
                Ok(content) => serde_json::from_str(&content)
                    .map(Some)
                    .map_err(|error| format!("本地项目数据格式无效: {error}")),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_workspace(app: AppHandle, workspace: WorkspaceRecord) -> Result<(), String> {
    let connection = open_database(&app)?;
    let project_id = workspace
        .project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "项目缺少有效 ID".to_string())?;
    let content = serde_json::to_string(&workspace).map_err(|error| error.to_string())?;
    connection
        .execute(
            "
            INSERT INTO workspaces (project_id, content, updated_at)
            VALUES (?1, ?2, strftime('%s','now'))
            ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
            ",
            params![project_id, content],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "
            INSERT INTO settings (key, value) VALUES ('active_project_id', ?1)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            ",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_runtime_session(app: AppHandle, workspace: WorkspaceRecord) -> Result<(), String> {
    let project_id = workspace
        .project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| is_safe_identifier(value))
        .ok_or_else(|| "运行会话缺少有效项目 ID".to_string())?;
    let session_project_id = workspace
        .session
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| "运行会话缺少项目关联".to_string())?;
    if project_id != session_project_id {
        return Err("运行会话与项目不匹配".to_string());
    }
    let content = serde_json::to_string(&workspace).map_err(|error| error.to_string())?;
    open_database(&app)?
        .execute(
            "INSERT INTO runtime_sessions (project_id, content, updated_at) VALUES (?1, ?2, strftime('%s','now')) ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params![project_id, content],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_runtime_session(
    app: AppHandle,
    project_id: String,
) -> Result<Option<WorkspaceRecord>, String> {
    if !is_safe_identifier(&project_id) {
        return Err("运行会话项目 ID 无效".to_string());
    }
    let stored = open_database(&app)?.query_row(
        "SELECT content FROM runtime_sessions WHERE project_id = ?1",
        params![project_id],
        |row| row.get::<_, String>(0),
    );
    match stored {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("运行会话快照格式无效: {error}")),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn clear_runtime_session(app: AppHandle, project_id: String) -> Result<(), String> {
    if !is_safe_identifier(&project_id) {
        return Err("运行会话项目 ID 无效".to_string());
    }
    open_database(&app)?
        .execute(
            "DELETE FROM runtime_sessions WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn configure_readonly_proxy(
    service: State<'_, ReadonlyProxyService>,
    project_id: String,
    origin: String,
    page_url: String,
    login_paths: Vec<String>,
    logout_paths: Vec<String>,
    request_headers: Vec<ConnectorHeader>,
) -> Result<ReadonlyProxyTarget, String> {
    if !is_safe_identifier(&project_id) {
        return Err("只读代理项目 ID 无效".to_string());
    }
    service
        .configure(
            project_id,
            origin,
            page_url,
            login_paths.into_iter().chain(logout_paths).collect(),
            request_headers,
        )
        .await
}

#[tauri::command]
async fn clear_readonly_proxy(
    service: State<'_, ReadonlyProxyService>,
    project_id: String,
) -> Result<(), String> {
    if !is_safe_identifier(&project_id) {
        return Err("只读代理项目 ID 无效".to_string());
    }
    service.clear(&project_id).await;
    Ok(())
}

#[tauri::command]
fn delete_workspace(app: AppHandle, project_id: String) -> Result<(), String> {
    let connection = open_database(&app)?;
    connection
        .execute(
            "DELETE FROM workspaces WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM settings WHERE key = 'active_project_id' AND value = ?1",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn unix_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn record_native_diagnostic(app: AppHandle, entry: NativeDiagnosticEntry) -> Result<(), String> {
    let entry = sanitize_native_diagnostic(entry)?;
    let connection = open_database(&app)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO native_diagnostics (trace_id, at, area, message) VALUES (?1, ?2, ?3, ?4)",
            params![entry.trace_id, entry.at, entry.area, entry.message],
        )
        .map_err(|error| error.to_string())?;
    let retention_threshold = (unix_millis()? as i64).saturating_sub(7 * 24 * 60 * 60 * 1_000);
    connection
        .execute(
            "DELETE FROM native_diagnostics WHERE at < ?1",
            params![retention_threshold],
        )
        .map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM native_diagnostics WHERE trace_id NOT IN (SELECT trace_id FROM native_diagnostics ORDER BY at DESC LIMIT 500)", []).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_native_diagnostics(app: AppHandle) -> Result<Vec<NativeDiagnosticEntry>, String> {
    let connection = open_database(&app)?;
    let retention_threshold = (unix_millis()? as i64).saturating_sub(7 * 24 * 60 * 60 * 1_000);
    connection
        .execute(
            "DELETE FROM native_diagnostics WHERE at < ?1",
            params![retention_threshold],
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT trace_id, at, area, message FROM native_diagnostics ORDER BY at DESC LIMIT 500",
        )
        .map_err(|error| error.to_string())?;
    let entries = statement
        .query_map([], |row| {
            Ok(NativeDiagnosticEntry {
                trace_id: row.get(0)?,
                at: row.get(1)?,
                area: row.get(2)?,
                message: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(entries)
}

#[tauri::command]
fn clear_native_diagnostics(app: AppHandle) -> Result<(), String> {
    open_database(&app)?
        .execute("DELETE FROM native_diagnostics", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_project_versions(app: AppHandle, project_id: String) -> Result<Vec<Value>, String> {
    let connection = open_database(&app)?;
    let mut statement = connection
        .prepare("SELECT content FROM project_versions WHERE project_id = ?1 ORDER BY version DESC")
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut versions = Vec::new();
    for record in records {
        versions.push(
            serde_json::from_str(&record.map_err(|error| error.to_string())?)
                .map_err(|error| format!("版本快照格式无效: {error}"))?,
        );
    }
    Ok(versions)
}

#[tauri::command]
fn publish_project_version(
    app: AppHandle,
    project: Value,
    change_summary: String,
    kind: Option<String>,
) -> Result<Value, String> {
    let connection = open_database(&app)?;
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "项目缺少有效 ID".to_string())?;
    let next_version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM project_versions WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let created_at = unix_millis()?;
    let kind = kind.unwrap_or_else(|| "publish".to_string());
    if !matches!(kind.as_str(), "publish" | "manual" | "auto") {
        return Err("快照类型无效".to_string());
    }
    let id = format!("version-{created_at}-{next_version}");
    let version = json!({
        "id": id,
        "projectId": project_id,
        "version": next_version,
        "kind": kind,
        "createdAt": created_at,
        "changeSummary": change_summary,
        "snapshot": project
    });
    let content = serde_json::to_string(&version).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO project_versions (id, project_id, version, content, snapshot_kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, project_id, next_version, content, kind, created_at.to_string()],
        )
        .map_err(|error| error.to_string())?;
    if kind == "auto" {
        connection.execute(
            "DELETE FROM project_versions WHERE id IN (SELECT id FROM project_versions WHERE project_id = ?1 AND snapshot_kind = 'auto' ORDER BY created_at DESC LIMIT -1 OFFSET 30)",
            params![project_id],
        ).map_err(|error| error.to_string())?;
    }
    Ok(version)
}

#[tauri::command]
fn list_rehearsals(app: AppHandle, project_id: String) -> Result<Vec<Value>, String> {
    let connection = open_database(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT content FROM rehearsals WHERE project_id = ?1 ORDER BY ended_at DESC LIMIT 5",
        )
        .map_err(|error| error.to_string())?;
    let records = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut rehearsals = Vec::new();
    for record in records {
        rehearsals.push(
            serde_json::from_str(&record.map_err(|error| error.to_string())?)
                .map_err(|error| format!("排练记录格式无效: {error}"))?,
        );
    }
    Ok(rehearsals)
}

#[tauri::command]
fn save_rehearsal(app: AppHandle, rehearsal: Value) -> Result<(), String> {
    let connection = open_database(&app)?;
    let id = rehearsal
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "排练记录缺少有效 ID".to_string())?;
    let project_id = rehearsal
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| "排练记录缺少项目 ID".to_string())?;
    let ended_at = rehearsal
        .get("endedAt")
        .and_then(Value::as_i64)
        .ok_or_else(|| "排练记录缺少结束时间".to_string())?;
    let content = serde_json::to_string(&rehearsal).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT OR REPLACE INTO rehearsals (id, project_id, content, ended_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, project_id, content, ended_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_audience_window(
    app: AppHandle,
    service: State<'_, AudienceService>,
    session_id: String,
) -> Result<(), String> {
    if !is_safe_identifier(&session_id) {
        return Err("观众会话标识无效".to_string());
    }
    let safe_suffix: String = session_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    let label = format!("audience-{safe_suffix}");

    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let presenter_monitor = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(monitor_fingerprint);
    let monitors = main_window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let fingerprints = monitors.iter().map(monitor_fingerprint).collect::<Vec<_>>();
    let target_index = secondary_monitor_index(&fingerprints, presenter_monitor.as_ref());
    let target = target_index.and_then(|index| monitors.get(index));

    let audience_url = service.local_url(&session_id).await?;
    let audience_url = audience_url
        .parse::<tauri::Url>()
        .map_err(|_| "本机观众屏地址无效".to_string())?;
    let mut builder =
        WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(audience_url))
            .title("Showit 观众屏")
            .fullscreen(true);
    if let Some(monitor) = target {
        builder = builder.position(monitor.position().x as f64, monitor.position().y as f64);
    }
    let audience_window = builder.build().map_err(|error| error.to_string())?;
    let event_app = app.clone();
    let event_session_id = session_id.clone();
    audience_window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = event_app.emit(
                "showit://audience-window-closed",
                json!({ "sessionId": event_session_id }),
            );
        }
    });

    if let Some(target_fingerprint) = target.map(monitor_fingerprint) {
        let monitor_app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(window) = monitor_app.get_webview_window(&label) else {
                break;
            };
            let available = match window.available_monitors() {
                Ok(monitors) => monitors,
                Err(_) => continue,
            };
            if available
                .iter()
                .any(|monitor| monitor_fingerprint(monitor) == target_fingerprint)
            {
                continue;
            }
            let _ = window.close();
            break;
        });
    }
    Ok(())
}

#[tauri::command]
fn send_extension_message(
    bridge: State<'_, NativeBridge>,
    message: Value,
) -> Result<usize, String> {
    bridge.send(&message)
}

#[tauri::command]
fn native_bridge_status(bridge: State<'_, NativeBridge>) -> usize {
    bridge.connection_count()
}

#[tauri::command]
fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_business_url(url: String) -> UrlHealth {
    let started = Instant::now();
    if !is_allowed_business_url(&url) {
        return UrlHealth {
            ok: false,
            status: None,
            elapsed_ms: 0,
            error: Some("业务 URL 不在允许范围内".to_string()),
        };
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Showit/0.1 health-check")
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return UrlHealth {
                ok: false,
                status: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: Some("健康检查客户端无法初始化".to_string()),
            }
        }
    };
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            UrlHealth {
                ok: response.status().is_success(),
                status: Some(status),
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: None,
            }
        }
        Err(error) => UrlHealth {
            ok: false,
            status: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error: Some(if error.is_timeout() {
                "业务页面加载超时".to_string()
            } else {
                "业务页面无法连接".to_string()
            }),
        },
    }
}

#[tauri::command]
async fn start_audience_session(
    service: State<'_, AudienceService>,
    session_id: String,
    snapshot: Value,
    network_address: Option<String>,
) -> Result<AudienceShare, String> {
    service
        .create_session(&session_id, snapshot, network_address.as_deref())
        .await
}

#[tauri::command]
fn audience_network_interfaces() -> Vec<audience_service::AudienceNetworkInterface> {
    AudienceService::network_interfaces()
}

#[tauri::command]
async fn publish_audience_session(
    service: State<'_, AudienceService>,
    session_id: String,
    snapshot: Value,
) -> Result<(), String> {
    service.publish(&session_id, snapshot).await
}

#[tauri::command]
async fn stop_audience_session(
    service: State<'_, AudienceService>,
    session_id: String,
) -> Result<(), String> {
    service.stop_session(&session_id).await;
    Ok(())
}

#[tauri::command]
async fn audience_session_status(
    service: State<'_, AudienceService>,
    session_id: String,
) -> Result<Option<audience_service::AudienceSessionStatus>, String> {
    Ok(service.session_status(&session_id).await)
}

#[tauri::command]
async fn decide_audience_viewer(
    service: State<'_, AudienceService>,
    session_id: String,
    viewer_id: String,
    approve: bool,
) -> Result<(), String> {
    service
        .decide_viewer(&session_id, &viewer_id, approve)
        .await
}

#[tauri::command]
async fn disconnect_audience_viewer(
    service: State<'_, AudienceService>,
    session_id: String,
    viewer_id: String,
) -> Result<(), String> {
    service.disconnect_viewer(&session_id, &viewer_id).await
}

#[tauri::command]
async fn disconnect_all_audience_viewers(
    service: State<'_, AudienceService>,
    session_id: String,
) -> Result<(), String> {
    service.disconnect_all_viewers(&session_id).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let service = AudienceService::start(livekit_sidecar_path(app.handle()))
                .map_err(std::io::Error::other)?;
            app.manage(service);
            let readonly_proxy = ReadonlyProxyService::start().map_err(std::io::Error::other)?;
            app.manage(readonly_proxy);
            let bridge =
                NativeBridge::start(app.handle().clone()).map_err(std::io::Error::other)?;
            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            record_native_diagnostic,
            list_native_diagnostics,
            clear_native_diagnostics,
            load_workspace,
            save_workspace,
            save_runtime_session,
            load_runtime_session,
            clear_runtime_session,
            configure_readonly_proxy,
            clear_readonly_proxy,
            delete_workspace,
            list_project_versions,
            publish_project_version,
            list_rehearsals,
            save_rehearsal,
            start_audience_session,
            audience_network_interfaces,
            publish_audience_session,
            stop_audience_session,
            audience_session_status,
            decide_audience_viewer,
            disconnect_audience_viewer,
            disconnect_all_audience_viewers,
            distribution_info,
            open_external_url,
            send_extension_message,
            native_bridge_status,
            check_business_url,
            open_business_browser,
            dedicated_browser_profile_status,
            clear_dedicated_browser_profile,
            focus_main_window,
            open_audience_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running Showit");
}
mod audience_service;
pub mod native_bridge;
mod readonly_proxy;

#[cfg(test)]
mod url_tests {
    use super::is_allowed_business_url;
    use super::is_safe_identifier;
    use super::redact_native_diagnostic;
    use super::{secondary_monitor_index, MonitorFingerprint};
    use std::path::Path;

    #[test]
    fn limits_business_health_check_urls() {
        assert!(is_allowed_business_url("https://example.com/path"));
        assert!(is_allowed_business_url("http://localhost:3000/path"));
        assert!(!is_allowed_business_url("http://example.com/path"));
        assert!(!is_allowed_business_url("file:///tmp/private"));
        assert!(!is_allowed_business_url(
            "https://demo:password@example.com/path"
        ));
        assert!(!is_allowed_business_url(
            "https://example.com/path?access_token=private"
        ));
    }

    #[test]
    fn limits_browser_profile_identifiers() {
        assert!(is_safe_identifier("project-demo-1"));
        assert!(!is_safe_identifier("../project"));
        assert!(!is_safe_identifier("project/demo"));
    }

    #[test]
    fn chooses_a_monitor_other_than_the_presenter_and_requires_two_displays() {
        let primary = MonitorFingerprint {
            name: Some("Primary".to_string()),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let secondary = MonitorFingerprint {
            name: Some("Audience".to_string()),
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(
            secondary_monitor_index(std::slice::from_ref(&primary), Some(&primary)),
            None
        );
        assert_eq!(
            secondary_monitor_index(&[primary.clone(), secondary.clone()], Some(&primary)),
            Some(1)
        );
        assert_eq!(
            secondary_monitor_index(&[primary.clone(), secondary.clone()], Some(&secondary)),
            Some(0)
        );
    }

    #[test]
    fn redacts_native_diagnostic_secrets_and_business_urls() {
        let value =
            redact_native_diagnostic("password=hunter2 \"access_token\":\"private\" https://example.com/app/customer/42?token=secret-value");
        assert!(value.contains("password=[REDACTED]"));
        assert!(value.contains("[REDACTED_URL]"));
        assert!(!value.contains("hunter2") && !value.contains("private"));
        assert!(!value.contains("secret-value") && !value.contains("example.com"));
    }

    #[test]
    fn enables_portable_data_only_for_an_absolute_override_or_marker() {
        let executable = Path::new("/opt/showit/showit");
        assert_eq!(
            super::resolve_portable_data_path(executable, None, false),
            None
        );
        assert_eq!(
            super::resolve_portable_data_path(executable, None, true),
            Some(Path::new("/opt/showit/data").to_path_buf())
        );
        assert_eq!(
            super::resolve_portable_data_path(executable, Some(Path::new("relative")), false),
            None
        );
        assert_eq!(
            super::resolve_portable_data_path(
                executable,
                Some(Path::new("/tmp/showit-data")),
                false
            ),
            Some(Path::new("/tmp/showit-data").to_path_buf())
        );
    }
}

use audience_service::{AudienceService, AudienceShare};
use native_bridge::NativeBridge;
use readonly_proxy::{ConnectorHeader, ReadonlyProxyService, ReadonlyProxyTarget};
