// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tauri::{Manager, State};

struct AppState {
    node_path: Mutex<String>,
    cli_path: Mutex<String>,
}

/// 跨平台获取用户主目录：
/// - Windows 通常没有 `HOME`，应优先使用 `USERPROFILE`
/// - macOS/Linux 使用 `HOME`
fn home_dir() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Some(dir) = std::env::var_os(key) {
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    None
}

/// 获取 Codex 数据目录（~/.codex）。失败时返回可读错误而不是 panic。
fn codex_home() -> Result<String, String> {
    home_dir()
        .map(|home| home.join(".codex").to_string_lossy().to_string())
        .ok_or_else(|| {
            "无法确定用户主目录：请确保已设置 USERPROFILE（Windows）或 HOME（macOS/Linux）环境变量"
                .to_string()
        })
}

fn canonicalize_or(path: &Path) -> String {
    let resolved = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    // Windows 的 canonicalize 会返回带 `\\?\` 前缀的扩展长度路径，
    // Node.js 的 CJS 模块加载器无法处理该前缀（会被解析成裸盘符并报 EISDIR），
    // 因此传给 node 之前要去掉前缀。
    #[cfg(windows)]
    if let Some(normalized) = resolved.strip_prefix(r"\\?\") {
        return normalized.to_string();
    }

    resolved
}

