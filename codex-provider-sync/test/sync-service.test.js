import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createBackup,
  getBackupSummary,
  pruneBackups,
  restoreBackup,
  updateSessionBackupManifest
} from "../src/backup.js";
import { getStatus, renderStatus, runBackup, runListBackups, runRestore, runSwitch, runSync } from "../src/service.js";
import { DEFAULT_BACKUP_RETENTION_COUNT } from "../src/constants.js";
import { applySessionChanges, collectSessionChanges } from "../src/session-files.js";
import { readSqliteProviderCounts } from "../src/sqlite-state.js";
import { resolveProviderModel } from "../src/config-file.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-sync-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(path.join(codexHome, "sessions", "2026", "03", "19"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "archived_sessions", "2026", "03", "18"), { recursive: true });
  return { root, codexHome };
}

async function writeRollout(filePath, id, provider) {
  const payload = {
    id,
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message: "hi" } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeCustomRollout(filePath, payload, message = "hi") {
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeRolloutWithModel(filePath, id, provider, model) {
  const payload = {
    id,
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({
      timestamp: payload.timestamp,
      type: "event_msg",
      payload: {
        type: "thread_settings",
        thread_settings: {
          model,
          model_provider_id: provider,
          reasoning_effort: "high"
        }
      }
    }),
    JSON.stringify({
      timestamp: payload.timestamp,
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: payload.cwd,
        model,
        effort: "high",
        summary: "包含中文与 Unicode 内容 ✓ 保持不变"
      }
    }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message: "hi" } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function backupRoot(codexHome) {
  return path.join(codexHome, "backups_state", "provider-sync");
}

async function writeBackup(codexHome, directoryName, files) {
  const backupDir = path.join(backupRoot(codexHome), directoryName);
  await fs.mkdir(backupDir, { recursive: true });
  let totalBytes = 0;
  if (!files.some(([relativePath]) => relativePath === "metadata.json")) {
    const metadataPath = path.join(backupDir, "metadata.json");
    const metadataContent = JSON.stringify({
      version: 1,
      namespace: "provider-sync",
      codexHome,
      targetProvider: "openai",
      createdAt: "2026-03-24T00:00:00.000Z",
      dbFiles: [],
      changedSessionFiles: 0
    }, null, 2);
    await fs.writeFile(metadataPath, metadataContent, "utf8");
    const metadataStat = await fs.stat(metadataPath);
    totalBytes += metadataStat.size;
  }
  for (const [relativePath, content] of files) {
    const fullPath = path.join(backupDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    const stat = await fs.stat(fullPath);
    totalBytes += stat.size;
  }
  return totalBytes;
}

async function writeConfig(codexHome, modelProviderLine = "") {
  const config = `${modelProviderLine}${modelProviderLine ? "\n" : ""}sandbox_mode = "danger-full-access"\n\n[model_providers.apigather]\nbase_url = "https://example.com"\n`;
  await fs.writeFile(path.join(codexHome, "config.toml"), config, "utf8");
}

async function writeStateDb(codexHome, rows) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        model_provider TEXT,
        model TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        first_user_message TEXT NOT NULL DEFAULT ''
      )
    `);
    const stmt = db.prepare("INSERT INTO threads (id, model_provider, model, archived, first_user_message) VALUES (?, ?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(row.id, row.model_provider, row.model ?? null, row.archived ? 1 : 0, row.first_user_message ?? "hello");
    }
  } finally {
    db.close();
  }
}

function readThreadModels(codexHome) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return Object.fromEntries(
      db.prepare("SELECT id, model FROM threads").all().map((row) => [row.id, row.model])
    );
  } finally {
    db.close();
  }
}

async function lockRolloutFile(filePath, shareMode = "None") {
  const script = `
& {
  param([string]$path, [string]$shareMode)
  $share = [System.Enum]::Parse([System.IO.FileShare], $shareMode)
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, $share)
  try {
    Write-Output 'locked'
    [Console]::Out.Flush()
    Start-Sleep -Seconds 30
  } finally {
    $stream.Close()
  }
}
`.trim();

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    filePath,
    shareMode
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("locked")) {
        settled = true;
        resolve();
      }
    });

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to acquire rollout file lock. Exit code: ${code ?? "null"}, signal: ${signal ?? "null"}`));
      }
    });
  });

  return child;
}

