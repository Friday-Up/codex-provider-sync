import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_BASENAME, SESSION_DIRS } from "./constants.js";
import { readFirstLineRecord, parseSessionMetaRecord } from "./session-files.js";
import { acquireLock } from "./locking.js";

const COEXIST_SUFFIX = "_coexist";
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function openDatabase(dbPath) {
  return new DatabaseSync(dbPath);
}

function stateDbPath(codexHome) {
  return path.join(codexHome, DB_FILE_BASENAME);
}

/**
 * Read all rollout files and group by their actual model_provider.
 */
export async function scanRolloutProviders(codexHome) {
  const result = new Map(); // provider -> [{ path, threadId, firstLine, record }]

  for (const dirName of SESSION_DIRS) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fs.access(rootDir);
    } catch {
      continue;
    }

    const entries = await fs.readdir(rootDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = path.join(entry.parentPath || rootDir, entry.name);
      try {
        const record = await readFirstLineRecord(fullPath);
        const parsed = parseSessionMetaRecord(record.firstLine);
        if (!parsed) continue;

        const provider = parsed.payload.model_provider ?? "(missing)";
        const threadId = parsed.payload.id;

        if (!result.has(provider)) {
          result.set(provider, []);
        }
        result.get(provider).push({
          path: fullPath,
          threadId,
          firstLine: record.firstLine,
          separator: record.separator,
          offset: record.offset,
          provider
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return result;
}

/**
 * Get existing threads from SQLite, including coexist mirrors.
 */
export function readExistingThreads(codexHome) {
  const dbPath = stateDbPath(codexHome);
  let db;
  try {
    db = openDatabase(dbPath);
    const rows = db.prepare(`
      SELECT id, rollout_path, model_provider
      FROM threads
    `).all();

    const byProvider = new Map();
    const byRolloutPath = new Map();

    for (const row of rows) {
      const provider = row.model_provider;
      if (!byProvider.has(provider)) {
        byProvider.set(provider, new Map());
      }
      byProvider.get(provider).set(row.id, row.rollout_path);

      if (!byRolloutPath.has(row.rollout_path)) {
        byRolloutPath.set(row.rollout_path, new Set());
      }
      byRolloutPath.get(row.rollout_path).add(provider);
    }

    return { byProvider, byRolloutPath, totalRows: rows.length };
  } finally {
    db?.close();
  }
}

/**
 * Build the list of mirror records needed for coexistence.
 * For each rollout file, ensure it has a record for ALL providers found in the system.
 */
export function buildCoexistPlan(rolloutByProvider, existingByRolloutPath, allProviders) {
  const toInsert = [];
  const toDelete = [];

  // Collect all existing records by their ID pattern
  const existingById = new Map();
  for (const [rolloutPath, providers] of existingByRolloutPath) {
    for (const provider of providers) {
      const key = `${rolloutPath}#${provider}`;
      existingById.set(key, true);
    }
  }

  // For each provider's rollout files
  for (const [actualProvider, files] of rolloutByProvider) {
    for (const file of files) {
      // For each target provider that should see this file
      for (const targetProvider of allProviders) {
        const isOriginal = targetProvider === actualProvider;
        const expectedId = isOriginal ? file.threadId : `${file.threadId}${COEXIST_SUFFIX}_${targetProvider}`;
        const key = `${file.path}#${targetProvider}`;

        // Check if this specific record exists
        // For original: any record with this provider for this rollout
        // For mirror: any record with _coexist_<targetProvider> for this rollout
        let exists = false;
        const providersForRollout = existingByRolloutPath.get(file.path) ?? new Set();

        for (const p of providersForRollout) {
          if (p === targetProvider) {
            // Could be original or a wrong original (if rewrite was used)
            exists = true;
            break;
          }
          if (!isOriginal && p.endsWith(`${COEXIST_SUFFIX}_${targetProvider}`)) {
            exists = true;
            break;
          }
        }

        // Special case: if the rollout file's actual provider is NOT in the existing providers,
        // it means the original record was overwritten by rewrite mode.
        // We should still create the mirror for the target provider.
        const hasCorrectOriginal = providersForRollout.has(actualProvider);
        const needsMirrorForWrongOriginal = !isOriginal && !hasCorrectOriginal;

        if (!exists || needsMirrorForWrongOriginal) {
          toInsert.push({
            id: expectedId,
            rolloutPath: file.path,
            provider: targetProvider,
            isOriginal,
            originalProvider: actualProvider
          });
        }
      }
    }
  }

  // Find orphaned coexist records (rollout file no longer exists)
  for (const [rolloutPath, providers] of existingByRolloutPath) {
    let fileExists = false;
    for (const files of rolloutByProvider.values()) {
      if (files.some((f) => f.path === rolloutPath)) {
        fileExists = true;
        break;
      }
    }
    if (!fileExists) {
      for (const provider of providers) {
        if (provider.includes(COEXIST_SUFFIX)) {
          // Find the actual id
          // We need to query the DB for this, but for now just mark for cleanup
          toDelete.push({ rolloutPath, provider });
        }
      }
    }
  }

  return { toInsert, toDelete };
}

/**
 * Execute the coexist plan in SQLite.
 */
export function executeCoexistPlan(codexHome, plan, sourceThreads) {
  const dbPath = stateDbPath(codexHome);
  let db;
  let transactionOpen = false;

  try {
    db = openDatabase(dbPath);
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    let inserted = 0;
    let deleted = 0;

    // Read source thread data for mirroring
    const sourceMap = new Map();
    for (const [provider, threads] of sourceThreads.byProvider) {
      for (const [id, rolloutPath] of threads) {
        sourceMap.set(rolloutPath, { id, provider });
      }
    }

    // Get full thread data for copying
    const allThreads = db.prepare(`SELECT * FROM threads`).all();
    const threadDataMap = new Map();
    for (const row of allThreads) {
      threadDataMap.set(row.rollout_path, row);
    }

    // Insert mirrors
    for (const item of plan.toInsert) {
      const sourceData = threadDataMap.get(item.rolloutPath);
      if (!sourceData) continue;

      try {
        db.prepare(`
          INSERT OR IGNORE INTO threads (
            id, rollout_path, created_at, updated_at, source, model_provider,
            cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event,
            archived, archived_at, git_sha, git_branch, git_origin_url,
            cli_version, first_user_message, agent_nickname, agent_role,
            memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          sourceData.rollout_path,
          sourceData.created_at,
          sourceData.updated_at,
          sourceData.source,
          item.provider,
          sourceData.cwd,
          sourceData.title,
          sourceData.sandbox_policy,
          sourceData.approval_mode,
          sourceData.tokens_used,
          sourceData.has_user_event,
          sourceData.archived,
          sourceData.archived_at,
          sourceData.git_sha,
          sourceData.git_branch,
          sourceData.git_origin_url,
          sourceData.cli_version,
          sourceData.first_user_message,
          sourceData.agent_nickname,
          sourceData.agent_role,
          sourceData.memory_mode,
          sourceData.model,
          sourceData.reasoning_effort,
          sourceData.agent_path,
          sourceData.created_at_ms,
          sourceData.updated_at_ms
        );
        inserted++;
      } catch (error) {
        // Ignore duplicate key errors
        if (!error.message?.includes("UNIQUE constraint failed")) {
          throw error;
        }
      }
    }

    // Delete orphaned mirrors
    for (const item of plan.toDelete) {
      db.prepare(`
        DELETE FROM threads WHERE rollout_path = ? AND model_provider LIKE '%${COEXIST_SUFFIX}%'
      `).run(item.rolloutPath);
      deleted++;
    }

    db.exec("COMMIT");
    transactionOpen = false;

    return { inserted, deleted, totalPlanned: plan.toInsert.length + plan.toDelete.length };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore
      }
    }
    throw error;
  } finally {
    db?.close();
  }
}

/**
 * Main entry for coexist mode.
 */
export async function runCoexist({ codexHome, onProgress } = {}) {
  const releaseLock = await acquireLock(codexHome, "coexist");

  try {
    if (typeof onProgress === "function") {
      onProgress({ stage: "scan", status: "start" });
    }

    // 1. Scan all rollout files
    const rolloutByProvider = await scanRolloutProviders(codexHome);
    const allProviders = [...rolloutByProvider.keys()];

    if (allProviders.length < 2) {
      if (typeof onProgress === "function") {
        onProgress({ stage: "scan", status: "complete", providers: allProviders, message: "Only one provider found, nothing to coexist." });
      }
      return { providers: allProviders, inserted: 0, deleted: 0 };
    }

    if (typeof onProgress === "function") {
      onProgress({ stage: "scan", status: "complete", providers: allProviders, fileCounts: Object.fromEntries([...rolloutByProvider].map(([k, v]) => [k, v.length])) });
    }

    // 2. Read existing SQLite records
    if (typeof onProgress === "function") {
      onProgress({ stage: "read_db", status: "start" });
    }

    const existing = readExistingThreads(codexHome);

    if (typeof onProgress === "function") {
      onProgress({ stage: "read_db", status: "complete", totalRows: existing.totalRows });
    }

    // 3. Build plan
    if (typeof onProgress === "function") {
      onProgress({ stage: "plan", status: "start" });
    }

    const plan = buildCoexistPlan(rolloutByProvider, existing.byRolloutPath, allProviders);

    if (typeof onProgress === "function") {
      onProgress({ stage: "plan", status: "complete", toInsert: plan.toInsert.length, toDelete: plan.toDelete.length });
    }

    if (plan.toInsert.length === 0 && plan.toDelete.length === 0) {
      if (typeof onProgress === "function") {
        onProgress({ stage: "execute", status: "complete", message: "All coexist records are already up to date." });
      }
      return { providers: allProviders, inserted: 0, deleted: 0, alreadySynced: true };
    }

    // 4. Execute
    if (typeof onProgress === "function") {
      onProgress({ stage: "execute", status: "start", toInsert: plan.toInsert.length, toDelete: plan.toDelete.length });
    }

    const result = executeCoexistPlan(codexHome, plan, existing);

    if (typeof onProgress === "function") {
      onProgress({ stage: "execute", status: "complete", ...result });
    }

    return {
      providers: allProviders,
      ...result,
      alreadySynced: false
    };
  } finally {
    await releaseLock();
  }
}

/**
 * Remove all coexist mirror records.
 */
export async function runCoexistCleanup({ codexHome, onProgress } = {}) {
  const releaseLock = await acquireLock(codexHome, "coexist-cleanup");

  try {
    const dbPath = stateDbPath(codexHome);
    let db;
    let deleted = 0;

    try {
      db = openDatabase(dbPath);
      db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);

      const result = db.prepare(`
        DELETE FROM threads WHERE id LIKE '%${COEXIST_SUFFIX}%'
      `).run();

      deleted = result.changes ?? 0;
    } finally {
      db?.close();
    }

    if (typeof onProgress === "function") {
      onProgress({ stage: "cleanup", status: "complete", deleted });
    }

    return { deleted };
  } finally {
    await releaseLock();
  }
}
