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

  $("btn-status").addEventListener("click", async () => {
    log("【刷新状态】用户点击了刷新状态按钮");
    try {
      const result = await callCommand("get_status", {}, $("btn-status"));
      $("status-output").textContent = result;
      log("状态信息已显示在上方输出区域");
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`获取状态出错: ${err}`, "error");
    }
  });

  $("btn-sync-openai").addEventListener("click", async () => {
    const provider = "openai";
    const providerText = "OpenAI 官方 OAuth";

    log(`【同步历史】用户选择同步到: ${providerText}`);

    try {
      log(`正在同步历史到 ${providerText}，请稍候...`);
      const result = await callCommand("run_sync", { provider }, $("btn-sync-openai"));
      $("status-output").textContent = result;
      log(`同步完成！现在可以使用 ${providerText} 登录并查看所有历史会话了。`);
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`同步失败: ${err}`, "error");
    }
  });

  $("btn-sync-custom").addEventListener("click", async () => {
    const provider = "custom";
    const providerText = "第三方 API Key";

    log(`【同步历史】用户选择同步到: ${providerText}`);

    try {
      log(`正在同步历史到 ${providerText}，请稍候...`);
      const result = await callCommand("run_sync", { provider }, $("btn-sync-custom"));
      $("status-output").textContent = result;
      log(`同步完成！现在可以使用 ${providerText} 登录并查看所有历史会话了。`);
    } catch (err) {
      $("status-output").textContent = `错误: ${err}`;
      log(`同步失败: ${err}`, "error");
    }
  });

  $("btn-restore").addEventListener("click", async () => {
    const backupDir = $("backup-dir").value.trim();
    if (!backupDir) {
      log("【恢复备份】错误：未填写备份目录路径", "error");
      alert("请先填写备份目录路径");
      return;
    }

    log(`【恢复备份】用户请求从备份恢复: ${backupDir}`);

    try {
      log("正在从备份恢复，请稍候...");
      const result = await callCommand("run_restore", { backup_dir: backupDir }, $("btn-restore"));
      $("status-output").textContent = result;
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
  log("2. 点击【同步到 OpenAI 官方 OAuth】或【同步到第三方 API Key】");
  log("3. 同步完成后，用对应方式登录 Codex 即可看到全部历史");
  log("=====================================");

  // 页面加载后自动获取一次状态
  setTimeout(async () => {
    try {
      log("【自动检测】正在检查 Codex 会话状态...");
      const result = await invoke("get_status");
      $("status-output").textContent = result;
      log("【自动检测】状态获取成功，结果已显示在上方");
    } catch (err) {
      log(`【自动检测】获取状态失败: ${err}`, "error");
      $("status-output").textContent = `错误: ${err}`;
    }
  }, 800);
} catch (e) {
  document.body.innerHTML = `<div style="padding:20px;color:red"><h1>JavaScript 错误</h1><pre>${e.stack || e}</pre></div>`;
}
