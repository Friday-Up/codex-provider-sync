#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_BACKUP_RETENTION_COUNT } from "./constants.js";
import { installWindowsLauncher } from "./launcher.js";
import {
  getStatus,
  renderStatus,
  runPruneBackups,
  runRestore,
  runSwitch,
  runSync,
  runWatch,
  runWatchOnce,
  runCoexist,
  runCoexistCleanup
} from "./service.js";

function printHelp() {
  console.log(`codex-provider

Usage:
  codex-provider status [--codex-home PATH]
  codex-provider sync [--provider ID] [--keep N] [--codex-home PATH]
  codex-provider switch <provider-id> [--keep N] [--codex-home PATH]
  codex-provider watch [--provider ID] [--mode rewrite|coexist] [--codex-home PATH]
  codex-provider watch-once [--provider ID] [--mode rewrite|coexist] [--codex-home PATH]
  codex-provider coexist [--codex-home PATH]
  codex-provider coexist-cleanup [--codex-home PATH]
  codex-provider prune-backups [--keep N] [--codex-home PATH]
  codex-provider restore <backup-dir> [--no-config] [--no-db] [--no-sessions] [--codex-home PATH]
  codex-provider install-windows-launcher [--dir PATH] [--codex-home PATH]
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [flagName, inlineValue] = value.split("=", 2);
    const normalizedName = flagName.slice(2);
    if (inlineValue !== undefined) {
      flags[normalizedName] = inlineValue;
      continue;
    }
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      flags[normalizedName] = nextValue;
      index += 1;
    } else {
      flags[normalizedName] = true;
    }
  }

  return { positionals, flags };
}

function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex 主目录: ${result.codexHome}`,
    `备份目录: ${result.backupDir}`,
    `备份耗时: ${formatDuration(result.backupDurationMs ?? 0)}`,
    `已更新会话文件: ${result.changedSessionFiles} 个`,
    `已更新 SQLite 行数: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (未找到 state_5.sqlite)"}`
  ];
  if (result.skippedLockedRolloutFiles?.length) {
    const preview = result.skippedLockedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedLockedRolloutFiles.length - Math.min(result.skippedLockedRolloutFiles.length, 5);
    lines.push(`跳过锁定的会话文件: ${result.skippedLockedRolloutFiles.length} 个`);
    lines.push(`锁定文件: ${preview}${extraCount > 0 ? ` (+${extraCount} 个更多)` : ""}`);
  }
  if (result.encryptedContentWarning) {
    lines.push(result.encryptedContentWarning);
  }
  if (result.autoPruneResult) {
    lines.push(
      `备份清理: 已删除 ${result.autoPruneResult.deletedCount} 个，剩余 ${result.autoPruneResult.remainingCount} 个，释放 ${formatBytes(result.autoPruneResult.freedBytes)}`
    );
  }
  if (result.autoPruneWarning) {
    lines.push(`备份清理警告: ${result.autoPruneWarning}`);
  }
  return lines.join("\n");
}

