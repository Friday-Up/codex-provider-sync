<div align="center">

# Codex Provider Sync

### 在切换 provider 之后，让 Codex 的历史会话重新可见

[![Release](https://img.shields.io/github/v/release/Friday-Up/codex-provider-sync)](https://github.com/Friday-Up/codex-provider-sync/releases)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)]()

</div>

## 解决什么问题

Codex CLI 支持两种登录方式：**OpenAI 官方 OAuth** 和 **第三方 API Key**。两种方式的会话历史是隔离的——切换后之前的会话会"消失"。

常见现象：

- `codex resume` 里能看到的会话，到了 Codex App 里不一定还能看到
- 切回官方 `openai` 后，之前在第三方 provider 下的历史会话像没了
- 只改 `sessions/*.jsonl` 不够，因为 SQLite 里还有一层 provider 元数据

`codex-provider-sync` 会把这两层一起同步：

- `~/.codex/sessions` 和 `~/.codex/archived_sessions`
- `~/.codex/state_5.sqlite`

## 界面预览

<div align="center">

<img src="screenshots/gui-preview.png" alt="GUI 界面预览" width="720">

*macOS GUI 界面——一键同步会话历史*

</div>

## 项目结构

```
codex-provider-sync-project/
├── codex-provider-sync/      # CLI 工具（Node.js）
│   ├── src/                  # 核心源码
│   ├── test/                 # 测试用例
│   ├── README.md             # CLI 详细文档
│   └── package.json
│
├── codex-provider-gui/       # macOS GUI（Tauri v2）
│   ├── src/                  # 前端页面
│   ├── src-tauri/            # Rust 后端
│   └── package.json
│
└── README.md                 # 本文件
```

## 安装

### 方式一：直接下载（推荐）

从 [Releases](https://github.com/Friday-Up/codex-provider-sync/releases) 页面下载最新版本：

- **macOS 用户**：下载 `.dmg` 文件，拖拽安装
- **Windows 用户**：下载 `.exe` 文件，双击运行

### 方式二：CLI 安装

```bash
cd codex-provider-sync
npm install
codex-provider status
```

### 方式三：从源码构建 GUI

```bash
cd codex-provider-gui
npm install
npm run tauri build
# 构建完成后，app 位于 src-tauri/target/release/bundle/
```

## 快速开始

### GUI 方式（推荐）

1. 打开 `Codex Provider Sync.app`
2. 点击 **刷新状态** 查看当前 provider 分布
3. 选择目标同步方向：
   - **同步到 OpenAI 官方 OAuth** —— 将所有会话改为 `openai`
   - **同步到第三方 API Key** —— 将所有会话改为 `custom`
4. 查看底部日志确认结果

### CLI 方式

查看当前状态：

```bash
codex-provider status
```

同步历史会话到当前 provider：

```bash
codex-provider sync
```

切换到指定 provider 并同步：

```bash
codex-provider switch openai
```

## 命令说明

| 命令 | 说明 |
|------|------|
| `codex-provider status` | 显示当前 provider 及分布 |
| `codex-provider sync` | 同步历史会话到当前 provider |
| `codex-provider switch <provider-id>` | 切换 provider 并同步 |
| `codex-provider restore <backup-dir>` | 从备份恢复 |
| `codex-provider prune-backups` | 清理旧备份 |

## 使用场景

### 场景一：从 API Key 切到官方 OAuth

1. 打开 GUI，点击 **刷新状态**
2. 点击 **同步到 OpenAI 官方 OAuth**
3. 等待完成，日志显示成功
4. 现在可以用官方 OAuth 登录，历史会话都在

### 场景二：从官方 OAuth 切到 API Key

1. 打开 GUI，点击 **刷新状态**
2. 点击 **同步到第三方 API Key**
3. 等待完成
4. 切换到 API Key 登录，历史会话都在

### 场景三：误操作恢复

1. 在 **从备份恢复** 区域输入备份目录路径
2. 点击 **恢复备份**
3. 数据恢复到同步前的状态

## 安全说明

每次同步前，工具都会先自动备份到：

```
~/.codex/backups_state/provider-sync/<timestamp>
```

注意：

- 它不会替换官方 `codex`
- 它不会帮你处理 `auth.json` 或第三方切号工具
- 它不会改消息历史、标题、cwd、时间戳
- 默认自动保留最近 5 份备份
- 如果 `state_5.sqlite` 被占用，**先关闭 Codex App** 再重试
- 如果历史会话包含 `encrypted_content`，跨 provider 后可能只能恢复可见性

## 常见问题

**Q: 同步后 Codex App 里还是看不到会话？**  
A: 请确保同步前已关闭 Codex App，同步完成后再重新打开。

**Q: 可以恢复之前的备份吗？**  
A: 可以，使用 **从备份恢复** 功能，或运行 `codex-provider restore <备份路径>`。

**Q: 支持 Windows 吗？**  
A: CLI 工具支持 Windows。GUI 目前主要面向 macOS，Windows 版本正在开发中。

## 开发

```bash
# 克隆仓库
git clone https://github.com/Friday-Up/codex-provider-sync.git
cd codex-provider-sync

# 运行测试
npm test

# 构建 GUI
cd codex-provider-gui
npm run tauri build
```

## 发布日志

详见 [Releases](https://github.com/Friday-Up/codex-provider-sync/releases) 页面。

## License

MIT

---

由 [Friday Up](https://github.com/Friday-Up) 维护