async function runCli(args) {
  const cliPath = path.resolve("src", "cli.js");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("runSync rewrites rollout files and sqlite, then restore reverts both", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "newapi");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "newapi", archived: true }
  ]);

  const syncResult = await runSync({ codexHome });
  assert.equal(syncResult.targetProvider, "openai");
  assert.equal(typeof syncResult.backupDurationMs, "number");
  assert.ok(syncResult.backupDurationMs >= 0);
  assert.equal(syncResult.changedSessionFiles, 2);
  assert.deepEqual(syncResult.skippedLockedRolloutFiles, []);
  assert.equal(syncResult.sqliteRowsUpdated, 2);

  const syncedSession = await fs.readFile(sessionPath, "utf8");
  const syncedArchived = await fs.readFile(archivedPath, "utf8");
  assert.match(syncedSession, /"model_provider":"openai"/);
  assert.match(syncedArchived, /"model_provider":"openai"/);

  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    const providers = db
      .prepare("SELECT id, model_provider FROM threads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(providers, [
      { id: "thread-a", model_provider: "openai" },
      { id: "thread-b", model_provider: "openai" }
    ]);
  } finally {
    db.close();
  }

  await runRestore({ codexHome, backupDir: syncResult.backupDir });

  const restoredSession = await fs.readFile(sessionPath, "utf8");
  const restoredArchived = await fs.readFile(archivedPath, "utf8");
  assert.match(restoredSession, /"model_provider":"apigather"/);
  assert.match(restoredArchived, /"model_provider":"newapi"/);
});

test("runSync reports stage progress and backup duration", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const progressEvents = [];
  const result = await runSync({
    codexHome,
    onProgress(event) {
      progressEvents.push(event);
    }
  });

  assert.ok(result.backupDurationMs >= 0);
  assert.deepEqual(
    progressEvents
      .filter((event) => event.status === "start")
      .map((event) => event.stage),
    [
      "scan_rollout_files",
      "check_locked_rollout_files",
      "create_backup",
      "update_sqlite",
      "rewrite_rollout_files",
      "clean_backups"
    ]
  );

  const backupCompleteEvent = progressEvents.find((event) => event.stage === "create_backup" && event.status === "complete");
  assert.ok(backupCompleteEvent);
  assert.equal(backupCompleteEvent.backupDir, result.backupDir);
  assert.ok(backupCompleteEvent.durationMs >= 0);
});

test("runSwitch updates config and syncs provider metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false }
  ]);

  const result = await runSwitch({ codexHome, provider: "apigather" });
  assert.equal(result.targetProvider, "apigather");

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "apigather"/m);
  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
});

test("status reports implicit default provider and rollout/sqlite counts", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "openai");
  const backupOneBytes = await writeBackup(codexHome, "20260319T000000000Z", [["note.txt", "backup-one"]]);
  const backupTwoBytes = await writeBackup(codexHome, "20260320T000000000Z", [["note.txt", "backup-two"]]);
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "openai", archived: true }
  ]);

  const status = await getStatus({ codexHome });
  assert.equal(status.currentProvider, "openai");
  assert.equal(status.currentProviderImplicit, true);
  assert.deepEqual(status.rolloutCounts.sessions, { apigather: 1 });
  assert.deepEqual(status.sqliteCounts.archived_sessions, { openai: 1 });
  assert.equal(status.backupSummary.count, 2);
  assert.equal(status.backupSummary.totalBytes, backupOneBytes + backupTwoBytes);
});

test("runSwitch rejects unknown custom providers", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await assert.rejects(
    () => runSwitch({ codexHome, provider: "missing" }),
    /Provider "missing" is not available/
  );
});

test("runSync leaves rollout files and sqlite untouched when sqlite is locked", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const lockDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => runSync({ codexHome, sqliteBusyTimeoutMs: 0 }),
      /state_5\.sqlite is currently in use/
    );
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures in tests.
    }
    lockDb.close();
  }

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }
});

test("runSync skips locked rollout files and still updates sqlite", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const lockProcess = await lockRolloutFile(sessionPath);
  let result;
  try {
    result = await runSync({ codexHome, sqliteBusyTimeoutMs: 0 });
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }

  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 1);
  assert.deepEqual(result.skippedLockedRolloutFiles, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "openai");
  } finally {
    db.close();
  }
});

