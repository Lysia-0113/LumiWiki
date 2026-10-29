"use strict";
const $ = (s) => document.querySelector(s);
const state = {
  token: sessionStorage.getItem("lumiwiki.token") || "",
  project: null,
  projects: [],
  session: null,
  browser: null,
  controller: null,
  view: "overview",
  taskTimer: null,
  guideTaskTimer: null,
  resumeTaskId: null,
  acknowledgePending: false,
};
const notice = (message, error = false) => {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
};
const node = (tag, text, cls) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const button = (label, fn) => {
  const el = node("button", label);
  el.type = "button";
  el.onclick = () =>
    Promise.resolve()
      .then(fn)
      .catch((e) => notice(e.message, true));
  return el;
};
async function api(route, options = {}) {
  const r = await fetch(route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-QA-Admin-Token": state.token,
      ...options.headers,
    },
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || `请求失败 ${r.status}`);
  return d;
}
const post = (route, data = {}) =>
  api(route, { method: "POST", body: JSON.stringify(data) });
function requireProject() {
  if (!state.project) throw Error("请先创建或切换项目");
  return `/api/projects/${state.project.key}`;
}
function setView(view) {
  clearTimeout(state.guideTaskTimer);
  state.guideTaskTimer = null;
  state.view = view;
  document
    .querySelectorAll("[data-panel]")
    .forEach((e) => (e.hidden = e.dataset.panel !== view));
  document
    .querySelectorAll("[data-view]")
    .forEach((e) => e.classList.toggle("selected", e.dataset.view === view));
  $("#heading").textContent = $(`[data-view="${view}"]`).textContent;
  return loadView();
}
async function refresh() {
  const status = await api("/api/v1/admin/status");
  const data = await api("/api/projects");
  state.projects = data.projects;
  const previous = state.project?.key;
  state.project =
    data.projects.find((p) => p.key === data.activeProjectId) || null;
  if (previous !== state.project?.key) {
    state.browser = null;
    state.session = null;
    state.resumeTaskId = null;
    state.acknowledgePending = false;
    $("#browser-status").textContent = "浏览器未连接；仍可阅读已导入的知识库。";
  }
  $("#project-name").textContent = state.project?.name || "尚未选择项目";
  $("#status-grid").replaceChildren();
  let dw = false;
  try {
    dw = (await api("/api/deepwiki/status")).available;
  } catch {}
  for (const [name, value] of [
    ["LumiWiki", "运行中"],
    ["Pi 聊天模型", status.modelConfigured ? "已配置" : "待填写 .env"],
    ["DeepWiki", dw ? "运行中" : "未连接"],
    [
      "Embedding / Judge",
      `${status.embeddingConfigured ? "已配置" : "待配置"} / ${status.judgeConfigured ? "已配置" : "待配置"}`,
    ],
  ]) {
    const card = node("div");
    card.append(node("small", name), node("strong", value));
    $("#status-grid").append(card);
  }
  $("#projects").replaceChildren();
  for (const p of data.projects) {
    const item = node("div", undefined, "item");
    item.append(
      node("strong", p.name),
      node("code", p.path || "无源码目录"),
      node("p", p.url || "未配置网页", "muted"),
    );
    if (p.key !== state.project?.key)
      item.append(
        button("切换到此项目", async () => {
          await post(`/api/projects/${p.key}/activate`);
          await refresh();
        }),
      );
    else item.append(node("span", "当前项目", "badge"));
    $("#projects").append(item);
  }
  if (!data.projects.length)
    $("#projects").append(node("p", "还没有项目，从右侧创建一个。", "empty"));
  $("#project-settings").hidden = !state.project;
  if (state.project) {
    const settings = state.project.publicBrowser;
    $("#project-target-url").value = state.project.url || "";
    $("#public-browser-enabled").checked = settings.enabled;
    $("#public-browser-url").value = settings.url || "";
    $("#public-browser-url").placeholder =
      state.project.url || "留空使用目标网页";
    $("#public-browser-username").value = settings.username;
    $("#public-browser-password").value = "";
    $("#public-browser-password").placeholder = settings.passwordConfigured
      ? "已保存，留空保留原密码"
      : "未设置";
    $("#clear-public-password").checked = false;
    $("#clear-public-password-label").hidden = !settings.passwordConfigured;
  }
  $("#auth").hidden = true;
  $("#admin").hidden = false;
  await loadView();
}
async function protectedOpen(route) {
  const r = await fetch(route, {
    headers: { "X-QA-Admin-Token": state.token },
  });
  if (!r.ok) throw Error("打开文件失败");
  const data = await r.blob();
  const link = document.createElement("a");
  const url = URL.createObjectURL(data);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function loadView() {
  if (!state.project) return;
  const base = requireProject();
  if (state.view === "agent") {
    clearTimeout(state.guideTaskTimer);
    state.guideTaskTimer = null;
    const { items } = await api(base + "/tasks");
    const panel = $("#guide-tasks");
    panel.replaceChildren(node("h2", "指南任务"));
    panel.hidden = !items.length;
    for (const task of items) {
      const item = node("div", undefined, "item");
      item.append(node("strong", task.title), node("p", taskProgress(task)));
      if (task.error) item.append(node("p", task.error, "muted"));
      if (["paused", "blocked"].includes(task.status))
        item.append(
          button("继续任务", () => {
            if (
              task.requiresReview &&
              !confirm(
                "上次操作可能已执行。请先在目标网页人工核对结果，确认无需重复提交后再继续。是否已完成核对？",
              )
            )
              return;
            state.resumeTaskId = task.id;
            state.acknowledgePending = task.requiresReview;
            $("#quick-start").checked = true;
            $("#question").value =
              "继续当前指南任务，保留原计划和已有成果，完成剩余模块并汇总。";
            $("#ask-form").requestSubmit();
          }),
        );
      panel.append(item);
    }
    if (items.some((task) => task.status === "running"))
      state.guideTaskTimer = setTimeout(() => {
        if (state.view === "agent")
          loadView().catch((e) => notice(e.message, true));
      }, 2000);
  }
  if (state.view === "knowledge") {
    const data = await api(base + "/wiki");
    $("#wiki-mode").textContent =
      data.mode === "full" ? "全文注入" : "目录 + 按页读取";
    $("#wiki-files").replaceChildren();
    for (const f of data.files) {
      const card = node("section", undefined, "card");
      card.append(
        node("h2", f.name),
        node(
          "p",
          `${f.pages.length} 页 · ${f.totalChars.toLocaleString()} 字符 · ${f.stale.length} 条来源路径失效`,
          "muted",
        ),
      );
      const details = node("details");
      details.append(node("summary", "查看页目录"));
      const list = node("ol");
      for (const p of f.pages)
        list.append(
          node(
            "li",
            `${p.title}${p.headings.length ? " · " + p.headings.join(" / ") : ""}`,
          ),
        );
      details.append(list);
      card.append(details);
      const actions = node("div", undefined, "row");
      actions.append(
        button("查看原始 Markdown", () =>
          protectedOpen(`${base}/wiki/${f.id}.md`),
        ),
        button("删除", async () => {
          if (confirm(`删除知识库 ${f.name}？`)) {
            await api(`${base}/wiki/${f.id}`, { method: "DELETE" });
            await loadView();
          }
        }),
      );
      card.append(actions);
      $("#wiki-files").append(card);
    }
    if (!data.files.length)
      $("#wiki-files").append(
        node("p", "尚无知识库，可以从源码生成或导入 Markdown。", "empty"),
      );
  }
  if (state.view === "documents") {
    $("#outputs").replaceChildren();
    for (const kind of ["guides", "documents"]) {
      const data = await api(base + "/" + kind);
      for (const doc of data.items) {
        const item = node("div", undefined, "item");
        item.append(
          node(
            "strong",
            `${kind === "guides" ? "指南" : "文档"} · ${doc.title}`,
          ),
          node("span", "待人工复核", "badge"),
        );
        const actions = node("div", undefined, "row");
        for (const ext of ["html", "md", "json"])
          actions.append(
            button(ext.toUpperCase(), () =>
              protectedOpen(`${base}/${kind}/${doc.id}.${ext}`),
            ),
          );
        if (kind === "guides") {
          const job = doc.qaGeneration;
          item.append(
            node(
              "p",
              job?.status === "completed"
                ? `已整理 ${job.qaIds.length} 条问答，前往「问答审核」确认。`
                : job?.status === "failed"
                  ? `问答整理未完成：${job.error}`
                  : job?.status === "running"
                    ? "正在整理问答草稿……"
                    : "尚未整理问答。",
            ),
          );
          if (job?.status !== "completed")
            actions.append(
              button("生成 / 重试问答", async () => {
                notice("正在从已保存指南整理问答……");
                const result = await post(`${base}/guides/${doc.id}/qa`);
                notice(
                  result.status === "completed"
                    ? `已保存 ${result.qaIds.length} 条问答草稿。`
                    : `指南已保留，问答可重试：${result.error}`,
                  result.status === "failed",
                );
                await loadView();
              }),
            );
        }
        item.append(actions);
        $("#outputs").append(item);
      }
    }
    if (!$("#outputs").children.length)
      $("#outputs").append(
        node("p", "助手生成的文档与指南将保存在这里。", "empty"),
      );
  }
  if (state.view === "qa") {
    $("#qa-list").replaceChildren();
    const data = await api(base + "/qa");
    for (const q of data.items) {
      const item = node("div", undefined, "item");
      item.append(
        node("strong", q.question),
        node("p", q.answer),
        node("span", q.status === "verified" ? "已审核" : "草稿", "badge"),
      );
      if (q.source) item.append(node("small", "来自快速上手指南"));
      item.append(
        button(
          q.status === "verified" ? "退回草稿" : "确认可用于直答",
          async () => {
            await post(base + "/qa", {
              ...q,
              status: q.status === "verified" ? "draft" : "verified",
            });
            await loadView();
          },
        ),
      );
      $("#qa-list").append(item);
    }
    if (!data.items.length)
      $("#qa-list").append(
        node(
          "p",
          "指南生成后会自动整理问答草稿，也可以手动新增。审核通过后用于用户直答。",
          "empty",
        ),
      );
  }
}
async function stream(route, data, target, isPublic = false) {
  const controller = new AbortController();
  state.controller = controller;
  const r = await fetch(route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(!isPublic ? { "X-QA-Admin-Token": state.token } : {}),
    },
    body: JSON.stringify(data),
    signal: controller.signal,
  });
  if (!r.ok) {
    const d = await r.json();
    throw Error(d.error || "请求失败");
  }
  const answer = node("div", "", "message answer");
  target.append(answer);
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  let failed = false;
  let result;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split("\n"))
        if (line.startsWith("data: ")) {
          const e = JSON.parse(line.slice(6));
          if (e.type === "session" && !isPublic) state.session = e.sessionId;
          if (e.type === "guide_task" && !isPublic) {
            state.resumeTaskId = e.task.id;
            $("#guide-task-status").textContent = taskProgress(e.task);
            if (!state.guideTaskTimer && state.view === "agent")
              state.guideTaskTimer = setTimeout(
                () => loadView().catch((error) => notice(error.message, true)),
                2000,
              );
          }
          if (e.type === "skill")
            target.insertBefore(
              node("div", `使用 Skill：${e.name}`, "event"),
              answer,
            );
          if (e.type === "text") answer.textContent += e.text;
          if (e.type === "tool")
            target.insertBefore(
              node("div", `${e.name} · ${e.status}`, "event"),
              answer,
            );
          if (e.type === "qa_generation")
            target.insertBefore(
              node(
                "div",
                e.job.status === "running"
                  ? "指南已保存，正在整理 QA 草稿……"
                  : e.job.status === "completed"
                    ? `已保存 ${e.job.qaIds.length} 条 QA 草稿，待审核。`
                    : "QA 整理未完成，指南已保留，可单独重试。",
                "event",
              ),
              answer,
            );
          if (e.type === "qa")
            target.insertBefore(
              node(
                "div",
                `已审核问答 · ${e.tier} · 相似度 ${Number(e.score).toFixed(2)}`,
                "event",
              ),
              answer,
            );
          if (e.type === "done") {
            result = e.result;
            if (!answer.textContent) answer.textContent = e.result.answer;
          }
          if (e.type === "document" || e.type === "guide")
            target.insertBefore(
              node(
                "div",
                `已保存${e.type === "guide" ? "指南" : "文档"}：${e[e.type].title}`,
                "event",
              ),
              answer,
            );
          if (e.type === "error") {
            failed = true;
            answer.textContent += "\n" + e.error;
          }
        }
    }
    target.scrollTop = target.scrollHeight;
    if (done) break;
  }
  if (failed) throw Error("生成未完成，请检查提示。");
  if (!result) throw Error("连接已中断，指南进度已保留，可在指南任务中继续。");
  return result;
}
function taskProgress(task) {
  const status =
    {
      running: "处理中",
      paused: "已暂停，可继续",
      blocked: "受阻，待处理",
      completed: "完整指南已保存",
      partial: "指南已保存，部分场景未完成",
    }[task.status] || task.status;
  return `${status} · 已保存 ${task.modulesSaved}/${task.modulesTotal} 个模块 · 已核验 ${task.scenariosVerified}/${task.scenariosTotal} 个场景`;
}
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  state.token = $("#token").value.trim();
  sessionStorage.setItem("lumiwiki.token", state.token);
  try {
    await refresh();
    notice("管理台已连接。");
  } catch (err) {
    notice(err.message, true);
  }
};
$("#refresh").onclick = () => refresh().catch((e) => notice(e.message, true));
document
  .querySelectorAll("[data-view]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        setView(b.dataset.view).catch((e) => notice(e.message, true))),
  );
