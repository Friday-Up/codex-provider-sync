import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { SESSION_DIRS } from "./constants.js";
import { collectSessionChanges, applySessionChanges } from "./session-files.js";
import { updateSqliteProvider } from "./sqlite-state.js";
import { acquireLock } from "./locking.js";
import { scanRolloutProviders, readExistingThreads, buildCoexistPlan, executeCoexistPlan } from "./coexist.js";

/**
 * Watch for new rollout files and auto-sync their model_provider.
 *
 * Modes:
 * - "rewrite": Traditional mode, rewrite rollout files and SQLite (like original sync)
 * - "coexist": Only update SQLite mirrors, never touch rollout files
 */
export async function runWatch({
  codexHome,
  targetProvider,
  mode = "rewrite",
  onEvent,
  signal
} = {}) {
  const releaseLock = await acquireLock(codexHome, "watch");
  const watchers = [];
  const pendingSyncs = new Set();
  let syncTimer = null;

  function emit(event) {
    if (typeof onEvent === "function") {
      onEvent(event);
    }
  }

  async function performSync(filePath) {
    try {
      emit({ type: "sync_start", file: filePath, mode });

      if (mode === "coexist") {
        // Coexist mode: only update SQLite mirrors
        const rolloutByProvider = await scanRolloutProviders(codexHome);
        const allProviders = [...rolloutByProvider.keys()];

        if (allProviders.length < 2) {
          emit({ type: "sync_skip", reason: "only_one_provider_found" });
          return;
        }

        const existing = readExistingThreads(codexHome);
        const plan = buildCoexistPlan(rolloutByProvider, existing.byRolloutPath, allProviders);

        if (plan.toInsert.length === 0 && plan.toDelete.length === 0) {
          emit({ type: "sync_skip", reason: "already_synced" });
          return;
        }

        const result = executeCoexistPlan(codexHome, plan, existing);
        emit({
          type: "sync_complete",
          mode: "coexist",
          inserted: result.inserted,
          deleted: result.deleted
        });
      } else {
        // Rewrite mode: traditional behavior
        const { changes, lockedPaths } = await collectSessionChanges(
          codexHome,
          targetProvider,
          { skipLockedReads: true }
        );

        const fileChanges = changes.filter((c) =>
          filePath ? c.path === filePath : true
        );

        if (fileChanges.length === 0) {
          emit({ type: "sync_skip", file: filePath, reason: "no_changes_needed" });
          return;
        }

        const sqliteResult = await updateSqliteProvider(
          codexHome,
          targetProvider,
          async () => {
            const applyResult = await applySessionChanges(fileChanges);
            emit({
              type: "sync_complete",
              file: filePath,
              applied: applyResult.appliedChanges,
              skipped: applyResult.skippedPaths.length
            });
          }
        );

        emit({
          type: "sync_sqlite",
          updatedRows: sqliteResult.updatedRows
        });
      }
    } catch (error) {
      emit({
        type: "sync_error",
        file: filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function debouncedSync(filePath) {
    pendingSyncs.add(filePath);
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      const files = [...pendingSyncs];
      pendingSyncs.clear();
      for (const file of files) {
        performSync(file);
      }
    }, 1000);
  }

  async function setupWatcher(dirName) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fsp.access(rootDir);
    } catch {
      return;
    }

    const watcher = fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
      if (signal?.aborted) return;
      if (!filename || !filename.startsWith("rollout-") || !filename.endsWith(".jsonl")) {
        return;
      }
      if (eventType === "rename" || eventType === "change") {
        const fullPath = path.join(rootDir, filename);
        debouncedSync(fullPath);
      }
    });

    watchers.push(watcher);
    emit({ type: "watch_start", directory: rootDir, mode });
  }

  for (const dirName of SESSION_DIRS) {
    await setupWatcher(dirName);
  }

  emit({ type: "watch_initial_sync", mode });
  await performSync(null);

  return async function cleanup() {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    for (const watcher of watchers) {
      watcher.close();
    }
    await releaseLock();
    emit({ type: "watch_stop" });
  };
}

/**
 * Run a one-time scan and sync.
 */
export async function runWatchOnce({
  codexHome,
  targetProvider,
  mode = "rewrite",
  onEvent
} = {}) {
  const releaseLock = await acquireLock(codexHome, "watch-once");
  try {
    if (typeof onEvent === "function") {
      onEvent({ type: "scan_start", mode });
    }

    if (mode === "coexist") {
      const rolloutByProvider = await scanRolloutProviders(codexHome);
      const allProviders = [...rolloutByProvider.keys()];

      if (allProviders.length < 2) {
        if (typeof onEvent === "function") {
          onEvent({ type: "scan_complete", mode: "coexist", message: "Only one provider found" });
        }
        return { changes: 0, inserted: 0, deleted: 0 };
      }

      const existing = readExistingThreads(codexHome);
      const plan = buildCoexistPlan(rolloutByProvider, existing.byRolloutPath, allProviders);

      if (plan.toInsert.length === 0 && plan.toDelete.length === 0) {
        if (typeof onEvent === "function") {
          onEvent({ type: "scan_complete", mode: "coexist", message: "Already synced" });
        }
        return { changes: 0, inserted: 0, deleted: 0 };
      }

      const result = executeCoexistPlan(codexHome, plan, existing);

      if (typeof onEvent === "function") {
        onEvent({
          type: "scan_complete",
          mode: "coexist",
          inserted: result.inserted,
          deleted: result.deleted
        });
      }

      return {
        changes: plan.toInsert.length + plan.toDelete.length,
        inserted: result.inserted,
        deleted: result.deleted
      };
    }

    // Rewrite mode
    const { changes, lockedPaths } = await collectSessionChanges(
      codexHome,
      targetProvider,
      { skipLockedReads: true }
    );

    if (changes.length === 0) {
      if (typeof onEvent === "function") {
        onEvent({ type: "scan_complete", changes: 0, locked: lockedPaths.length });
      }
      return { changes: 0, applied: 0, locked: lockedPaths.length };
    }

    const sqliteResult = await updateSqliteProvider(
      codexHome,
      targetProvider,
      async () => {
        const applyResult = await applySessionChanges(changes);
        if (typeof onEvent === "function") {
          onEvent({
            type: "scan_complete",
            changes: changes.length,
            applied: applyResult.appliedChanges,
            skipped: applyResult.skippedPaths.length,
            locked: lockedPaths.length
          });
        }
        return applyResult;
      }
    );

    return {
      changes: changes.length,
      applied: changes.length,
      sqliteUpdated: sqliteResult.updatedRows,
      locked: lockedPaths.length
    };
  } finally {
    await releaseLock();
  }
}