test("applySessionChanges skips rollout files that changed after collection", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  await fs.appendFile(
    sessionPath,
    '{"timestamp":"2026-03-19T00:00:01.000Z","type":"event_msg","payload":{"type":"assistant_message","message":"later"}}\n',
    "utf8"
  );

  const result = await applySessionChanges(changes);
  assert.equal(result.appliedChanges, 0);
  assert.deepEqual(result.skippedPaths, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
  assert.match(rollout, /"message":"later"/);
});

test("applySessionChanges preserves large UTF-8 session metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-large.jsonl");
  const payload = {
    id: "thread-large",
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp\\中文",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: "apigather",
    title: "中文会话",
    note: "保留 UTF-8 内容",
    large_blob: "数据块".repeat(40000)
  };
  await writeCustomRollout(sessionPath, payload, "你好");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const result = await applySessionChanges(changes);

  assert.equal(result.appliedChanges, 1);
  assert.deepEqual(result.skippedPaths, []);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"openai"/);
  assert.match(rollout, /"title":"中文会话"/);
  assert.match(rollout, /"note":"保留 UTF-8 内容"/);
  assert.match(rollout, /"message":"你好"/);
  assert.match(rollout, /"large_blob":"数据块数据块/);
});

test("applySessionChanges restores original rollout mtime", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-mtime.jsonl");
  await writeRollout(sessionPath, "thread-mtime", "apigather");
  const originalTime = new Date("2026-01-02T03:04:05.000Z");
  await fs.utimes(sessionPath, originalTime, originalTime);

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const result = await applySessionChanges(changes);

  assert.equal(result.appliedChanges, 1);
  const stat = await fs.stat(sessionPath);
  assert.equal(Math.round(stat.mtimeMs), originalTime.getTime());
});

test("collectSessionChanges reports encrypted_content counts by provider and scope", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-enc.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-enc-archived.jsonl");
  await writeRollout(sessionPath, "thread-enc", "apigather");
  await fs.appendFile(sessionPath, '{"type":"event_msg","payload":{"encrypted_content":"gAAA"}}\n', "utf8");
  await writeRollout(archivedPath, "thread-enc-archived", "openai");
  await fs.appendFile(archivedPath, '{"type":"event_msg","payload":{"encrypted_content":"gBBB"}}\n', "utf8");

  const { encryptedContentCounts } = await collectSessionChanges(codexHome, "openai");

  assert.deepEqual(encryptedContentCounts, {
    sessions: { apigather: 1 },
    archived_sessions: { openai: 1 }
  });
});

test("applySessionChanges skips only the rollout file that becomes locked on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const lockedPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-locked.jsonl");
  const writablePath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-writable.jsonl");
  await writeRollout(lockedPath, "thread-locked", "apigather");
  await writeRollout(writablePath, "thread-writable", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const lockProcess = await lockRolloutFile(lockedPath);
  let result;
  try {
    result = await applySessionChanges(changes);
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }

  assert.equal(result.appliedChanges, 1);
  assert.deepEqual(result.appliedPaths, [writablePath]);
  assert.deepEqual(result.skippedPaths, [lockedPath]);

  const lockedRollout = await fs.readFile(lockedPath, "utf8");
  const writableRollout = await fs.readFile(writablePath, "utf8");
  assert.match(lockedRollout, /"model_provider":"apigather"/);
  assert.match(writableRollout, /"model_provider":"openai"/);
});

test("restoreBackup only restores rollout files that were actually applied", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const configPath = path.join(codexHome, "config.toml");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  const backupDir = await createBackup({
    codexHome,
    targetProvider: "openai",
    sessionChanges: changes,
    configPath
  });

  await updateSessionBackupManifest(backupDir, []);
  await writeRollout(sessionPath, "thread-a", "manual");

  await restoreBackup(backupDir, codexHome, {
    restoreConfig: false,
    restoreDatabase: false,
    restoreSessions: true
  });

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"manual"/);
});

test("restoreBackup can skip config, database, and sessions", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const configPath = path.join(codexHome, "config.toml");
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-skip.jsonl");
  await writeRollout(sessionPath, "thread-skip", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-skip", model_provider: "apigather", archived: false }
  ]);
  const { changes } = await collectSessionChanges(codexHome, "openai");
  const backupDir = await createBackup({ codexHome, targetProvider: "openai", sessionChanges: changes, configPath });

  await writeConfig(codexHome, 'model_provider = "manual"');
  await writeRollout(sessionPath, "thread-skip", "manual");
  await restoreBackup(backupDir, codexHome, {
    restoreConfig: false,
    restoreDatabase: false,
    restoreSessions: false
  });

  assert.match(await fs.readFile(configPath, "utf8"), /^model_provider = "manual"/m);
  assert.match(await fs.readFile(sessionPath, "utf8"), /"model_provider":"manual"/);
});