function summarizePrune(result) {
  return [
    `备份根目录: ${result.backupRoot}`,
    `已删除备份: ${result.deletedCount} 个`,
    `剩余备份: ${result.remainingCount} 个`,
    `释放空间: ${formatBytes(result.freedBytes)}`
  ].join("\n");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${bytes} B` : `${value.toFixed(value >= 10 ? 1 : 2).replace(/\.0$/, "")} ${units[unitIndex]}`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs ?? 0))} ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0$/, "")} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - (minutes * 60);
  return `${minutes}m ${remainingSeconds.toFixed(remainingSeconds >= 10 ? 0 : 1).replace(/\.0$/, "")}s`;
}

const SYNC_PROGRESS_STAGES = [
  ["scan_rollout_files", "正在扫描会话文件..."],
  ["check_locked_rollout_files", "正在检查锁定的会话文件..."],
  ["create_backup", "正在创建备份..."],
  ["update_sqlite", "正在更新 SQLite 数据库..."],
  ["rewrite_rollout_files", "正在重写会话文件..."],
  ["clean_backups", "正在清理备份..."]
];

const SYNC_PROGRESS_STAGE_INDEX = new Map(
  SYNC_PROGRESS_STAGES.map(([stage], index) => [stage, index + 1])
);

function createSyncProgressReporter() {
  return (event) => {
    if (event?.stage === "update_config" && event.status === "start") {
      console.log(`正在更新 config.toml 的 model_provider 为 ${event.provider}...`);
      return;
    }

    const stageIndex = SYNC_PROGRESS_STAGE_INDEX.get(event?.stage);
    if (!stageIndex || event.status !== "start") {
      if (event?.stage === "create_backup" && event.status === "complete") {
        console.log(`     备份已创建，耗时 ${formatDuration(event.durationMs)}: ${event.backupDir}`);
      }
      return;
    }

    console.log(`[${stageIndex}/${SYNC_PROGRESS_STAGES.length}] ${SYNC_PROGRESS_STAGES[stageIndex - 1][1]}`);
  };
}

function parseKeepCount(rawValue, { allowZero = false } = {}) {
  if (rawValue === undefined) {
    return DEFAULT_BACKUP_RETENTION_COUNT;
  }
  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) {
    const minimum = allowZero ? 0 : 1;
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  const keepCount = Number.parseInt(normalized, 10);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(keepCount) || keepCount < minimum) {
    throw new Error(`Invalid --keep value: ${rawValue}. Expected an integer greater than or equal to ${minimum}.`);
  }
  return keepCount;
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (!command || command === "help" || flags.help) {
    printHelp();
    return;
  }

  if (command === "status") {
    const status = await getStatus({ codexHome: flags["codex-home"] });
    console.log(renderStatus(status));
    return;
  }

  if (command === "sync") {
    const result = await runSync({
      codexHome: flags["codex-home"],
      provider: flags.provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "已同步"));
    return;
  }

  if (command === "switch") {
    const provider = positionals[1] ?? flags.provider;
    const result = await runSwitch({
      codexHome: flags["codex-home"],
      provider,
      keepCount: parseKeepCount(flags.keep),
      onProgress: createSyncProgressReporter()
    });
    console.log(summarizeSync(result, "已切换至"));
    return;
  }

  if (command === "prune-backups") {
    const result = await runPruneBackups({
      codexHome: flags["codex-home"],
      keepCount: parseKeepCount(flags.keep, { allowZero: true })
    });
    console.log(summarizePrune(result));
    return;
  }

  if (command === "restore") {
    const backupDir = positionals[1] ?? flags.backup;
    const result = await runRestore({
      codexHome: flags["codex-home"],
      backupDir,
      restoreConfig: !flags["no-config"],
      restoreDatabase: !flags["no-db"],
      restoreSessions: !flags["no-sessions"]
    });
    console.log(`已从备份恢复: ${path.resolve(backupDir)}`);
    console.log(`Codex 主目录: ${result.codexHome}`);
    console.log(`备份时的 provider: ${result.targetProvider}`);
    return;
  }

  if (command === "watch") {
    const codexHome = flags["codex-home"];
    const mode = flags.mode ?? "rewrite";
    const configPath = path.join(codexHome ?? require("os").homedir() + "/.codex", "config.toml");
    const configText = await fs.promises.readFile(configPath, "utf8").catch(() => "");
    const currentProvider = configText.match(/^model_provider\s*=\s*"([^"]+)"/)?.[1] ?? "openai";
    const targetProvider = flags.provider ?? currentProvider;

    console.log(`正在启动监听模式（${mode === "rewrite" ? "重写" : "共存"}模式）${mode === "rewrite" ? `，目标 provider: ${targetProvider}` : ""}`);
    console.log("按 Ctrl+C 停止监听。");

    const cleanup = await runWatch({
      codexHome,
      targetProvider,
      mode,
      onEvent: (event) => {
        switch (event.type) {
          case "watch_start":
            console.log(`[监听] 正在监控目录: ${event.directory}（${event.mode}模式）`);
            break;
          case "sync_start":
            console.log(`[监听] 检测到新文件: ${event.file}`);
            break;
          case "sync_complete":
            if (event.mode === "coexist") {
              console.log(`[监听] 共存同步完成: 新增 ${event.inserted} 条，删除 ${event.deleted} 条`);
            } else {
              console.log(`[监听] 同步完成: 应用 ${event.applied} 条，跳过 ${event.skipped} 条`);
            }
            break;
          case "sync_error":
            console.error(`[监听] 错误: ${event.error}`);
            break;
        }
      }
    });

    process.on("SIGINT", async () => {
      console.log("\n[监听] 正在停止...");
      await cleanup();
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
    return;
  }

  if (command === "watch-once") {
    const codexHome = flags["codex-home"];
    const mode = flags.mode ?? "rewrite";
    const configPath = path.join(codexHome ?? require("os").homedir() + "/.codex", "config.toml");
    const configText = await fs.promises.readFile(configPath, "utf8").catch(() => "");
    const currentProvider = configText.match(/^model_provider\s*=\s*"([^"]+)"/)?.[1] ?? "openai";
    const targetProvider = flags.provider ?? currentProvider;

    const result = await runWatchOnce({
      codexHome,
      targetProvider,
      mode,
      onEvent: (event) => {
        if (event.type === "scan_complete") {
          if (event.mode === "coexist") {
            console.log(`[单次同步] 共存模式: 新增 ${event.inserted} 条，删除 ${event.deleted} 条`);
          } else {
            console.log(`[单次同步] 扫描完成: ${event.changes} 处变更，应用 ${event.applied} 处，跳过 ${event.locked} 处`);
          }
        }
      }
    });

    if (mode === "coexist") {
      console.log(`单次同步完成: 新增 ${result.inserted} 条，删除 ${result.deleted} 条`);
    } else {
      console.log(`单次同步完成: ${result.changes} 处变更，应用 ${result.applied} 处`);
    }
    return;
  }

  if (command === "coexist") {
    const result = await runCoexist({
      codexHome: flags["codex-home"],
      onProgress: (event) => {
        switch (event.stage) {
          case "scan":
            if (event.status === "complete") {
              console.log(`[共存模式] 发现的 provider: ${event.providers?.join(", ")}`);
              if (event.fileCounts) {
                for (const [provider, count] of Object.entries(event.fileCounts)) {
                  console.log(`[共存模式]   ${provider}: ${count} 个文件`);
                }
              }
            }
            break;
          case "plan":
            if (event.status === "complete") {
              console.log(`[共存模式] 计划: 新增 ${event.toInsert} 条，删除 ${event.toDelete} 条`);
            }
            break;
          case "execute":
            if (event.status === "complete") {
              console.log(`[共存模式] 执行完成: 新增 ${event.inserted} 条，删除 ${event.deleted} 条`);
            }
            break;
        }
      }
    });

    if (result.alreadySynced) {
      console.log("[共存模式] 所有记录已是最新，无需操作。");
    } else {
      console.log(`[共存模式] 完成: 新增 ${result.inserted} 条镜像，删除 ${result.deleted} 条孤立记录`);
      console.log(`[共存模式] 涉及的 provider: ${result.providers.join(", ")}`);
    }
    return;
  }

  if (command === "coexist-cleanup") {
    const result = await runCoexistCleanup({
      codexHome: flags["codex-home"],
      onProgress: (event) => {
        if (event.stage === "cleanup" && event.status === "complete") {
          console.log(`[共存清理] 已删除 ${event.deleted} 条镜像记录`);
        }
      }
    });
    console.log(`[共存清理] 共删除 ${result.deleted} 条镜像记录`);
    return;
  }

  if (command === "install-windows-launcher") {
    const result = await installWindowsLauncher({
      dir: flags.dir,
      codexHome: flags["codex-home"]
    });
    console.log("Windows 启动器安装完成:");
    console.log(`  隐藏式双击启动器: ${result.vbsPath}`);
    console.log(`  可见控制台启动器: ${result.cmdPath}`);
    console.log(`  目标目录: ${result.targetDir}`);
    if (result.codexHome) {
      console.log(`  固定 CODEX_HOME: ${result.codexHome}`);
    } else {
      console.log("  CODEX_HOME: 默认当前环境 / ~/.codex");
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
