use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};

const MAX_MESSAGE_SIZE: usize = 1_048_576;

#[derive(Clone)]
pub struct NativeBridge {
    clients: Arc<Mutex<Vec<TcpStream>>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BridgeDescriptor {
    port: u16,
    token: String,
}

impl NativeBridge {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let descriptor = BridgeDescriptor {
            port,
            token: random_token(),
        };
        write_descriptor(&descriptor)?;
        let clients = Arc::new(Mutex::new(Vec::new()));
        let shared_clients = clients.clone();
        let expected_token = descriptor.token;

        thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else { continue };
                let app = app.clone();
                let clients = shared_clients.clone();
                let token = expected_token.clone();
                thread::spawn(move || handle_client(stream, &token, app, clients));
            }
        });
        Ok(Self { clients })
    }

    pub fn send(&self, message: &Value) -> Result<usize, String> {
        let serialized = serde_json::to_string(message).map_err(|error| error.to_string())?;
        if serialized.len() > MAX_MESSAGE_SIZE {
            return Err("扩展消息超过大小限制".to_string());
        }
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| "扩展桥接状态不可用".to_string())?;
        clients.retain_mut(|client| {
            writeln!(client, "{serialized}")
                .and_then(|_| client.flush())
                .is_ok()
        });
        Ok(clients.len())
    }

    pub fn connection_count(&self) -> usize {
        self.clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0)
    }
}

fn handle_client(
    stream: TcpStream,
    expected_token: &str,
    app: AppHandle,
    clients: Arc<Mutex<Vec<TcpStream>>>,
) {
    let Ok(writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut handshake = String::new();
    if reader.read_line(&mut handshake).is_err() || handshake.len() > 512 {
        return;
    }
    let authenticated = serde_json::from_str::<Value>(&handshake)
        .ok()
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(|token| token == expected_token)
        })
        .unwrap_or(false);
    if !authenticated {
        return;
    }
    if let Ok(mut connected) = clients.lock() {
        connected.push(writer);
    }

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.len() > MAX_MESSAGE_SIZE {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("type").and_then(Value::as_str).is_none() {
            continue;
        }
        let _ = app.emit("showit://extension", message);
    }
}

fn descriptor_path() -> PathBuf {
    if let Some(path) = env::var_os("SHOWIT_BRIDGE_FILE") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    #[cfg(not(target_os = "windows"))]
    let base = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let user_id = unsafe { libc::geteuid() };
            env::temp_dir().join(format!("showit-{user_id}"))
        });
    base.join("showit").join("native-bridge.json")
}

fn write_descriptor(descriptor: &BridgeDescriptor) -> Result<(), String> {
    let path = descriptor_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
    }
    let content = serde_json::to_vec(descriptor).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(&content))
        .map_err(|error| error.to_string())
}

fn read_descriptor() -> Result<BridgeDescriptor, String> {
    let content =
        fs::read(descriptor_path()).map_err(|error| format!("Showit 桌面端未启动: {error}"))?;
    serde_json::from_slice(&content).map_err(|error| format!("本机桥接描述文件无效: {error}"))
}

fn random_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn read_native_message(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message size is invalid",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_native_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message is too large",
        ));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

pub fn run_native_host() -> Result<(), String> {
    let descriptor = read_descriptor()?;
    let stream = TcpStream::connect(("127.0.0.1", descriptor.port))
        .map_err(|error| format!("无法连接 Showit 桌面端: {error}"))?;
    let mut desktop_writer = stream.try_clone().map_err(|error| error.to_string())?;
    writeln!(desktop_writer, "{}", json!({ "token": descriptor.token }))
        .map_err(|error| error.to_string())?;
    desktop_writer.flush().map_err(|error| error.to_string())?;

    let _input_thread = thread::spawn(move || {
        let mut input = io::stdin().lock();
        while let Ok(Some(message)) = read_native_message(&mut input) {
            let Ok(serialized) = serde_json::to_string(&message) else {
                continue;
            };
            if writeln!(desktop_writer, "{serialized}")
                .and_then(|_| desktop_writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let mut output = io::stdout().lock();
    for line in BufReader::new(stream).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        write_native_message(&mut output, &message).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_message_round_trip() {
        let value = json!({ "type": "goto-next", "sessionId": "session-test" });
        let mut bytes = Vec::new();
        write_native_message(&mut bytes, &value).unwrap();
        assert_eq!(
            read_native_message(&mut bytes.as_slice()).unwrap(),
            Some(value)
        );
    }

    #[test]
    fn rejects_oversized_native_messages() {
        let mut bytes = ((MAX_MESSAGE_SIZE as u32) + 1).to_le_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(read_native_message(&mut bytes.as_slice()).is_err());
    }
}