test("runSync fails before rollout rewrite when SQLite is malformed", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-malformed-db.jsonl");
  await writeRollout(sessionPath, "thread-malformed", "apigather");
  await fs.writeFile(path.join(codexHome, "state_5.sqlite"), "not sqlite", "utf8");

  await assert.rejects(
    () => runSync({ codexHome }),
    /state_5\.sqlite is malformed or unreadable/
  );
  assert.match(await fs.readFile(sessionPath, "utf8"), /"model_provider":"apigather"/);
});

test("status reports malformed SQLite without failing", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeRollout(path.join(codexHome, "sessions", "2026", "03", "19", "rollout-status-db.jsonl"), "thread-status", "openai");
  await fs.writeFile(path.join(codexHome, "state_5.sqlite"), "not sqlite", "utf8");

  const status = await getStatus({ codexHome });
  assert.equal(status.sqliteCounts.unreadable, true);
  assert.match(renderStatus(status), /state_5\.sqlite is malformed or unreadable/);
});

test("status skips locked rollout files without failing", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-status-locked.jsonl");
  await writeRollout(sessionPath, "thread-status-locked", "openai");

  const lockProcess = await lockRolloutFile(sessionPath);
  try {
    const status = await getStatus({ codexHome });
    assert.deepEqual(status.lockedRolloutFiles, [sessionPath]);
    assert.match(renderStatus(status), /跳过的锁定文件: 1 个/);
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }
});

test("pruneBackups removes the oldest backup directories", async () => {
  const { codexHome } = await makeTempCodexHome();
  const oldestBytes = await writeBackup(codexHome, "20260319T000000000Z", [
    ["note.txt", "oldest"],
    ["db/state_5.sqlite", "sqlite"]
  ]);
  await writeBackup(codexHome, "20260320T000000000Z", [["note.txt", "middle"]]);
  await writeBackup(codexHome, "20260321T000000000Z", [["note.txt", "newest"]]);

  const result = await pruneBackups(codexHome, 2);

  assert.equal(result.backupRoot, backupRoot(codexHome));
  assert.equal(result.deletedCount, 1);
  assert.equal(result.remainingCount, 2);
  assert.equal(result.freedBytes, oldestBytes);
  await assert.rejects(fs.access(path.join(backupRoot(codexHome), "20260319T000000000Z")));
  await fs.access(path.join(backupRoot(codexHome), "20260320T000000000Z"));
  await fs.access(path.join(backupRoot(codexHome), "20260321T000000000Z"));
});

test("pruneBackups ignores directories without managed backup metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeBackup(codexHome, "20260320T000000000Z", [
    ["metadata.json", JSON.stringify({ namespace: "provider-sync" })]
  ]);
  const junkDirectory = path.join(backupRoot(codexHome), "manual-notes");
  await fs.mkdir(junkDirectory, { recursive: true });
  await fs.writeFile(path.join(junkDirectory, "readme.txt"), "keep me", "utf8");

  const result = await pruneBackups(codexHome, 0);

  assert.equal(result.deletedCount, 1);
  assert.equal(result.remainingCount, 0);
  await fs.access(junkDirectory);
});

test("runSync auto-prunes backups to the default retention count", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  for (let index = 0; index < DEFAULT_BACKUP_RETENTION_COUNT; index += 1) {
    await writeBackup(codexHome, `20240101T0000${String(index).padStart(2, "0")}000Z`, [
      ["note.txt", `backup-${index}`]
    ]);
  }

  const result = await runSync({ codexHome });
  const summary = await getBackupSummary(codexHome);

  assert.equal(summary.count, DEFAULT_BACKUP_RETENTION_COUNT);
  await fs.access(result.backupDir);
  assert.equal(result.autoPruneResult.deletedCount, 1);
  assert.equal(result.autoPruneResult.remainingCount, DEFAULT_BACKUP_RETENTION_COUNT);
  assert.equal(result.autoPruneWarning, null);
});

