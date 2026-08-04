# 变更说明（CHANGELOG）

> 分支：`dsv4f-repair`（未发布，对应下次 Release）
>
> 本次变更围绕三件事：修复 Windows 平台启动与运行问题、支持自由选择同步方向、解决切换 provider 后续会话的模型不匹配报错。

---

## 一、Windows 启动闪退与兼容性修复

### 问题

- Windows 默认没有 `HOME` 环境变量（只有 `USERPROFILE`），后端命令直接 `unwrap()` 导致 panic；前端启动后自动调用 `get_status`，进程静默退出（闪退）。
- `resolve_node_path()` 按 `\` 分割 PATH（Windows 应为 `;`），且查找的是 `node` 而不是 `node.exe`。
- Windows `canonicalize()` 返回带 `\\?\` 前缀的扩展路径，Node.js CJS 加载器无法解析，报 `EISDIR: lstat 'D:'`。
- 打包后的安装包没有内置 CLI 源码，命令找不到 `cli.js`；资源路径层级写错，Tauri 会把 `..` 转为 `_up_` 目录。

### 修复

- 新增跨平台 `home_dir()`：Windows 优先 `USERPROFILE`，macOS/Linux 取 `HOME`；所有命令不再 `unwrap()`，改为返回可读错误。
- Node 查找改用 `std::env::split_paths`，按平台查找 `node.exe` / `node`，并补充 Windows nvm、`Program Files\nodejs` 兜底。
- Windows 下去掉 `\\?\` 前缀后再传给 node。
- 通过 `tauri.conf.json` 的 `resources` 把 CLI 源码打进安装包，运行时用 `resource_dir()` 定位（兼容 `_up_/_up_` 布局）。
- `tauri build` 改用 GNU 目标 + `+crt-static`，产物只依赖系统 DLL。

涉及文件：`codex-provider-gui/src-tauri/src/main.rs`、`codex-provider-gui/src-tauri/tauri.conf.json`、`codex-provider-gui/src-tauri/Cargo.lock`

---

## 二、自由选择来源与目标 Provider

### 新能力

- CLI：`codex-provider sync --from <来源> --to <目标>`，只把指定来源的会话迁移到目标 provider；不传 `--from` 则保持原"全部会话"行为（`--provider` 兼容旧用法）。
- GUI：同步区域改为"来源 provider → 目标 provider"两个下拉框（含"全部"选项），自动从状态中读取已配置的 provider；新增"目标模型（可选）"输入框。

### 实现

- `collectSessionChanges` 支持 `sourceProvider` 过滤，只收集指定来源的会话文件。
- `updateSqliteProvider` 按来源构造 SQL，只更新对应 provider 的行（`(missing)` 对应 SQLite 的 NULL/空值）。
- 备份元数据记录来源 provider；`sync` 结果包含来源信息。

涉及文件：`codex-provider-sync/src/cli.js`、`src/service.js`、`src/session-files.js`、`src/sqlite-state.js`、`src/backup.js`、`codex-provider-gui/src/index.html`、`src/main.js`、`src-tauri/src/main.rs`

---

## 三、一键备份与备份选择

### 一键备份

- CLI：`codex-provider backup [--keep N]`，快照 config.toml + SQLite（含 -shm/-wal）+ 全部会话文件首行元数据到 `~/.codex/backups_state/provider-sync/<时间戳>/`，备份类型标记为"手动一键备份"。
- GUI：备份与恢复区域新增"一键备份"按钮。
- 备份元数据新增 `backupType`（`manual` / `sync`），恢复时区分显示。

### 恢复备份下拉选择

- CLI：`codex-provider list-backups [--json]` 列出历史备份（时间、类型、会话文件数、占用空间），GUI 下拉框的数据来源。
- GUI：恢复区域改为下拉框选择历史备份（自动刷新），同时保留手动输入路径的选项。

涉及文件：`codex-provider-sync/src/backup.js`、`src/service.js`、`src/cli.js`、`codex-provider-gui/src-tauri/src/main.rs`、`src/index.html`、`src/main.js`、`src/styles.css`

---

## 四、跨 Provider 模型重映射（修复续会话报错）

### 问题

切换 provider 后继续历史会话时报错，例如：

```text
The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed gpt-5.6-sol.
```

原因：会话文件里的 `turn_context.payload.model`、`thread_settings.model/model_provider_id`，以及 SQLite `threads` 表的 `model` 列，仍保留原 provider 的模型名；Codex 续会话时把它发给新 provider 的 API，被拒绝。

### 修复

- 同步时按目标模型改写上述两层数据：
  - 会话文件：`turn_context.payload.model`、`thread_settings.model`（含 `model_provider_id`）改写为目标 provider 的模型。
  - SQLite：`threads.model` 列同步改写为目标模型。
- 目标模型解析优先级：`--model <模型>` > `[model_providers.<目标>].model` > 根级 `model`（仅当根级 `model_provider` 就是目标时）。
- `--repair-models`：额外修复已经标记为目标 provider、但模型字段不匹配的会话（文件层 + SQLite 层）。
- 备份/恢复支持模型字段的完整还原；Windows 批量改写脚本修复了 `@($null)` 导致首行被清空的问题。
- GUI：同步区域新增"同时修复已为目标 provider 的会话模型"复选框。

涉及文件：`codex-provider-sync/src/config-file.js`、`src/session-files.js`、`src/sqlite-state.js`、`src/service.js`、`src/cli.js`、`src/backup.js`、`codex-provider-gui/src-tauri/src/main.rs`、`src/index.html`、`src/main.js`

---

## 五、其他修复

- GUI 恢复备份参数改为 camelCase（`backupDir`），修复 Tauri v2 下"missing required key backupDir"报错。
- CLI 测试文案与中文输出对齐，`npm test` 全量通过（42/42）。
- `Cargo.lock` 版本与 `Cargo.toml` 对齐（1.0.1）。
- 新增 `codex-provider-gui/src-tauri/gen/schemas/windows-schema.json`（Windows 构建生成的 schema）。

---

## 验证

- CLI 测试：`npm test` 42/42 通过（含来源过滤、模型改写、修复模式、备份/恢复、列表等用例）。
- Windows 实测：应用启动不再闪退；`node` 收到干净的绝对路径；备份、恢复、`list-backups` 输出正常。
- 使用真实 `state_5.sqlite` 副本验证：`gpt-5.6-sol` 等旧模型名被改写为 `deepseek-v4-flash`，无剩余 `gpt*` 模型行。

## 使用示例

```bash
# 只把 custom 会话迁移到 deepseek，并改写模型
codex-provider sync --from custom --to deepseek --model deepseek-v4-flash

# 修复已标记为 deepseek 但模型不匹配的历史会话（文件 + SQLite 两层）
codex-provider sync --provider deepseek --repair-models

# 一键备份 / 查看备份 / 恢复
codex-provider backup
codex-provider list-backups
codex-provider restore <备份目录>
```
