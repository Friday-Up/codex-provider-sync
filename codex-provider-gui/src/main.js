try {
  const { invoke } = window.__TAURI__.core;

  const $ = (id) => document.getElementById(id);

  function log(message, type = "info") {
    const logOutput = $("log-output");
    const timestamp = new Date().toLocaleTimeString("zh-CN");
    const prefix = type === "error" ? "[错误]" : type === "success" ? "[成功]" : "[信息]";
    logOutput.textContent += `[${timestamp}] ${prefix} ${message}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  function setLoading(btn, loading) {
    if (loading) {
      btn.disabled = true;
      btn.classList.add("loading");
      btn.dataset.originalText = btn.textContent;
      btn.textContent = "";
    } else {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.textContent = btn.dataset.originalText || btn.textContent;
    }
  }

  async function callCommand(command, args = {}, btn = null) {
    if (btn) setLoading(btn, true);
    try {
      log(`正在调用后端命令: ${command}，参数: ${JSON.stringify(args)}`);
      const result = await invoke(command, args);
      log(`命令 ${command} 执行成功`, "success");
      return result;
    } catch (err) {
      log(`命令 ${command} 执行失败: ${err}`, "error");
      throw err;
    } finally {
      if (btn) setLoading(btn, false);
    }
  }

  function parseConfiguredProviders(statusText) {
    const match = statusText.match(/已配置的 provider:\s*(.+)/);
    if (!match) {
      return [];
    }
    return match[1]
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean);
  }

  function restoreSelectValue(select, previousValue) {
    if (previousValue && [...select.options].some((option) => option.value === previousValue)) {
      select.value = previousValue;
    }
  }

  function populateSyncSelects(statusText) {
    const providers = parseConfiguredProviders(statusText);
    const from = $("sync-from");
    const to = $("sync-to");
    const previousFrom = from.value;
    const previousTo = to.value;

    from.innerHTML = '<option value="">全部（所有会话）</option>';
    to.innerHTML = "";

    for (const provider of providers) {
      const sourceOption = document.createElement("option");
      sourceOption.value = provider;
      sourceOption.textContent = provider;
      from.appendChild(sourceOption);

      const targetOption = document.createElement("option");
      targetOption.value = provider;
      targetOption.textContent = provider;
      to.appendChild(targetOption);
    }

    if (/(\(missing\)):\s*\d+/.test(statusText) && !providers.includes("(missing)")) {
      const missingOption = document.createElement("option");
      missingOption.value = "(missing)";
      missingOption.textContent = "(missing)";
      from.appendChild(missingOption);
    }

    restoreSelectValue(from, previousFrom);
    restoreSelectValue(to, previousTo);
  }

  function updateManualInputVisibility() {
    const manualGroup = $("backup-manual-group");
    if (!manualGroup) {
      return;
    }
    manualGroup.style.display = $("backup-select").value ? "none" : "";
  }

  async function refreshBackupList() {
    const select = $("backup-select");
    const previous = select.value;
    try {
      const result = await invoke("list_backups");
      const backups = JSON.parse(result);
      select.innerHTML = '<option value="">手动输入路径</option>';
      for (const backup of backups) {
        const option = document.createElement("option");
        option.value = backup.fullPath;
        const typeLabel = backup.backupType === "manual" ? "一键备份" : "同步备份";
        option.textContent = `${backup.name}（${typeLabel}，${backup.changedSessionFiles} 个会话文件）`;
        select.appendChild(option);
      }
      restoreSelectValue(select, previous);
      updateManualInputVisibility();
      return backups;
    } catch (err) {
      log(`刷新备份列表失败: ${err}`, "error");
      return [];
    }
  }

  $("btn-status").addEventListener("click", async () => {
    log("【刷新状态】用户点击了刷新状态按钮");
    try {
      const result = await callCommand("get_status", {}, $("btn-status"));
      $("status-output").textContent = result;
      populateSyncSelects(result);
      log("状态信息已显示在上方输出区域");
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`获取状态出错: ${err}`, "error");
    }
  });

  $("btn-sync").addEventListener("click", async () => {
    const from = $("sync-from").value;
    const to = $("sync-to").value;
    const model = $("sync-model").value.trim() || null;
    const repairModels = $("sync-repair").checked;
    if (!to) {
      log("【同步历史】错误：请先点击【刷新状态】并选择目标 provider", "error");
      alert("请先点击【刷新状态】并选择目标 provider");
      return;
    }

    const scope = from ? `仅 ${from} 的会话` : "全部会话";
    log(`【同步历史】用户选择：${scope} → ${to}${model ? `，模型 ${model}` : "（自动取配置模型）"}${repairModels ? "，并修复已为目标 provider 的会话模型" : ""}`);

    try {
      log(`正在把 ${scope} 同步到 ${to}，请稍候...`);
      const result = await callCommand(
        "run_sync",
        { from: from || null, to, model, repairModels },
        $("btn-sync")
      );
      $("status-output").textContent = result;
      log(`同步完成！已把 ${scope} 迁移到 ${to}。`);
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`同步失败: ${err}`, "error");
    }
  });

  $("btn-backup").addEventListener("click", async () => {
    log("【一键备份】用户点击了一键备份按钮");
    try {
      const result = await callCommand("run_backup", {}, $("btn-backup"));
      $("status-output").textContent = result;
      await refreshBackupList();
      log("备份完成！可在【从备份恢复】中输入该备份目录进行恢复。", "success");
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`备份失败: ${err}`, "error");
    }
  });

  $("backup-select").addEventListener("change", updateManualInputVisibility);

  $("btn-refresh-backups").addEventListener("click", () => {
    log("【刷新备份列表】用户点击了刷新备份列表按钮");
    refreshBackupList();
  });

  $("btn-restore").addEventListener("click", async () => {
    const backupDir = $("backup-select").value || $("backup-dir").value.trim();
    if (!backupDir) {
      log("【恢复备份】错误：未选择或填写备份目录", "error");
      alert("请先从下拉框选择备份，或手动填写备份目录路径");
      return;
    }

    log(`【恢复备份】用户请求从备份恢复: ${backupDir}`);

    try {
      log("正在从备份恢复，请稍候...");
      const result = await callCommand("run_restore", { backupDir }, $("btn-restore"));
      $("status-output").textContent = result;
      await refreshBackupList();
      log("恢复完成！");
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`恢复失败: ${err}`, "error");
    }
  });

  $("btn-clear-log").addEventListener("click", () => {
    $("log-output").textContent = "";
    log("日志已清空");
  });

  log("=====================================");
  log("欢迎使用 Codex Provider Sync GUI");
  log("本工具用于在切换登录方式时同步会话历史");
  log("=====================================");
  log("使用步骤：");
  log("1. 点击【刷新状态】查看当前会话分布");
  log("2. 选择来源 provider（或全部）与目标 provider，点击【执行同步】");
  log("3. 同步完成后，用对应方式登录 Codex 即可看到全部历史");
  log("=====================================");

  // 页面加载后自动获取一次状态
  setTimeout(async () => {
    try {
      log("【自动检测】正在检查 Codex 会话状态...");
      const result = await invoke("get_status");
      $("status-output").textContent = result;
      populateSyncSelects(result);
      log("【自动检测】状态获取成功，结果已显示在上方");
    } catch (err) {
      log(`【自动检测】获取状态失败: ${err}`, "error");
      $("status-output").textContent = `错误: ${err}`;
    }
  }, 800);

  refreshBackupList();
} catch (e) {
  document.body.innerHTML = `<div style="padding:20px;color:red"><h1>JavaScript 错误</h1><pre>${e.stack || e}</pre></div>`;
}