test("runSync uses a custom automatic backup retention count", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  for (let index = 0; index < 4; index += 1) {
    await writeBackup(codexHome, `20240101T0000${String(index).padStart(2, "0")}000Z`, [
      ["note.txt", `backup-${index}`]
    ]);
  }

  const result = await runSync({ codexHome, keepCount: 2 });
  const summary = await getBackupSummary(codexHome);

  assert.equal(summary.count, 2);
  await fs.access(result.backupDir);
  assert.equal(result.autoPruneResult.deletedCount, 3);
  assert.equal(result.autoPruneResult.remainingCount, 2);
  assert.equal(result.autoPruneWarning, null);
});

test("collectSessionChanges filters changes by source provider", async () => {
  const { codexHome } = await makeTempCodexHome();
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-src-filter-openai.jsonl");
  const customPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-src-filter-custom.jsonl");
  await writeRollout(openaiPath, "src-filter-openai", "openai");
  await writeRollout(customPath, "src-filter-custom", "custom");

  const all = await collectSessionChanges(codexHome, "deepseek", {});
  assert.equal(all.changes.length, 2);

  const fromOpenai = await collectSessionChanges(codexHome, "deepseek", { sourceProvider: "openai" });
  assert.equal(fromOpenai.changes.length, 1);
  assert.equal(fromOpenai.changes[0].originalProvider, "openai");
  assert.equal(fromOpenai.providerCounts.sessions.get("openai"), 1);
  assert.equal(fromOpenai.providerCounts.sessions.has("custom"), false);

  const fromMissing = await collectSessionChanges(codexHome, "deepseek", { sourceProvider: "(missing)" });
  assert.equal(fromMissing.changes.length, 0);
});

test("runSync with sourceProvider converts only matching sessions", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-src-openai.jsonl");
  const customPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-src-custom.jsonl");
  await writeRollout(openaiPath, "src-openai", "openai");
  await writeRollout(customPath, "src-custom", "custom");
  await writeStateDb(codexHome, [
    { id: "src-openai", model_provider: "openai", archived: false },
    { id: "src-custom", model_provider: "custom", archived: false }
  ]);

  const result = await runSync({ codexHome, provider: "deepseek", sourceProvider: "openai" });

  assert.equal(result.targetProvider, "deepseek");
  assert.equal(result.sourceProvider, "openai");
  assert.equal(result.changedSessionFiles, 1);
  assert.equal(result.sqliteRowsUpdated, 1);

  const openaiText = await fs.readFile(openaiPath, "utf8");
  const customText = await fs.readFile(customPath, "utf8");
  assert.match(openaiText, /"model_provider":"deepseek"/);
  assert.match(customText, /"model_provider":"custom"/);

  const sqliteCounts = await readSqliteProviderCounts(codexHome);
  assert.deepEqual(sqliteCounts.sessions, { custom: 1, deepseek: 1 });
});

test("cli sync --from/--to converts only the selected source", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-cli-src-openai.jsonl");
  const customPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-cli-src-custom.jsonl");
  await writeRollout(openaiPath, "cli-src-openai", "openai");
  await writeRollout(customPath, "cli-src-custom", "custom");

  const result = await runCli(["sync", "--from", "openai", "--to", "deepseek", "--codex-home", codexHome]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /已同步 provider: deepseek/);
  assert.match(result.stdout, /同步范围: 仅 openai 的会话/);
  assert.match(result.stdout, /已更新会话文件: 1 个/);

  const openaiText = await fs.readFile(openaiPath, "utf8");
  const customText = await fs.readFile(customPath, "utf8");
  assert.match(openaiText, /"model_provider":"deepseek"/);
  assert.match(customText, /"model_provider":"custom"/);
});

test("resolveProviderModel prefers explicit, then provider section, then root model", () => {
  const configText = [
    'model_provider = "deepseek"',
    'model = "deepseek-v4-flash"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
    'model = "custom-model"',
    ""
  ].join("\n");

  assert.equal(resolveProviderModel(configText, "custom", "explicit-model"), "explicit-model");
  assert.equal(resolveProviderModel(configText, "custom"), "custom-model");
  assert.equal(resolveProviderModel(configText, "deepseek"), "deepseek-v4-flash");
  assert.equal(resolveProviderModel(configText, "openai"), null);
});

