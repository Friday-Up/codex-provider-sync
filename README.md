<div align="center">

# Codex Provider Sync

### 在切换 provider 之后，让 Codex 的历史会话重新可见

[![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)]()

</div>

## 解决什么问题

切换 `model_provider` 之后，Codex 的历史会话有时会"消失"。

常见现象：

- `codex resume` 里能看到的会话，到了 Codex App 里不一定还能看到
- 切回官方 `openai` 后，之前在第三方 provider 下的历史会话像没了
- 只改 `sessions/*.jsonl` 不够，因为 SQLite 里还有一层 provider 元数据

`codex-provider-sync` 会把这两层一起同步：

- `~/.codex/sessions` 和 `~/.codex/archived_sessions`
- `~/.codex/state_5.sqlite`

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

### CLI

```bash
cd codex-provider-sync
npm install
codex-provider status
```

### GUI（macOS）

```bash
cd codex-provider-gui
npm install
npm run tauri build
# 构建完成后，app 位于 src-tauri/target/release/bundle/
```

## 快速开始

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

## GUI 使用

1. 打开 `Codex Provider Sync.app`
2. 点击 `Refresh` 查看当前 provider 分布
3. 选择目标同步方向（OpenAI 官方 OAuth 或第三方 API Key）
4. 点击对应按钮执行同步
5. 查看底部日志确认结果

## 命令说明

- `codex-provider status` - 显示当前 provider 及分布
- `codex-provider sync` - 同步历史会话到当前 provider
- `codex-provider switch <provider-id>` - 切换 provider 并同步
- `codex-provider restore <backup-dir>` - 从备份恢复
- `codex-provider prune-backups` - 清理旧备份

## 安全说明

每次同步前，工具都会先备份到：

```
~/.codex/backups_state/provider-sync/<timestamp>
```

注意：

- 它不会替换官方 `codex`
- 它不会帮你处理 `auth.json` 或第三方切号工具
- 它不会改消息历史、标题、cwd、时间戳
- 默认自动保留最近 5 份备份
- 如果 `state_5.sqlite` 被占用，先关闭 Codex App 再重试
- 如果历史会话包含 `encrypted_content`，跨 provider 后可能只能恢复可见性

## License

MIT
