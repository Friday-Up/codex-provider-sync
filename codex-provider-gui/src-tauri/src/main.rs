// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::State;
use std::sync::Mutex;

struct AppState {
    node_path: Mutex<String>,
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let output = Command::new(&*node)
        .args(["/Users/zhangyaolong.5/Friday/idea_workspace/me/codex-provider-sync/src/cli.js", "status", "--codex-home", &format!("{}/.codex", std::env::var("HOME").unwrap())])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn run_sync(state: State<AppState>, provider: String) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            "/Users/zhangyaolong.5/Friday/idea_workspace/me/codex-provider-sync/src/cli.js",
            "sync",
            "--provider", &provider,
            "--codex-home", &format!("{}/.codex", std::env::var("HOME").unwrap())
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn run_switch(state: State<AppState>, provider: String) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            "/Users/zhangyaolong.5/Friday/idea_workspace/me/codex-provider-sync/src/cli.js",
            "switch", &provider,
            "--codex-home", &format!("{}/.codex", std::env::var("HOME").unwrap())
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn run_restore(state: State<AppState>, backup_dir: String) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            "/Users/zhangyaolong.5/Friday/idea_workspace/me/codex-provider-sync/src/cli.js",
            "restore", &backup_dir,
            "--codex-home", &format!("{}/.codex", std::env::var("HOME").unwrap())
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn main() {
    // Find node path
    let node_path = if std::path::Path::new("/Users/zhangyaolong.5/.nvm/versions/node/v24.15.0/bin/node").exists() {
        "/Users/zhangyaolong.5/.nvm/versions/node/v24.15.0/bin/node".to_string()
    } else {
        "node".to_string()
    };

    tauri::Builder::default()
        .manage(AppState {
            node_path: Mutex::new(node_path),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            run_sync,
            run_switch,
            run_restore
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
