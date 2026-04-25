// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::State;
use std::sync::Mutex;

struct AppState {
    node_path: Mutex<String>,
    cli_path: Mutex<String>,
}

fn resolve_cli_path() -> String {
    // 优先使用相对路径（开发/源码运行）
    let relative = std::path::Path::new("../codex-provider-sync/src/cli.js");
    if relative.exists() {
        return relative.canonicalize().unwrap_or(relative.to_path_buf()).to_string_lossy().to_string();
    }

    // 回退到基于 exe 所在目录的绝对路径（打包后运行）
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // macOS .app 结构: Codex Provider Sync.app/Contents/MacOS/
            // 向上回溯到 app bundle 根目录，再找 cli.js
            let mut dir = exe_dir.to_path_buf();
            // 尝试从 MacOS 目录向上找到 Resources 或 app bundle 根目录
            for _ in 0..3 {
                let candidate = dir.join("codex-provider-sync/src/cli.js");
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
                let candidate2 = dir.join("Resources/codex-provider-sync/src/cli.js");
                if candidate2.exists() {
                    return candidate2.to_string_lossy().to_string();
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    // 最后的兜底：使用当前工作目录的相对路径
    "../codex-provider-sync/src/cli.js".to_string()
}

fn resolve_node_path() -> String {
    // 优先使用环境变量中的 node
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(std::path::MAIN_SEPARATOR) {
            let candidate = std::path::Path::new(dir).join("node");
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    // 检查常见 nvm 路径
    if let Ok(home) = std::env::var("HOME") {
        let nvm_node = std::path::Path::new(&home).join(".nvm/versions/node/v24.15.0/bin/node");
        if nvm_node.exists() {
            return nvm_node.to_string_lossy().to_string();
        }
    }

    // 兜底
    "node".to_string()
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let cli = state.cli_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([&*cli, "status", "--codex-home", &format!("{}/.codex", std::env::var("HOME").unwrap())])
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
    let cli = state.cli_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            &*cli,
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
    let cli = state.cli_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            &*cli,
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
    let cli = state.cli_path.lock().unwrap();
    let output = Command::new(&*node)
        .args([
            &*cli,
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
    let node_path = resolve_node_path();
    let cli_path = resolve_cli_path();

    tauri::Builder::default()
        .manage(AppState {
            node_path: Mutex::new(node_path),
            cli_path: Mutex::new(cli_path),
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
