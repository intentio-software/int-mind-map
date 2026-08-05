//! Talking to Intentio Tasks through its MCP server.
//!
//! Writing into `~/.intentio/tasks` directly would be simpler and wrong: the
//! task store is an append-only log with one writer per process, and a second
//! program appending to it would race the running Tasks app. Going through
//! `int-tasks-mcp` means the same code path an agent uses, the same validation,
//! and one implementation of what "add a task" means.
//!
//! The binary is spawned per call and exits with it. That costs a few
//! milliseconds and buys not having to supervise a child process.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

/// Where the MCP binary might be, in the order worth trying.
fn locate_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("INT_TASKS_MCP") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/int-tasks-mcp"));
        candidates.push(home.join("bin/int-tasks-mcp"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/int-tasks-mcp"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/int-tasks-mcp"));
    candidates.into_iter().find(|path| path.is_file())
}

/// Whether Tasks can be reached at all, so the UI can say so rather than fail
/// at the moment the user asks for something.
#[tauri::command]
pub fn tasks_available() -> bool {
    locate_binary().is_some()
}

/// Run one tool call against the Tasks MCP server.
///
/// The protocol is newline-delimited JSON-RPC over stdio: initialize, then the
/// call, then close stdin and let it exit.
fn call_tool(name: &str, arguments: Value) -> Result<Value, String> {
    let binary = locate_binary()
        .ok_or_else(|| "Intentio Tasks is not installed, or its MCP server is not on PATH.".to_string())?;

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("could not start {}: {err}", binary.display()))?;

    {
        let stdin = child.stdin.as_mut().ok_or("no stdin on the Tasks server")?;
        let initialize = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
        let request = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments}
        });
        writeln!(stdin, "{initialize}").map_err(|err| err.to_string())?;
        writeln!(stdin, "{request}").map_err(|err| err.to_string())?;
    }
    // Dropping stdin is what tells the server there is nothing more coming.
    drop(child.stdin.take());

    let stdout = child.stdout.take().ok_or("no stdout from the Tasks server")?;
    let mut result: Option<Value> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|err| err.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_u64) == Some(2) {
            result = message.get("result").cloned();
        }
    }
    let _ = child.wait();

    let result = result.ok_or("the Tasks server returned nothing")?;
    // A tool failure comes back as a result carrying isError, not as a
    // protocol error, so it has to be unpacked rather than trusted.
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        return Err(text);
    }
    serde_json::from_str::<Value>(&text).map_err(|err| format!("unreadable reply: {err}"))
}

/// What the map keeps about a task it created.
#[derive(Debug, serde::Serialize)]
pub struct LinkedTask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

/// Create a task in Intentio Tasks from a node.
#[tauri::command]
pub fn create_task_from_node(title: String, origin: String) -> Result<LinkedTask, String> {
    let reply = call_tool("add_task", json!({"title": title, "origin": origin}))?;
    let added = reply.get("added").ok_or("the task was not returned")?;
    Ok(LinkedTask {
        id: added.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
        title: added.get("title").and_then(Value::as_str).unwrap_or(&title).to_string(),
        done: false,
    })
}

/// Look a linked task up again, so the map can show whether it is done.
///
/// A task deleted in the Tasks app comes back as `Ok(None)` rather than an
/// error: the link is stale, which is a thing the map should show, not a
/// failure it should complain about.
#[tauri::command]
pub fn linked_task(task_id: String) -> Result<Option<LinkedTask>, String> {
    match call_tool("get_task", json!({"task_id": task_id})) {
        Ok(reply) => {
            let task = reply.get("task").unwrap_or(&reply);
            let status = task.get("status").and_then(Value::as_str).unwrap_or("todo");
            Ok(Some(LinkedTask {
                id: task_id,
                title: task.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                done: status == "done",
            }))
        }
        Err(_) => Ok(None),
    }
}