$("#project-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(e.target));
    await post("/api/projects", data);
    e.target.reset();
    await refresh();
    notice("项目已创建。");
  } catch (err) {
    notice(err.message, true);
  }
};
$("#project-settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const submit = e.target.querySelector("button");
  submit.disabled = true;
  try {
    const password = $("#public-browser-password").value;
    const url = $("#project-target-url").value;
    const targetChanged = url !== (state.project?.url || "");
    await api(requireProject(), {
      method: "PATCH",
      body: JSON.stringify({
        url,
        publicBrowser: {
          enabled: $("#public-browser-enabled").checked,
          url: $("#public-browser-url").value,
          username: $("#public-browser-username").value,
          ...($("#clear-public-password").checked
            ? { password: "" }
            : password
              ? { password }
              : {}),
        },
      }),
    });
    if (targetChanged) {
      state.browser = null;
      state.session = null;
      $("#browser-status").textContent =
        "浏览器未连接；仍可阅读已导入的知识库。";
    }
    await refresh();
    notice("当前项目的设置已保存，后续问答将使用这些配置。");
  } catch (err) {
    notice(err.message, true);
  } finally {
    submit.disabled = false;
  }
};
$("#wiki-upload").onchange = async (e) => {
  try {
    const files = await Promise.all(
      [...e.target.files].map(async (f) => ({
        name: f.name,
        content: await f.text(),
      })),
    );
    await post(requireProject() + "/wiki/import", { files });
    await loadView();
    notice("知识库已导入。");
  } catch (err) {
    notice(err.message, true);
  } finally {
    e.target.value = "";
  }
};
$("#generate-wiki").onclick = async () => {
  try {
    const base = requireProject(),
      projectKey = state.project.key;
    const task = await post(base + "/deepwiki/generate");
    if (task.from_cache) {
      await post(base + "/deepwiki/import");
      await loadView();
      notice("已导入现有 Wiki 缓存。");
      return;
    }
    notice("Wiki 生成任务已提交。");
    clearTimeout(state.taskTimer);
    async function poll() {
      try {
        const status = await api(
          `${base}/deepwiki/tasks/${encodeURIComponent(task.task_id)}`,
        );
        if (state.project?.key !== projectKey) return;
        $("#wiki-progress").textContent =
          `${status.status} · ${status.pages_done}/${status.pages_total} 页`;
        if (status.status === "completed") {
          await post(base + "/deepwiki/import");
          await loadView();
          notice("Wiki 生成完成，已自动导入。");
        } else if (status.status === "failed")
          notice("生成失败：" + status.error, true);
        else state.taskTimer = setTimeout(poll, 2000);
      } catch (e) {
        notice(e.message, true);
      }
    }
    await poll();
  } catch (e) {
    notice(e.message, true);
  }
};
$("#import-generated").onclick = async () => {
  try {
    await post(requireProject() + "/deepwiki/import");
    await loadView();
    notice("生成结果已导入。");
  } catch (e) {
    notice(e.message, true);
  }
};
$("#connect-browser").onclick = async () => {
  try {
    requireProject();
    const result = await post("/api/browser", {
      projectKey: state.project.key,
    });
    state.browser = result.id;
    state.session = null;
    $("#browser-status").textContent =
      `已连接 ${result.url}；可在弹出的独立浏览器中登录。`;
    notice("独立浏览器已连接。");
  } catch (e) {
    notice(e.message, true);
  }
};
$("#new-session").onclick = () => {
  state.session = null;
  state.resumeTaskId = null;
  state.acknowledgePending = false;
  $("#guide-task-status").textContent = "";
  $("#messages").replaceChildren(node("p", "新会话已就绪。", "empty"));
};
$("#ask-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    requireProject();
    const q = $("#question").value;
    $("#messages .empty")?.remove();
    $("#messages").append(node("div", q, "message"));
    $("#ask-button").disabled = true;
    $("#stop").hidden = false;
    const result = await stream(
      "/api/ask",
      {
        question: q,
        projectKey: state.project.key,
        sessionId: state.resumeTaskId ? undefined : state.session || undefined,
        taskId: $("#quick-start").checked
          ? state.resumeTaskId || undefined
          : undefined,
        acknowledgePending: state.acknowledgePending,
        browserId: state.browser || undefined,
        mode: $("#quick-start").checked ? "quick_start" : "chat",
      },
      $("#messages"),
    );
    $("#question").value = "";
    state.acknowledgePending = false;
    if (["completed", "partial"].includes(result.outcome))
      state.resumeTaskId = null;
    notice(
      result.outcome === "paused" || result.outcome === "blocked"
        ? "指南尚未完成，进度已保存，可继续任务。"
        : result.outcome === "partial"
          ? "指南已保存，部分场景存在限制，请查看生成产物。"
          : result.taskId
            ? "完整指南已保存。"
            : "本轮已完成。",
    );
  } catch (e) {
    notice(
      e.name === "AbortError" ? "运行已停止。" : e.message,
      e.name !== "AbortError",
    );
  } finally {
    $("#ask-button").disabled = false;
    $("#stop").hidden = true;
    state.controller = null;
    if (state.view === "agent") await loadView();
  }
};
$("#stop").onclick = () => state.controller?.abort();
$("#user-stop").onclick = () => state.controller?.abort();
$("#qa-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post(
      requireProject() + "/qa",
      Object.fromEntries(new FormData(e.target)),
    );
    e.target.reset();
    await loadView();
    notice("草稿已保存，审核后才会用于直答。");
  } catch (e) {
    notice(e.message, true);
  }
};
$("#user-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#user-question").value;
  $("#user-messages").append(node("div", q, "message"));
  $("#user-submit").disabled = true;
  $("#user-stop").hidden = false;
  try {
    await stream(
      "/api/v1/public/ask",
      { question: q },
      $("#user-messages"),
      true,
    );
    $("#user-question").value = "";
  } catch (e) {
    notice(e.name === "AbortError" ? "已停止。" : e.message, true);
  } finally {
    $("#user-submit").disabled = false;
    $("#user-stop").hidden = true;
    state.controller = null;
  }
};
if (["/user", "/help"].includes(location.pathname)) {
  document.body.classList.add("user-mode");
  $("#auth").hidden = true;
  $("#user").hidden = false;
  $("#heading").textContent = "系统使用助手";
  $(".header-right").hidden = true;
  api("/api/v1/public/config")
    .then((d) => {
      $("#user-title").textContent = d.name;
      for (const q of d.recommendedQuestions)
        $("#recommended").append(
          button(q, () => {
            $("#user-question").value = q;
          }),
        );
    })
    .catch((e) => notice(e.message, true));
} else if (state.token) refresh().catch((e) => notice(e.message, true));
