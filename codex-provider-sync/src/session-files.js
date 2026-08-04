import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SESSION_DIRS } from "./constants.js";

const execFileAsync = promisify(execFile);

function isRolloutFileBusyError(error) {
  const message = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return message.includes("ebusy")
    || message.includes("resource busy or locked")
    || message.includes("being used by another process")
    || message.includes("currently in use")
    || message.includes("eperm");
}

function wrapRolloutFileBusyError(error, filePath, action) {
  if (!isRolloutFileBusyError(error)) {
    return error;
  }
  return new Error(
    `Unable to ${action} rollout file because it is currently in use. Close Codex and the Codex app, then retry. Locked file: ${filePath}`
  );
}

async function getFileSnapshot(filePath) {
  const stat = await fsp.stat(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function snapshotMatches(change, snapshot) {
  return change.originalSize === snapshot.size
    && change.originalMtimeMs === snapshot.mtimeMs;
}

function emptyEncryptedContentCounts() {
  return {
    sessions: {},
    archived_sessions: {}
  };
}

function incrementPlainCount(counts, directory, provider) {
  counts[directory][provider] = (counts[directory][provider] ?? 0) + 1;
}

function splitContentLines(content) {
  return content.split(/(?<=\n)/);
}

function trailingNewline(chunk) {
  if (chunk.endsWith("\r\n")) {
    return "\r\n";
  }
  if (chunk.endsWith("\n")) {
    return "\n";
  }
  return "";
}

export function applyLineUpdatesToContent(content, updatedFirstLine, separator, modelLineUpdates) {
  const parts = splitContentLines(content);
  parts[0] = `${updatedFirstLine}${separator}`;
  for (const update of modelLineUpdates ?? []) {
    const chunk = parts[update.index];
    if (chunk === undefined) {
      throw new Error(`Unable to rewrite rollout file because its line layout changed during sync.`);
    }
    parts[update.index] = `${update.text}${trailingNewline(chunk)}`;
  }
  return parts.join("");
}

async function collectModelLineUpdates(filePath, targetProvider, targetModel) {
  let content;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    throw wrapRolloutFileBusyError(error, filePath, "scan");
  }

  const parts = splitContentLines(content);
  const updates = [];
  for (let index = 1; index < parts.length; index += 1) {
    const lineText = parts[index].replace(/\r?\n$/, "");
    let parsed;
    try {
      parsed = JSON.parse(lineText);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    let changed = false;
    if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string" && parsed.payload.model !== targetModel) {
      parsed.payload.model = targetModel;
      changed = true;
    }
    if (parsed.type === "event_msg" && parsed.payload?.thread_settings && typeof parsed.payload.thread_settings.model === "string") {
      if (parsed.payload.thread_settings.model !== targetModel) {
        parsed.payload.thread_settings.model = targetModel;
        changed = true;
      }
      if (parsed.payload.thread_settings.model_provider_id !== targetProvider) {
        parsed.payload.thread_settings.model_provider_id = targetProvider;
        changed = true;
      }
    }
    if (changed) {
      updates.push({
        index,
        text: JSON.stringify(parsed),
        originalText: lineText
      });
    }
  }
  return updates;
}

async function fileHasEncryptedContent(filePath, firstLine) {
  if (firstLine.includes("encrypted_content")) {
    return true;
  }
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return content.includes("encrypted_content");
  } catch (error) {
    throw wrapRolloutFileBusyError(error, filePath, "scan");
  }
}

async function listJsonlFiles(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function readFirstLineRecord(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    let position = 0;
    let collected = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const crlf = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d;
        const lineBuffer = crlf ? collected.subarray(0, newlineIndex - 1) : collected.subarray(0, newlineIndex);
        return {
          firstLine: lineBuffer.toString("utf8"),
          separator: crlf ? "\r\n" : "\n",
          offset: newlineIndex + 1
        };
      }
    }
    return {
      firstLine: collected.toString("utf8"),
      separator: "",
      offset: collected.length
    };
  } catch (error) {
    throw wrapRolloutFileBusyError(error, filePath, "read");
  } finally {
    await handle?.close();
  }
}

