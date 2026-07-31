//! Framed FS IPC client — matches host/bridge/data/fs-binary.js
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use serde_json::{json, Value};

pub const OP_AUTH: u8 = 1;
pub const OP_TREE: u8 = 2;
pub const OP_LIST: u8 = 3;
pub const OP_STAT: u8 = 4;
pub const OP_READ: u8 = 5;
pub const OP_WRITE: u8 = 6;
pub const OP_MKDIR: u8 = 7;
pub const OP_UNLINK: u8 = 8;
pub const OP_RENAME: u8 = 9;
pub const OP_TRUNCATE: u8 = 10;
#[allow(dead_code)]
pub const OP_EVENTS: u8 = 11;
pub const OP_HEALTH: u8 = 12;
pub const OP_ERROR: u8 = 255;

#[derive(Debug)]
pub struct IpcError {
    pub message: String,
    pub code: String,
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for IpcError {}

pub struct FsIpc {
    host: String,
    port: u16,
    token: String,
    stream: Mutex<Option<TcpStream>>,
    req_id: AtomicU32,
}

impl FsIpc {
    pub fn new(host: String, port: u16, token: String) -> Self {
        Self {
            host,
            port,
            token,
            stream: Mutex::new(None),
            req_id: AtomicU32::new(1),
        }
    }

    fn next_id(&self) -> u32 {
        let id = self.req_id.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            self.req_id.fetch_add(1, Ordering::Relaxed)
        } else {
            id
        }
    }

    fn connect_locked(&self, slot: &mut Option<TcpStream>) -> Result<(), IpcError> {
        if slot.is_some() {
            return Ok(());
        }
        let addr = format!("{}:{}", self.host, self.port);
        use std::net::ToSocketAddrs;
        let mut addrs = addr.to_socket_addrs().map_err(|e| IpcError {
            message: format!("resolve {addr}: {e}"),
            code: "EIO".into(),
        })?;
        let sock_addr = addrs.next().ok_or_else(|| IpcError {
            message: format!("resolve {addr}: no addresses"),
            code: "EIO".into(),
        })?;
        let stream = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(10)).map_err(
            |e| IpcError {
                message: format!("connect {addr}: {e}"),
                code: "EIO".into(),
            },
        )?;
        stream.set_nodelay(true).map_err(|e| IpcError {
            message: e.to_string(),
            code: "EIO".into(),
        })?;
        stream
            .set_read_timeout(Some(Duration::from_secs(120)))
            .ok();
        stream
            .set_write_timeout(Some(Duration::from_secs(120)))
            .ok();
        *slot = Some(stream);
        // AUTH
        let auth = self.call_on(slot, OP_AUTH, json!({ "token": self.token }))?;
        if auth.get("ok") != Some(&Value::Bool(true)) {
            *slot = None;
            return Err(IpcError {
                message: auth
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("AUTH failed")
                    .to_string(),
                code: "EAUTH".into(),
            });
        }
        Ok(())
    }

    fn call_on(
        &self,
        slot: &mut Option<TcpStream>,
        op: u8,
        body: Value,
    ) -> Result<Value, IpcError> {
        let stream = slot.as_mut().ok_or_else(|| IpcError {
            message: "not connected".into(),
            code: "EIO".into(),
        })?;
        let payload = serde_json::to_vec(&body).map_err(|e| IpcError {
            message: e.to_string(),
            code: "EINVAL".into(),
        })?;
        let req_id = self.next_id();
        let len = (1 + 4 + payload.len()) as u32;
        let mut frame = Vec::with_capacity(4 + len as usize);
        frame.extend_from_slice(&len.to_be_bytes());
        frame.push(op);
        frame.extend_from_slice(&req_id.to_be_bytes());
        frame.extend_from_slice(&payload);
        stream.write_all(&frame).map_err(|e| IpcError {
            message: e.to_string(),
            code: "EIO".into(),
        })?;

        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).map_err(|e| IpcError {
            message: e.to_string(),
            code: "EIO".into(),
        })?;
        let rlen = u32::from_be_bytes(len_buf) as usize;
        if rlen < 5 || rlen > 64 * 1024 * 1024 {
            return Err(IpcError {
                message: "bad frame length".into(),
                code: "EIO".into(),
            });
        }
        let mut raw = vec![0u8; rlen];
        stream.read_exact(&mut raw).map_err(|e| IpcError {
            message: e.to_string(),
            code: "EIO".into(),
        })?;
        let rop = raw[0];
        let data: Value = serde_json::from_slice(&raw[5..]).unwrap_or(json!({}));
        if rop == OP_ERROR || data.get("ok") == Some(&Value::Bool(false)) {
            return Err(IpcError {
                message: data
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("FS IPC error")
                    .to_string(),
                code: data
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("EIO")
                    .to_string(),
            });
        }
        Ok(data)
    }

    pub fn call(&self, op: u8, body: Value) -> Result<Value, IpcError> {
        let mut guard = self.stream.lock();
        if let Err(e) = self.connect_locked(&mut guard) {
            *guard = None;
            return Err(e);
        }
        match self.call_on(&mut guard, op, body) {
            Ok(v) => Ok(v),
            Err(e) => {
                *guard = None;
                Err(e)
            }
        }
    }

    pub fn health(&self) -> Result<Value, IpcError> {
        self.call(OP_HEALTH, json!({}))
    }

    pub fn tree(&self, path: &str, max_depth: u32, max_entries: u32) -> Result<Value, IpcError> {
        self.call(
            OP_TREE,
            json!({
                "path": path,
                "maxDepth": max_depth,
                "maxEntries": max_entries,
            }),
        )
    }

    pub fn list(&self, path: &str, include_excluded: bool) -> Result<Value, IpcError> {
        self.call(
            OP_LIST,
            json!({
                "path": path,
                "shallow": true,
                "withStats": true,
                "includeExcluded": include_excluded,
            }),
        )
    }

    pub fn stat(&self, path: &str) -> Result<Value, IpcError> {
        self.call(OP_STAT, json!({ "path": path }))
    }

    pub fn read(&self, path: &str, offset: u64, length: Option<u64>) -> Result<Vec<u8>, IpcError> {
        let mut body = json!({ "path": path, "offset": offset });
        if let Some(n) = length {
            body["length"] = json!(n);
        }
        let resp = self.call(OP_READ, body)?;
        let data = resp.get("data").and_then(|v| v.as_str()).unwrap_or("");
        if resp.get("encoding").and_then(|v| v.as_str()) == Some("base64") {
            B64.decode(data).map_err(|e| IpcError {
                message: e.to_string(),
                code: "EIO".into(),
            })
        } else {
            Ok(data.as_bytes().to_vec())
        }
    }

    pub fn write(
        &self,
        path: &str,
        data: &[u8],
        offset: u64,
        truncate: bool,
    ) -> Result<Value, IpcError> {
        self.call(
            OP_WRITE,
            json!({
                "path": path,
                "offset": offset,
                "truncate": truncate,
                "encoding": "base64",
                "data": B64.encode(data),
            }),
        )
    }

    pub fn mkdir(&self, path: &str) -> Result<Value, IpcError> {
        self.call(OP_MKDIR, json!({ "path": path }))
    }

    pub fn unlink(&self, path: &str) -> Result<Value, IpcError> {
        self.call(OP_UNLINK, json!({ "path": path }))
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<Value, IpcError> {
        self.call(OP_RENAME, json!({ "from": from, "to": to }))
    }

    pub fn truncate(&self, path: &str, size: u64) -> Result<Value, IpcError> {
        self.call(OP_TRUNCATE, json!({ "path": path, "size": size }))
    }
}