fn resolve_cli_path(app: &tauri::App) -> String {
    // 1. 开发/源码目录运行：GUI 仓库相邻的 codex-provider-sync
    let relative = Path::new("../codex-provider-sync/src/cli.js");
    if relative.is_file() {
        return canonicalize_or(relative);
    }

    // 2. 打包后：从 Tauri 资源目录查找随包分发的 CLI 源码。
    //    tauri.conf.json 中带 `..` 的资源路径在打包时会转换为 `_up_` 目录，
    //    因此 `../../codex-provider-sync/src` 落地为 `_up_/_up_/codex-provider-sync/src`。
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("_up_/_up_/codex-provider-sync/src/cli.js"),
            resource_dir.join("_up_/codex-provider-sync/src/cli.js"),
            resource_dir.join("codex-provider-sync/src/cli.js"),
        ] {
            if candidate.is_file() {
                return canonicalize_or(&candidate);
            }
        }
    }

    // 3. 兜底：从可执行文件所在目录向上回溯查找
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let mut dir = exe_dir.to_path_buf();
            for _ in 0..4 {
                for candidate in [
                    dir.join("codex-provider-sync/src/cli.js"),
                    dir.join("Resources/codex-provider-sync/src/cli.js"),
                    dir.join("_up_/_up_/codex-provider-sync/src/cli.js"),
                ] {
                    if candidate.is_file() {
                        return canonicalize_or(&candidate);
                    }
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    // 4. 兜底：工作目录下的相对路径
    "../codex-provider-sync/src/cli.js".to_string()
}

fn node_executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn resolve_node_path() -> String {
    let exe = node_executable_name();

    // 1. 在 PATH 中查找（Windows 用 `;` 分隔，macOS/Linux 用 `:` 分隔）
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    // 2. 常见 nvm / 安装目录兜底
    if let Some(home) = home_dir() {
        let mut roots: Vec<PathBuf> = Vec::new();
        if cfg!(windows) {
            // Windows nvm 结构: %APPDATA%\nvm\<version>\node.exe
            roots.push(home.join("AppData/Roaming/nvm"));
            roots.push(PathBuf::from(r"C:\Program Files\nodejs"));
            roots.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));
        } else {
            // macOS/Linux nvm 结构: ~/.nvm/versions/node/<version>/bin/node
            roots.push(home.join(".nvm/versions/node"));
        }

        for root in roots {
            if root.join(exe).is_file() {
                return root.join(exe).to_string_lossy().to_string();
            }
            if let Ok(entries) = std::fs::read_dir(&root) {
                let mut versions: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
                versions.sort_by_key(|entry| entry.file_name());
                for entry in versions.into_iter().rev() {
                    let candidate = if cfg!(windows) {
                        entry.path().join(exe)
                    } else {
                        entry.path().join("bin").join(exe)
                    };
                    if candidate.is_file() {
                        return candidate.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    // 3. 最终兜底：交给系统解析 PATH 中的 node（全局安装时可用）
    "node".to_string()
}

fn run_cli_command(state: &State<AppState>, cli_args: &[&str]) -> Result<String, String> {
    let node = state.node_path.lock().unwrap();
    let cli = state.cli_path.lock().unwrap();

    if node.as_str() != "node" && !Path::new(&*node).is_file() {
        return Err(format!(
            "未找到 Node.js：{}。请安装 Node.js 24+ 或将其加入 PATH 后重试。",
            &*node
        ));
    }
    if !Path::new(&*cli).is_file() {
        return Err(format!(
            "未找到 CLI 脚本：{}。请确认 codex-provider-sync 源码已随应用一起安装。",
            &*cli
        ));
    }

    let mut args = Vec::with_capacity(cli_args.len() + 1);
    args.push(cli.clone());
    args.extend(cli_args.iter().map(|arg| (*arg).to_string()));

    let output = Command::new(&*node)
        .args(&args)
        .output()
        .map_err(|e| {
            format!(
                "启动 Node.js 失败（{}）：{}。请安装 Node.js 24+ 并确保其在 PATH 中。",
                &*node, e
            )
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Result<String, String> {
    let home = codex_home()?;
    run_cli_command(&state, &["status", "--codex-home", home.as_str()])
}

#[tauri::command]
fn run_sync(
    state: State<AppState>,
    from: Option<String>,
    to: String,
    model: Option<String>,
    repair_models: bool,
) -> Result<String, String> {
    let home = codex_home()?;
    let mut cli_args = vec!["sync".to_string()];
    if let Some(source) = from {
        let trimmed = source.trim();
        if !trimmed.is_empty() && trimmed != "*" {
            cli_args.push("--from".to_string());
            cli_args.push(trimmed.to_string());
        }
    }
    if let Some(model_name) = model {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cli_args.push("--model".to_string());
            cli_args.push(trimmed.to_string());
        }
    }
    if repair_models {
        cli_args.push("--repair-models".to_string());
    }
    cli_args.push("--provider".to_string());
    cli_args.push(to);
    cli_args.push("--codex-home".to_string());
    cli_args.push(home);

    let arg_refs: Vec<&str> = cli_args.iter().map(|arg| arg.as_str()).collect();
    run_cli_command(&state, &arg_refs)
}

#[tauri::command]
fn run_switch(state: State<AppState>, provider: String) -> Result<String, String> {
    let home = codex_home()?;
    run_cli_command(
        &state,
        &["switch", provider.as_str(), "--codex-home", home.as_str()],
    )
}

#[tauri::command]
fn run_restore(state: State<AppState>, backup_dir: String) -> Result<String, String> {
    let home = codex_home()?;
    run_cli_command(
        &state,
        &["restore", backup_dir.as_str(), "--codex-home", home.as_str()],
    )
}

#[tauri::command]
fn run_backup(state: State<AppState>) -> Result<String, String> {
    let home = codex_home()?;
    run_cli_command(&state, &["backup", "--codex-home", home.as_str()])
}

#[tauri::command]
fn list_backups(state: State<AppState>) -> Result<String, String> {
    let home = codex_home()?;
    run_cli_command(&state, &["list-backups", "--json", "--codex-home", home.as_str()])
}

fn main() {
    let node_path = resolve_node_path();

    if let Err(error) = tauri::Builder::default()
        .setup(|app| {
            let cli_path = resolve_cli_path(app);
            app.manage(AppState {
                node_path: Mutex::new(node_path),
                cli_path: Mutex::new(cli_path),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            run_sync,
            run_switch,
            run_restore,
            run_backup,
            list_backups
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {error}");
        std::process::exit(1);
    }
}