export function parseSessionMetaRecord(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || typeof parsed?.payload !== "object" || parsed.payload === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isValidWindowsRewriteResult(result) {
  return result === "APPLIED" || result === "SKIP_BUSY" || result === "SKIP_CHANGED";
}

function parseWindowsRewriteResults(stdout, changes) {
  const trimmed = stdout.trim();
  const parsed = trimmed ? JSON.parse(trimmed) : [];
  const results = Array.isArray(parsed) ? parsed : [parsed];

  if (results.length !== changes.length) {
    throw new Error(`Unexpected rewrite result count. Expected ${changes.length}, received ${results.length}.`);
  }

  return results.map((entry, index) => {
    const expectedPath = changes[index].path;
    if (entry?.path !== expectedPath || !isValidWindowsRewriteResult(entry?.result)) {
      throw new Error(`Unexpected rewrite result for ${expectedPath}: ${JSON.stringify(entry)}`);
    }
    return entry.result;
  });
}

async function restoreOriginalMtime(filePath, mtimeMs) {
  if (!Number.isFinite(mtimeMs)) {
    return;
  }
  const mtime = new Date(mtimeMs);
  try {
    const stat = await fsp.stat(filePath);
    await fsp.utimes(filePath, stat.atime, mtime);
  } catch {
    // Best effort only; rewriting metadata is still the primary operation.
  }
}

async function invokeWindowsExclusiveRewriteBatch(changes, { requireOriginalMatch }) {
  if (!changes.length) {
    return [];
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-provider-rewrite-"));
  const manifestPath = path.join(tempDir, "changes.json");
  const script = `
& {
  param([string]$manifestPath)

  function Read-FirstLineRecord([System.IO.FileStream]$stream) {
    $stream.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buffer = New-Object byte[] (64 * 1024)
    $collected = New-Object System.IO.MemoryStream
    try {
      while ($true) {
        $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
        if ($bytesRead -le 0) {
          break
        }

        $collected.Write($buffer, 0, $bytesRead)
        $bytes = $collected.ToArray()
        $newlineIndex = [Array]::IndexOf($bytes, [byte]10)
        if ($newlineIndex -ge 0) {
          $crlf = $newlineIndex -gt 0 -and $bytes[$newlineIndex - 1] -eq [byte]13
          $lineLength = if ($crlf) { $newlineIndex - 1 } else { $newlineIndex }
          return @{
            firstLine = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $lineLength)
            offset = $newlineIndex + 1
          }
        }
      }

      return @{
        firstLine = [System.Text.Encoding]::UTF8.GetString($collected.ToArray())
        offset = [int]$collected.Length
      }
    } finally {
      $collected.Dispose()
    }
  }

  function Invoke-RewriteChange($change) {
    $path = [string]$change.path
    $tmpPath = "$path.provider-sync.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $source = $null
    $writer = $null
    $tempReader = $null

    try {
      try {
        $source = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      } catch {
        if (Test-Path $path) {
          return "SKIP_BUSY"
        }
        return "SKIP_CHANGED"
      }

      if ([bool]$change.requireOriginalMatch) {
        if ($source.Length -ne [int64]$change.originalSize) {
          return "SKIP_CHANGED"
        }

        $record = Read-FirstLineRecord $source
        if ($record.firstLine -ne [string]$change.originalFirstLine -or $record.offset -ne [int]$change.originalOffset) {
          return "SKIP_CHANGED"
        }
      }

      $source.Position = 0
      $reader = [System.IO.StreamReader]::new($source, [System.Text.Encoding]::UTF8, $false, 1024, $true)
      $content = $reader.ReadToEnd()
      $reader.Dispose()

      $lines = [regex]::Split($content, "(?<=\n)")
      $separator = [string]$change.originalSeparator
      if ([string]::IsNullOrEmpty($separator)) {
        $separator = [string]$change.separator
      }
      $lines[0] = [string]$change.updatedFirstLine + $separator

      foreach ($update in @($change.modelLineUpdates)) {
        if ($null -eq $update) {
          continue
        }
        $chunk = $lines[[int]$update.index]
        if ($null -eq $chunk) {
          return "SKIP_CHANGED"
        }
        $suffix = ""
        $crlf = [string][char]13 + [string][char]10
        $lf = [string][char]10
        if ($chunk.EndsWith($crlf)) {
          $suffix = $crlf
        } elseif ($chunk.EndsWith($lf)) {
          $suffix = $lf
        }
        $lines[[int]$update.index] = [string]$update.text + $suffix
      }
      $updatedContent = [string]::Join("", $lines)

      $writer = [System.IO.File]::Open($tmpPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $contentBytes = $encoding.GetBytes($updatedContent)
      $writer.Write($contentBytes, 0, $contentBytes.Length)

      $writer.Flush()
      $writer.Dispose()
      $writer = $null

      $tempReader = [System.IO.File]::OpenRead($tmpPath)
      $source.SetLength(0)
      $source.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
      $tempReader.CopyTo($source)
      $source.Flush()

      return "APPLIED"
    } finally {
      if ($tempReader) {
        $tempReader.Dispose()
      }
      if ($writer) {
        $writer.Dispose()
      }
      if ($source) {
        $source.Dispose()
      }
      Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
    }
  }

  $changes = Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json
  if ($null -eq $changes) {
    $changes = @()
  } elseif ($changes -is [string] -or $changes -isnot [System.Collections.IEnumerable]) {
    $changes = @($changes)
  } else {
    $changes = @($changes)
  }

  $results = @(foreach ($change in $changes) {
    [pscustomobject]@{
      path = [string]$change.path
      result = Invoke-RewriteChange $change
    }
  })

  $results | ConvertTo-Json -Compress
}
`.trim();

  try {
    await fsp.writeFile(
      manifestPath,
      JSON.stringify(changes.map((change) => ({
        ...change,
        requireOriginalMatch
      }))),
      "utf8"
    );

    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      manifestPath
    ], {
      maxBuffer: 16 * 1024 * 1024
    });

    return parseWindowsRewriteResults(stdout, changes);
  } catch (error) {
    throw wrapRolloutFileBusyError(error, changes[0]?.path, "rewrite");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function invokeWindowsExclusiveRewrite(change, options) {
  const [result] = await invokeWindowsExclusiveRewriteBatch([change], options);
  return result;
}

async function rewriteLines(filePath, { updatedFirstLine, separator, modelLineUpdates = [] }) {
  if (process.platform === "win32") {
    const result = await invokeWindowsExclusiveRewrite(
      {
        path: filePath,
        separator,
        updatedFirstLine,
        modelLineUpdates
      },
      { requireOriginalMatch: false }
    );

    if (result !== "APPLIED") {
      throw new Error(
        `Unable to rewrite rollout file because it is currently in use. Close Codex and the Codex app, then retry. Locked file: ${filePath}`
      );
    }

    return;
  }

  const content = await fsp.readFile(filePath, "utf8");
  const updatedContent = applyLineUpdatesToContent(
    content,
    updatedFirstLine,
    separator,
    modelLineUpdates
  );
  const tmpPath = `${filePath}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    await new Promise((resolve, reject) => {
      writer.on("error", reject);
      writer.write(updatedContent);
      writer.end();
      writer.once("finish", resolve);
    });

    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw wrapRolloutFileBusyError(error, filePath, "rewrite");
  }
}

async function tryRewriteCollectedLines(change) {
  const beforeSnapshot = await getFileSnapshot(change.path);
  if (!snapshotMatches(change, beforeSnapshot)) {
    return false;
  }

  const current = await readFirstLineRecord(change.path);
  if (current.firstLine !== change.originalFirstLine || current.offset !== change.originalOffset) {
    return false;
  }

  const content = await fsp.readFile(change.path, "utf8");
  let updatedContent;
  try {
    updatedContent = applyLineUpdatesToContent(
      content,
      change.updatedFirstLine,
      change.originalSeparator,
      change.modelLineUpdates
    );
  } catch {
    return false;
  }

  const tmpPath = `${change.path}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    await new Promise((resolve, reject) => {
      writer.on("error", reject);
      writer.write(updatedContent);
      writer.end();
      writer.once("finish", resolve);
    });

    const afterSnapshot = await getFileSnapshot(change.path);
    if (!snapshotMatches(change, afterSnapshot)) {
      await fsp.rm(tmpPath, { force: true });
      return false;
    }

    await fsp.rename(tmpPath, change.path);
    return true;
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw wrapRolloutFileBusyError(error, change.path, "rewrite");
  }
}

async function findLockedFilesOnWindows(filePaths) {
  if (!filePaths.length) {
    return [];
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-provider-locks-"));
  const manifestPath = path.join(tempDir, "paths.json");
  const script = `
& {
  param([string]$manifestPath)
  $paths = Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json
  foreach ($path in $paths) {
    try {
      $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $stream.Close()
    } catch {
      Write-Output $path
    }
  }
}
`.trim();

  try {
    await fsp.writeFile(manifestPath, JSON.stringify(filePaths), "utf8");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      manifestPath
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to verify rollout file locks on Windows. ${error.message}`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export async function collectSessionChanges(codexHome, targetProvider, options = {}) {
  const {
    skipLockedReads = false,
    sourceProvider,
    targetModel,
    repairModels = false
  } = options;
  const summaries = [];
  const lockedPaths = [];
  const providerCounts = {
    sessions: new Map(),
    archived_sessions: new Map()
  };
  const encryptedContentCounts = emptyEncryptedContentCounts();

  for (const dirName of SESSION_DIRS) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fsp.access(rootDir);
    } catch {
      continue;
    }
    const rolloutPaths = await listJsonlFiles(rootDir);
    for (const rolloutPath of rolloutPaths) {
      let record;
      try {
        record = await readFirstLineRecord(rolloutPath);
      } catch (error) {
        if (skipLockedReads && isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }
      const parsed = parseSessionMetaRecord(record.firstLine);
      if (!parsed) {
        continue;
      }
      const currentProvider = parsed.payload.model_provider ?? "(missing)";
      // 指定来源 provider 时，只处理该来源的会话（计数也只统计该来源）。
      if (sourceProvider !== undefined && currentProvider !== sourceProvider) {
        continue;
      }
      providerCounts[dirName].set(currentProvider, (providerCounts[dirName].get(currentProvider) ?? 0) + 1);
      try {
        if (await fileHasEncryptedContent(rolloutPath, record.firstLine)) {
          incrementPlainCount(encryptedContentCounts, dirName, currentProvider);
        }
      } catch (error) {
        if (skipLockedReads && isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }

      if (targetProvider === "__status_only__") {
        continue;
      }

      const isProviderChange = parsed.payload.model_provider !== targetProvider;
      let modelLineUpdates = [];
      if (targetModel && (isProviderChange || repairModels)) {
        try {
          modelLineUpdates = await collectModelLineUpdates(rolloutPath, targetProvider, targetModel);
        } catch (error) {
          if (skipLockedReads && isRolloutFileBusyError(error)) {
            lockedPaths.push(rolloutPath);
            continue;
          }
          throw error;
        }
      }
      if (!isProviderChange && modelLineUpdates.length === 0) {
        continue;
      }

      const snapshot = await getFileSnapshot(rolloutPath);
      if (isProviderChange) {
        parsed.payload.model_provider = targetProvider;
      }
      const change = {
        path: rolloutPath,
        threadId: parsed.payload.id ?? null,
        directory: dirName,
        originalFirstLine: record.firstLine,
        originalSeparator: record.separator,
        originalOffset: record.offset,
        originalSize: snapshot.size,
        originalMtimeMs: snapshot.mtimeMs,
        originalProvider: currentProvider,
        updatedFirstLine: JSON.stringify(parsed)
      };
      if (modelLineUpdates.length > 0) {
        change.modelLineUpdates = modelLineUpdates;
      }
      summaries.push(change);
    }
  }

  return { changes: summaries, lockedPaths, providerCounts, encryptedContentCounts };
}

export async function collectSessionBackupSnapshot(codexHome) {
  const files = [];
  const lockedPaths = [];

  for (const dirName of SESSION_DIRS) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fsp.access(rootDir);
    } catch {
      continue;
    }
    const rolloutPaths = await listJsonlFiles(rootDir);
    for (const rolloutPath of rolloutPaths) {
      let record;
      try {
        record = await readFirstLineRecord(rolloutPath);
      } catch (error) {
        if (isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }
      const parsed = parseSessionMetaRecord(record.firstLine);
      if (!parsed) {
        continue;
      }
      let stat;
      try {
        stat = await fsp.stat(rolloutPath);
      } catch (error) {
        if (isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }
      files.push({
        path: rolloutPath,
        threadId: parsed.payload.id ?? null,
        directory: dirName,
        originalProvider: parsed.payload.model_provider ?? "(missing)",
        originalFirstLine: record.firstLine,
        originalSeparator: record.separator,
        originalOffset: record.offset,
        originalSize: stat.size,
        originalMtimeMs: stat.mtimeMs
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  lockedPaths.sort((left, right) => left.localeCompare(right));
  return { files, lockedPaths };
}

export async function applySessionChanges(changes) {
  const normalizedChanges = changes ?? [];
  const skippedPaths = [];
  const appliedPaths = [];
  let appliedChanges = 0;

  if (process.platform === "win32") {
    const results = await invokeWindowsExclusiveRewriteBatch(normalizedChanges, { requireOriginalMatch: true });
    for (let index = 0; index < normalizedChanges.length; index += 1) {
      if (results[index] === "APPLIED") {
        appliedChanges += 1;
        appliedPaths.push(normalizedChanges[index].path);
        await restoreOriginalMtime(normalizedChanges[index].path, normalizedChanges[index].originalMtimeMs);
      } else {
        skippedPaths.push(normalizedChanges[index].path);
      }
    }
  } else {
    for (const change of normalizedChanges) {
      if (await tryRewriteCollectedLines(change)) {
        appliedChanges += 1;
        appliedPaths.push(change.path);
        await restoreOriginalMtime(change.path, change.originalMtimeMs);
      } else {
        skippedPaths.push(change.path);
      }
    }
  }

  appliedPaths.sort((left, right) => left.localeCompare(right));
  skippedPaths.sort((left, right) => left.localeCompare(right));
  return {
    appliedChanges,
    appliedPaths,
    skippedPaths
  };
}

export async function assertSessionFilesWritable(changes) {
  if (!changes?.length || process.platform !== "win32") {
    return;
  }

  const lockedPaths = await findLockedFilesOnWindows(changes.map((change) => change.path));
  if (lockedPaths.length === 0) {
    return;
  }

  const preview = lockedPaths.slice(0, 5).join(", ");
  const extraCount = lockedPaths.length - Math.min(lockedPaths.length, 5);
  const suffix = extraCount > 0 ? ` (+${extraCount} more)` : "";
  throw new Error(
    `Unable to rewrite rollout files because ${lockedPaths.length} file(s) are currently in use. Close Codex and the Codex app, then retry. Locked file(s): ${preview}${suffix}`
  );
}

export async function splitLockedSessionChanges(changes) {
  if (!changes?.length || process.platform !== "win32") {
    return {
      writableChanges: changes ?? [],
      lockedChanges: []
    };
  }

  const lockedPaths = new Set(await findLockedFilesOnWindows(changes.map((change) => change.path)));
  if (lockedPaths.size === 0) {
    return {
      writableChanges: changes,
      lockedChanges: []
    };
  }

  const writableChanges = [];
  const lockedChanges = [];
  for (const change of changes) {
    if (lockedPaths.has(change.path)) {
      lockedChanges.push(change);
    } else {
      writableChanges.push(change);
    }
  }

  return {
    writableChanges,
    lockedChanges
  };
}

export async function restoreSessionChanges(manifestEntries) {
  if (!manifestEntries?.length) {
    return;
  }

  const changes = manifestEntries.map((entry) => ({
    path: entry.path,
    separator: entry.originalSeparator ?? "\n",
    updatedFirstLine: entry.originalFirstLine,
    originalMtimeMs: entry.originalMtimeMs,
    modelLineUpdates: (entry.modelLineIndexes ?? []).map((index, offset) => ({
      index,
      text: (entry.originalModelLines ?? [])[offset]
    })).filter((update) => update.text !== undefined)
  }));

  if (process.platform === "win32") {
    const results = await invokeWindowsExclusiveRewriteBatch(changes, { requireOriginalMatch: false });
    const firstFailureIndex = results.findIndex((result) => result !== "APPLIED");
    if (firstFailureIndex !== -1) {
      const filePath = changes[firstFailureIndex].path;
      throw new Error(
        `Unable to rewrite rollout file because it is currently in use. Close Codex and the Codex app, then retry. Locked file: ${filePath}`
      );
    }
    for (const change of changes) {
      await restoreOriginalMtime(change.path, change.originalMtimeMs);
    }
    return;
  }

  for (const entry of manifestEntries) {
    const change = changes[manifestEntries.indexOf(entry)];
    await rewriteLines(entry.path, {
      updatedFirstLine: entry.originalFirstLine,
      separator: entry.originalSeparator ?? "\n",
      modelLineUpdates: change.modelLineUpdates
    });
    await restoreOriginalMtime(entry.path, entry.originalMtimeMs);
  }
}

export function summarizeProviderCounts(providerCounts) {
  const result = {};
  for (const [scope, counts] of Object.entries(providerCounts)) {
    result[scope] = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
  return result;
}