test("collectSessionChanges collects model line updates for target provider", async () => {
  const { codexHome } = await makeTempCodexHome();
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-model-openai.jsonl");
  const customPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-model-custom.jsonl");
  await writeRolloutWithModel(openaiPath, "model-openai", "openai", "gpt-5.6-sol");
  await writeRolloutWithModel(customPath, "model-custom", "custom", "deepseek-chat");

  const result = await collectSessionChanges(codexHome, "deepseek", {
    targetModel: "deepseek-v4-flash",
    sourceProvider: "openai"
  });

  const change = result.changes.find((entry) => entry.path === openaiPath);
  assert.ok(change);
  assert.ok(change.modelLineUpdates.length >= 2);
  const turnUpdate = change.modelLineUpdates.find((update) => update.text.includes("turn_context"));
  assert.match(turnUpdate.text, /"model":"deepseek-v4-flash"/);
  assert.match(turnUpdate.text, /包含中文与 Unicode 内容/);
  const settingsUpdate = change.modelLineUpdates.find((update) => update.text.includes("thread_settings"));
  assert.match(settingsUpdate.text, /"model":"deepseek-v4-flash"/);
  assert.match(settingsUpdate.text, /"model_provider_id":"deepseek"/);

  const customChange = result.changes.find((entry) => entry.path === customPath);
  assert.equal(customChange, undefined);
});

test("runSync rewrites model fields and restore reverts them", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "deepseek"\nmodel = "deepseek-v4-flash"');
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-sync-model-openai.jsonl");
  await writeRolloutWithModel(openaiPath, "sync-model-openai", "openai", "gpt-5.6-sol");
  await writeStateDb(codexHome, [
    { id: "sync-model-openai", model_provider: "openai", model: "gpt-5.6-sol", archived: false }
  ]);

  const result = await runSync({ codexHome, provider: "deepseek", model: "deepseek-v4-flash" });

  assert.equal(result.targetModel, "deepseek-v4-flash");
  assert.equal(result.modelRewrittenSessionFiles, 1);
  assert.equal((await readThreadModels(codexHome))["sync-model-openai"], "deepseek-v4-flash");
  const syncedText = await fs.readFile(openaiPath, "utf8");
  assert.match(syncedText, /"model":"deepseek-v4-flash"/);
  assert.match(syncedText, /"model_provider_id":"deepseek"/);
  assert.doesNotMatch(syncedText, /gpt-5\.6-sol/);

  await runRestore({ codexHome, backupDir: result.backupDir });
  const restoredText = await fs.readFile(openaiPath, "utf8");
  assert.match(restoredText, /"model":"gpt-5\.6-sol"/);
  assert.match(restoredText, /"model_provider_id":"openai"/);
  assert.equal((await readThreadModels(codexHome))["sync-model-openai"], "gpt-5.6-sol");
});

test("runSync with repairModels fixes model fields of sessions already at the target provider", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "deepseek"\nmodel = "deepseek-v4-flash"');
  const deepseekPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-repair-deepseek.jsonl");
  await writeRolloutWithModel(deepseekPath, "repair-deepseek", "deepseek", "gpt-5.6-sol");
  await writeStateDb(codexHome, [
    { id: "repair-deepseek", model_provider: "deepseek", model: "gpt-5.6-sol", archived: false }
  ]);

  const withoutRepair = await runSync({ codexHome, provider: "deepseek" });
  assert.equal(withoutRepair.changedSessionFiles, 0);
  assert.equal((await readThreadModels(codexHome))["repair-deepseek"], "gpt-5.6-sol");
  let text = await fs.readFile(deepseekPath, "utf8");
  assert.match(text, /"model":"gpt-5\.6-sol"/);

  const withRepair = await runSync({ codexHome, provider: "deepseek", repairModels: true });
  assert.equal(withRepair.modelRewrittenSessionFiles, 1);
  assert.equal((await readThreadModels(codexHome))["repair-deepseek"], "deepseek-v4-flash");
  text = await fs.readFile(deepseekPath, "utf8");
  assert.match(text, /"model":"deepseek-v4-flash"/);
  assert.doesNotMatch(text, /gpt-5\.6-sol/);
});

test("cli sync --model --repair-models rewrites models", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "deepseek"\nmodel = "deepseek-v4-flash"');
  const deepseekPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-cli-repair.jsonl");
  await writeRolloutWithModel(deepseekPath, "cli-repair", "deepseek", "gpt-5.6-sol");

  const result = await runCli([
    "sync",
    "--provider",
    "deepseek",
    "--model",
    "deepseek-v4-pro",
    "--repair-models",
    "--codex-home",
    codexHome
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /目标模型: deepseek-v4-pro/);
  assert.match(result.stdout, /模型已重写: 1 个会话/);
  const text = await fs.readFile(deepseekPath, "utf8");
  assert.match(text, /"model":"deepseek-v4-pro"/);
});

test("runBackup snapshots config, sqlite and all session files, then restore reverts state", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const openaiPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-backup-openai.jsonl");
  const customPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-backup-custom.jsonl");
  await writeRollout(openaiPath, "backup-openai", "openai");
  await writeRollout(customPath, "backup-custom", "custom");
  await writeStateDb(codexHome, [
    { id: "backup-openai", model_provider: "openai", archived: false },
    { id: "backup-custom", model_provider: "custom", archived: false }
  ]);

  const backupResult = await runBackup({ codexHome });

  assert.equal(backupResult.backupType, "manual");
  assert.equal(backupResult.sessionFilesSnapshot, 2);
  await fs.access(backupResult.backupDir);

  await runSync({ codexHome, provider: "deepseek" });
  const syncedOpenaiText = await fs.readFile(openaiPath, "utf8");
  assert.match(syncedOpenaiText, /"model_provider":"deepseek"/);

  await runRestore({ codexHome, backupDir: backupResult.backupDir });

  const openaiText = await fs.readFile(openaiPath, "utf8");
  const customText = await fs.readFile(customPath, "utf8");
  assert.match(openaiText, /"model_provider":"openai"/);
  assert.match(customText, /"model_provider":"custom"/);

  const sqliteCounts = await readSqliteProviderCounts(codexHome);
  assert.deepEqual(sqliteCounts.sessions, { custom: 1, openai: 1 });
});

test("cli backup creates a manual backup", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-cli-backup.jsonl");
  await writeRollout(sessionPath, "cli-backup", "openai");

  const result = await runCli(["backup", "--codex-home", codexHome]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /备份类型: 手动一键备份/);
  assert.match(result.stdout, /会话文件快照: 1 个/);
  assert.match(result.stdout, /备份目录: /);
});

test("runListBackups lists backups with type and metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeRollout(
    path.join(codexHome, "sessions", "2026", "03", "19", "rollout-list-backups.jsonl"),
    "list-backups",
    "openai"
  );

  const manualBackup = await runBackup({ codexHome });
  await writeBackup(codexHome, "20260101T000000000Z", [["note.txt", "old"]]);

  const result = await runListBackups({ codexHome });

  assert.equal(result.backups.length, 2);
  assert.equal(result.backups[0].fullPath, manualBackup.backupDir);
  assert.equal(result.backups[0].backupType, "manual");
  assert.equal(result.backups[0].changedSessionFiles, 1);
  assert.equal(result.backups[1].backupType, "sync");
  assert.equal(result.backups[1].name, "20260101T000000000Z");
});

test("cli list-backups --json returns parseable backup entries", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  await writeRollout(
    path.join(codexHome, "sessions", "2026", "03", "19", "rollout-cli-list-backups.jsonl"),
    "cli-list-backups",
    "openai"
  );
  await runBackup({ codexHome });

  const result = await runCli(["list-backups", "--json", "--codex-home", codexHome]);

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].backupType, "manual");
  assert.equal(parsed[0].changedSessionFiles, 1);
});

test("cli rejects non-integer keep values", async () => {
  const result = await runCli(["prune-backups", "--keep", "1.5"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid --keep value: 1\.5/);
});

test("cli sync prints stage progress and backup timing", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const result = await runCli(["sync", "--codex-home", codexHome]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[1\/6\] 正在扫描会话文件\.\.\./);
  assert.match(result.stdout, /\[2\/6\] 正在检查锁定的会话文件\.\.\./);
  assert.match(result.stdout, /\[3\/6\] 正在创建备份\.\.\./);
  assert.match(result.stdout, /\[4\/6\] 正在更新 SQLite 数据库\.\.\./);
  assert.match(result.stdout, /\[5\/6\] 正在重写会话文件\.\.\./);
  assert.match(result.stdout, /\[6\/6\] 正在清理备份\.\.\./);
  assert.match(result.stdout, /备份已创建，耗时 .*: .+/);
  assert.match(result.stdout, /备份耗时: /);
});
