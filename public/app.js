"use strict";
const $ = (selector) => document.querySelector(selector);
const state = {
  token: sessionStorage.getItem("lumiwiki.token") || "",
  project: null,
  projects: [],
  session: null,
  qaSession: null,
  browser: null,
  controller: null,
  view: "guides",
  taskTimer: null,
  guides: [],
  qa: [],
  selectedGuide: null,
  selectedQa: null,
  guideNames: {},
  previewEpoch: 0,
  imageUrls: [],
};
const descriptions = {
  guides: ["快速上手", "创建、阅读和管理这个项目的上手指南。"],
  qa: ["QA 问答", "生成的问答与人工整理的答案，统一保存在这里。"],
  config: ["项目配置", "项目、知识库和运行状态集中管理。"],
};
const toolLabels = {
  browser_observe: "观察页面",
  browser_inspect: "查看页面细节",
  browser_navigate: "打开任务页面",
  browser_act: "操作页面",
  browser_screenshot: "保存截图",
  browser_table: "读取表格",
  browser_wait: "等待页面更新",
  browser_login: "登录目标网页",
  wiki_read: "阅读知识库",
  image_annotate: "标注截图",
  document_write: "保存操作文档",
  quick_start_plan: "规划指南",
  quick_start_publish: "汇总指南",
};
function notice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
}
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function button(label, fn, cls) {
  const el = node("button", label, cls);
  el.type = "button";
  el.onclick = () =>
    Promise.resolve()
      .then(fn)
      .catch((error) => notice(error.message, true));
  return el;
}
async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-QA-Admin-Token": state.token,
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const error = Error(data.error || `请求失败 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const post = (route, data = {}) =>
  api(route, { method: "POST", body: JSON.stringify(data) });
function requireProject() {
  if (!state.project) throw Error("请先在项目配置中创建或切换项目");
  return `/api/projects/${state.project.key}`;
}
function busy(value) {
  $("#ask-button").disabled = value;
  $("#qa-ask-button").disabled = value;
  $("#project-select").disabled = value;
  $("#new-session").disabled = value;
}
function checkIdle() {
  if (state.controller)
    throw Error("请先停止正在运行的任务，再切换项目或浏览器");
}
async function setView(view) {
  state.view = view;
  document
    .querySelectorAll("[data-panel]")
    .forEach((el) => (el.hidden = el.dataset.panel !== view));
  document.querySelectorAll("[data-view]").forEach((el) => {
    el.classList.toggle("selected", el.dataset.view === view);
    el.setAttribute(
      "aria-current",
      el.dataset.view === view ? "page" : "false",
    );
  });
  $("#heading").textContent = descriptions[view][0];
  $("#view-description").textContent = descriptions[view][1];
  $("#new-guide").hidden = view !== "guides";
  $("#new-qa").hidden = view !== "qa";
  await loadView();
}
function clearImages() {
  state.previewEpoch++;
  state.imageUrls.forEach(URL.revokeObjectURL);
  state.imageUrls = [];
}
async function refresh() {
  const data = await api("/api/projects");
  const previous = state.project?.key;
  state.projects = data.projects;
  state.project =
    data.projects.find((project) => project.key === data.activeProjectId) ||
    null;
  if (previous !== state.project?.key) {
    clearImages();
    clearTimeout(state.taskTimer);
    state.session = null;
    state.qaSession = null;
    state.browser = null;
    state.selectedGuide = null;
    state.selectedQa = null;
    $("#messages").replaceChildren();
    $("#qa-messages").replaceChildren();
    $("#browser-status").textContent = "浏览器未连接；可以先阅读知识库。";
    $("#wiki-progress").textContent = "";
    const task =
      state.project &&
      sessionStorage.getItem("lumiwiki.wiki." + state.project.key);
    if (task) watchWiki(requireProject(), task);
  }
  $("#project-name").textContent = state.project?.name || "尚未选择项目";
  $("#project-select").replaceChildren();
  if (!data.projects.length)
    $("#project-select").append(new Option("尚未创建项目", ""));
  for (const project of data.projects)
    $("#project-select").append(
      new Option(
        project.name,
        project.key,
        false,
        project.key === state.project?.key,
      ),
    );
  $("#project-select").disabled = false;
  $("#auth").hidden = true;
  $("#admin").hidden = false;
  await loadView();
}
async function protectedOpen(route) {
  const response = await fetch(route, {
    headers: { "X-QA-Admin-Token": state.token },
  });
  if (!response.ok) throw Error("打开文件失败");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function loadView() {
  if (!state.project) {
    $("#outputs").replaceChildren();
    $("#qa-list").replaceChildren();
    $("#guide-count").textContent = "0 份";
    $("#qa-count").textContent = "0 条";
    $("#guide-detail").replaceChildren(
      node("p", "请先在项目配置中创建项目，然后生成指南。", "empty"),
    );
    $("#qa-detail").replaceChildren(
      node("p", "选择项目后，这里会显示保存的文字问答。", "empty"),
    );
    if (state.view === "config") await loadConfig();
    return;
  }
  const base = requireProject(),
    key = state.project.key;
  if (state.view === "guides") {
    const [guides, docs] = await Promise.all([
      api(base + "/guides"),
      api(base + "/documents"),
    ]);
    if (state.project?.key !== key) return;
    state.guides = [
      ...guides.items.map((doc) => ({ ...doc, kind: "guides" })),
      ...docs.items.map((doc) => ({ ...doc, kind: "documents" })),
    ].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    renderGuides();
  }
  if (state.view === "qa") {
    const [data, guides] = await Promise.all([
      api(base + "/qa"),
      api(base + "/guides"),
    ]);
    if (state.project?.key !== key) return;
    state.guideNames = Object.fromEntries(
      guides.items.map((guide) => [guide.id, guide.title]),
    );
    state.qa = data.items.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    renderQa();
  }
  if (state.view === "config") await loadConfig();
}
function record(title, meta, status, selected, fn) {
  const el = button("", fn, "record" + (selected ? " selected" : ""));
  el.setAttribute("aria-pressed", String(selected));
  const info = node("span", undefined, "record-meta");
  info.append(
    node("span", meta),
    node(
      "span",
      status,
      status === "待审核" || status === "待复核" ? "badge draft" : "badge",
    ),
  );
  el.append(node("strong", title), info);
  return el;
}
function renderGuides() {
  if (
    !state.guides.some((doc) => `${doc.kind}:${doc.id}` === state.selectedGuide)
  )
    state.selectedGuide = state.guides[0]
      ? `${state.guides[0].kind}:${state.guides[0].id}`
      : null;
  $("#guide-count").textContent = state.guides.length + " 份";
  $("#outputs").replaceChildren();
  for (const doc of state.guides) {
    const id = `${doc.kind}:${doc.id}`;
    $("#outputs").append(
      record(
        doc.title,
        doc.kind === "guides" ? `${doc.modules.length} 个模块` : "单篇文档",
        "待复核",
        state.selectedGuide === id,
        () => {
          state.selectedGuide = id;
          renderGuides();
        },
      ),
    );
  }
  renderGuide().catch((error) => notice(error.message, true));
}
async function renderGuide() {
  clearImages();
  const epoch = state.previewEpoch,
    base = state.project ? requireProject() : null;
  const target = $("#guide-detail");
  target.replaceChildren();
  const doc = state.guides.find(
    (doc) => `${doc.kind}:${doc.id}` === state.selectedGuide,
  );
  if (!doc) {
    target.append(
      node(
        "p",
        "还没有指南。点击「生成指南」，完成后会自动保存在这里。",
        "empty",
      ),
    );
    return;
  }
  target.append(
    node("span", "待人工复核", "badge draft"),
    node("h2", doc.title),
  );
  const actions = node("div", undefined, "actions");
  for (const ext of ["html", "md", "json"])
    actions.append(
      button(ext.toUpperCase(), () =>
        protectedOpen(`${base}/${doc.kind}/${doc.id}.${ext}`),
      ),
    );
  target.append(actions);
  if (doc.kind === "guides") {
    const job = doc.qaGeneration;
    target.append(
      node(
        "p",
        job?.status === "completed"
          ? `已整理 ${job.qaIds.length} 条问答，可到 QA 问答中审核。`
          : job?.status === "running"
            ? "正在整理文字问答草稿……"
            : job?.status === "failed"
              ? `问答整理失败：${job.error}`
              : "尚未整理问答。",
        "muted",
      ),
    );
    if (job?.status !== "completed")
      target.append(
        button("整理 / 重试 QA 草稿", async () => {
          notice("正在整理问答草稿……");
          const result = await post(`${base}/guides/${doc.id}/qa`);
          notice(
            result.status === "completed"
              ? `已保存 ${result.qaIds.length} 条文字问答草稿。`
              : `整理未完成：${result.error}`,
            result.status === "failed",
          );
          await loadView();
        }),
      );
  }
  for (const limit of doc.limitations || [])
    target.append(node("p", limit, "muted"));
  const modules =
    doc.kind === "guides"
      ? doc.modules
          .filter((module) => module.documentId)
          .map((module) =>
            state.guides.find(
              (item) =>
                item.kind === "documents" && item.id === module.documentId,
            ),
          )
          .filter(Boolean)
      : [doc];
  for (const module of modules) {
    const section = node("section", undefined, "doc-section");
    if (doc.kind === "guides") section.append(node("h3", module.title));
    if (module.summary) section.append(node("p", module.summary));
    for (const [index, step] of (module.steps || []).entries()) {
      section.append(
        node("h3", `${index + 1}. ${step.title}`),
        node("p", step.instruction),
      );
      if (step.imageId) {
        const img = document.createElement("img");
        img.alt = step.title;
        img.loading = "lazy";
        section.append(img);
        fetch(`${base}/artifacts/${step.imageId}.png`, {
          headers: { "X-QA-Admin-Token": state.token },
        })
          .then(async (response) => {
            if (!response.ok) throw Error("截图加载失败");
            const url = URL.createObjectURL(await response.blob());
            if (epoch !== state.previewEpoch) {
              URL.revokeObjectURL(url);
              return;
            }
            state.imageUrls.push(url);
            img.src = url;
          })
          .catch(() => {
            if (epoch === state.previewEpoch)
              img.replaceWith(node("p", "此步骤的截图暂时无法加载。", "muted"));
          });
      }
    }
    target.append(section);
  }
}
function renderQa() {
  if (!state.qa.some((qa) => qa.id === state.selectedQa))
    state.selectedQa = state.qa[0]?.id || null;
  $("#qa-count").textContent = state.qa.length + " 条";
  $("#qa-list").replaceChildren();
  for (const qa of state.qa)
    $("#qa-list").append(
      record(
        qa.question,
        qa.source ? "来自指南整理" : "人工 / 助手整理",
        qa.status === "verified" ? "已审核" : "待审核",
        state.selectedQa === qa.id,
        () => {
          state.selectedQa = qa.id;
          renderQa();
        },
      ),
    );
  const target = $("#qa-detail");
  target.replaceChildren();
  const qa = state.qa.find((qa) => qa.id === state.selectedQa);
  if (!qa) {
    target.append(
      node(
        "p",
        "还没有问答。可以向助手提问，或点击「新增问答」保存文字答案。",
        "empty",
      ),
    );
    return;
  }
  target.append(
    node(
      "span",
      qa.status === "verified" ? "已审核" : "待审核",
      qa.status === "verified" ? "badge" : "badge draft",
    ),
    node("h2", qa.question),
    node("p", qa.answer, "text-answer"),
  );
  if (qa.source)
    target.append(
      node(
        "p",
        "来自：" + (state.guideNames[qa.source.guideId] || "快速上手指南"),
        "source-label",
      ),
    );
  const actions = node("div", undefined, "actions");
  actions.append(
    button("编辑答案", () => editQa(qa)),
    button(
      qa.status === "verified" ? "退回草稿" : "✓ 通过审核",
      async () => {
        await post(requireProject() + "/qa", {
          ...qa,
          status: qa.status === "verified" ? "draft" : "verified",
        });
        await loadView();
      },
      qa.status === "verified" ? "" : "primary",
    ),
    button("删除", async () => {
      if (confirm("删除这条问答？")) {
        await api(requireProject() + "/qa/" + qa.id, { method: "DELETE" });
        await loadView();
      }
    }),
  );
  target.append(actions);
}
function editQa(qa) {
  const form = $("#qa-form");
  form.reset();
  for (const name of ["id", "question", "answer"])
    form.elements.namedItem(name).value = qa?.[name] || "";
  $("#qa-editor-title").textContent = qa ? "编辑问答" : "新增问答";
  $("#qa-editor").showModal();
}
async function loadConfig() {
  const status = await api("/api/v1/admin/status");
  $("#status-grid").replaceChildren();
  let dw = false;
  try {
    dw = (await api("/api/deepwiki/status")).available;
  } catch {}
  for (const [name, value] of [
    ["LumiWiki", "运行中"],
    ["聊天模型", status.modelConfigured ? "已配置" : "待配置"],
    ["图片输入", status.visionConfigured ? "已启用" : "未启用"],
    ["DeepWiki", dw ? "运行中" : "未连接"],
    [
      "Embedding / Judge",
      `${status.embeddingConfigured ? "已配置" : "待配置"} / ${status.judgeConfigured ? "已配置" : "待配置"}`,
    ],
  ]) {
    const row = node("div");
    row.append(node("span", name), node("strong", value));
    $("#status-grid").append(row);
  }
  $("#projects").replaceChildren();
  for (const project of state.projects) {
    const item = node("div", undefined, "item");
    item.append(
      node("strong", project.name),
      node("code", project.path || "无源码目录"),
      node("p", project.url || "未配置网页", "muted"),
    );
    const actions = node("div", undefined, "row");
    if (project.key !== state.project?.key)
      actions.append(button("切换项目", () => activate(project.key)));
    else actions.append(node("span", "当前项目", "badge"));
    actions.append(
      button("编辑", async () => {
        checkIdle();
        const name = prompt("项目名称", project.name);
        if (name === null) return;
        const url = prompt("目标网页", project.url || "");
        if (url === null) return;
        await api("/api/projects/" + project.key, {
          method: "PATCH",
          body: JSON.stringify({ name, ...(url ? { url } : {}) }),
        });
        await refresh();
      }),
    );
    item.append(actions);
    $("#projects").append(item);
  }
  $("#wiki-files").replaceChildren();
  $("#wiki-mode").textContent = "";
  if (!state.project) {
    $("#projects").append(node("p", "还没有项目，请先新建项目。", "empty"));
    return;
  }
  const key = state.project.key,
    base = requireProject();
  const data = await api(base + "/wiki");
  if (state.project?.key !== key) return;
  $("#wiki-mode").textContent =
    data.mode === "full" ? "全文注入" : "目录 + 按页读取";
  for (const file of data.files) {
    const item = node("div", undefined, "item");
    item.append(
      node("h3", file.name),
      node(
        "p",
        `${file.pages.length} 页 · ${file.totalChars.toLocaleString()} 字符`,
        "muted",
      ),
    );
    const details = node("details");
    details.append(node("summary", "查看页目录"));
    const list = node("ol");
    file.pages.forEach((page) => list.append(node("li", page.title)));
    details.append(list);
    item.append(details);
    const actions = node("div", undefined, "row");
    actions.append(
      button("查看 Markdown", () =>
        protectedOpen(`${base}/wiki/${file.id}.md`),
      ),
      button("删除", async () => {
        if (confirm(`删除知识库 ${file.name}？`)) {
          await api(`${base}/wiki/${file.id}`, { method: "DELETE" });
          await loadView();
        }
      }),
    );
    item.append(actions);
    $("#wiki-files").append(item);
  }
  if (!data.files.length)
    $("#wiki-files").append(
      node("p", "尚无知识库，可以从源码生成或导入 Markdown。", "empty"),
    );
}
async function activate(key) {
  checkIdle();
  await post(`/api/projects/${key}/activate`);
  await refresh();
  notice("已切换项目。");
}
async function connectBrowser() {
  checkIdle();
  requireProject();
  const result = await post("/api/browser", { projectKey: state.project.key });
  state.browser = result.id;
  state.session = null;
  state.qaSession = null;
  $("#browser-status").textContent =
    `已连接 ${result.url}；可在独立浏览器中登录。`;
  notice("目标网页已连接。");
}
async function stream(
  route,
  data,
  target,
  isPublic = false,
  sessionSlot = "session",
  onArtifact = () => {},
) {
  const controller = new AbortController();
  state.controller = controller;
  const response = await fetch(route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(!isPublic ? { "X-QA-Admin-Token": state.token } : {}),
    },
    body: JSON.stringify(data),
    signal: controller.signal,
  });
  if (!response.ok) {
    const error = await response.json();
    throw Error(error.error || "请求失败");
  }
  const answer = node("div", "", "message answer");
  target.append(answer);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    failed = false,
    finalAnswer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "session" && !isPublic)
          state[sessionSlot] = event.sessionId;
        if (event.type === "text") answer.textContent += event.text;
        if (event.type === "done") {
          finalAnswer = event.result.answer;
          answer.textContent = finalAnswer;
        }
        if (event.type === "guide" || event.type === "document")
          onArtifact(event);
        if (event.type === "error") {
          failed = true;
          answer.textContent += "\n" + event.error;
        }
        if (
          ["tool", "guide", "document", "qa_generation"].includes(event.type) &&
          !isPublic
        ) {
          const label =
            event.type === "tool"
              ? `${toolLabels[event.name] || "处理任务"} · ${{ start: "进行中", done: "完成", error: "未成功" }[event.status] || event.status}`
              : event.type === "qa_generation"
                ? {
                    running: "正在整理文字问答",
                    completed: "文字问答草稿已保存",
                    failed: "文字问答整理未完成",
                  }[event.job.status] || "正在整理问答"
                : `已保存${event.type === "guide" ? "指南" : "文档"}：${event[event.type].title}`;
          target.insertBefore(node("div", label, "event"), answer);
        }
      }
    }
    target.scrollTop = target.scrollHeight;
    if (done) break;
  }
  if (failed) throw Error("本轮未完成，请查看任务提示。");
  return finalAnswer || answer.textContent;
}
async function runGuide(event) {
  event.preventDefault();
  try {
    checkIdle();
    requireProject();
    const question = $("#question").value;
    $("#messages .empty")?.remove();
    $("#messages").append(node("div", question, "message"));
    busy(true);
    $("#stop").hidden = false;
    let saved = false;
    await stream(
      "/api/ask",
      {
        question,
        projectKey: state.project.key,
        sessionId: state.session || undefined,
        browserId: state.browser || undefined,
        mode: $("#quick-start").checked ? "quick_start" : "chat",
      },
      $("#messages"),
      false,
      "session",
      (event) => {
        saved = true;
        state.selectedGuide = `${event.type === "guide" ? "guides" : "documents"}:${event[event.type].id}`;
      },
    );
    $("#question").value = "";
    await loadView();
    notice(
      saved
        ? "本轮完成，生成产物已保存。"
        : "本轮已结束，未生成新的指南或文档，请查看任务结果。",
    );
  } catch (error) {
    notice(
      error.name === "AbortError" ? "运行已停止。" : error.message,
      error.name !== "AbortError",
    );
  } finally {
    busy(false);
    $("#stop").hidden = true;
    state.controller = null;
  }
}
async function runQa(event) {
  event.preventDefault();
  try {
    checkIdle();
    const base = requireProject(),
      question = $("#qa-question").value;
    $("#qa-messages").append(node("div", question, "message"));
    busy(true);
    $("#qa-stop").hidden = false;
    const answer = await stream(
      "/api/ask",
      {
        question,
        projectKey: state.project.key,
        browserId: state.browser || undefined,
        sessionId: state.qaSession || undefined,
        mode: "qa",
      },
      $("#qa-messages"),
      false,
      "qaSession",
    );
    if (!answer.trim()) throw Error("回答为空，未保存草稿。");
    const saved = await post(base + "/qa", {
      question,
      answer,
      status: "draft",
    });
    state.selectedQa = saved.id;
    $("#qa-question").value = "";
    await loadView();
    notice("文字问答已保存为草稿，审核后可用于用户直答。");
  } catch (error) {
    notice(
      error.name === "AbortError"
        ? "已停止，未保存未完成的答案。"
        : error.message,
      error.name !== "AbortError",
    );
  } finally {
    busy(false);
    $("#qa-stop").hidden = true;
    state.controller = null;
  }
}
function wikiLabel(status) {
  return (
    {
      pending: "任务已排队",
      indexing: "正在索引源码，首次生成需要一些时间",
      determining_structure: "正在规划 Wiki 目录",
      generating: `正在生成页面 · ${status.pages_done}/${status.pages_total} 页`,
      completed: "Wiki 生成完成",
      failed: "生成失败：" + status.error,
    }[status.status] || status.status
  );
}
function watchWiki(base, id) {
  clearTimeout(state.taskTimer);
  async function poll() {
    if (!state.project || base !== requireProject()) return;
    try {
      const status = await api(
        `${base}/deepwiki/tasks/${encodeURIComponent(id)}`,
      );
      if (base !== requireProject()) return;
      $("#wiki-progress").textContent = wikiLabel(status);
      if (status.status === "completed") {
        await post(base + "/deepwiki/import");
        sessionStorage.removeItem("lumiwiki.wiki." + state.project.key);
        await loadView();
        notice("Wiki 已完成并自动导入。");
      } else if (status.status === "failed") {
        sessionStorage.removeItem("lumiwiki.wiki." + state.project.key);
        notice("生成失败：" + status.error, true);
      } else state.taskTimer = setTimeout(poll, 2000);
    } catch (error) {
      if (base !== requireProject()) return;
      if (error.status === 404) {
        sessionStorage.removeItem("lumiwiki.wiki." + state.project.key);
        notice("任务记录已过期，可尝试导入已生成的 Wiki。", true);
      } else {
        notice("暂时无法读取生成进度，将自动重试。", true);
        state.taskTimer = setTimeout(poll, 5000);
      }
    }
  }
  poll();
}
$("#auth-form").onsubmit = async (event) => {
  event.preventDefault();
  state.token = $("#token").value.trim();
  try {
    await refresh();
    sessionStorage.setItem("lumiwiki.token", state.token);
    notice("管理台已连接。");
  } catch (error) {
    $("#token").setCustomValidity("管理口令无效或服务不可用");
    $("#token").reportValidity();
    $("#token").setCustomValidity("");
  }
};
$("#refresh").onclick = () =>
  refresh().catch((error) => notice(error.message, true));
document
  .querySelectorAll("[data-view]")
  .forEach(
    (el) =>
      (el.onclick = () =>
        setView(el.dataset.view).catch((error) => notice(error.message, true))),
  );
$("#project-select").onchange = (event) =>
  activate(event.target.value).catch((error) => {
    event.target.value = state.project?.key || "";
    notice(error.message, true);
  });
$("#project-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    checkIdle();
    await post("/api/projects", Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    await refresh();
    notice("项目已创建。");
  } catch (error) {
    notice(error.message, true);
  }
};
$("#new-guide").onclick = () => {
  $("#guide-composer").hidden = false;
  $("#question").focus();
};
$("#close-composer").onclick = () => {
  $("#guide-composer").hidden = true;
};
$("#connect-browser").onclick = () =>
  connectBrowser().catch((error) => notice(error.message, true));
$("#qa-connect-browser").onclick = $("#connect-browser").onclick;
$("#new-session").onclick = () => {
  state.session = null;
  $("#messages").replaceChildren(node("p", "新会话已就绪。", "empty"));
};
$("#ask-form").onsubmit = runGuide;
$("#qa-ask-form").onsubmit = runQa;
for (const id of ["stop", "qa-stop", "user-stop"])
  $("#" + id).onclick = () => state.controller?.abort();
$("#new-qa").onclick = () => editQa();
$("#close-qa-editor").onclick = () => $("#qa-editor").close();
$("#qa-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const data = Object.fromEntries(new FormData(event.target));
    const saved = await post(requireProject() + "/qa", {
      question: data.question,
      answer: data.answer,
      id: data.id || undefined,
      status: "draft",
    });
    state.selectedQa = saved.id;
    $("#qa-editor").close();
    await loadView();
    notice("文字问答已保存为草稿。");
  } catch (error) {
    notice(error.message, true);
  }
};
$("#wiki-upload").onchange = async (event) => {
  try {
    const files = await Promise.all(
      [...event.target.files].map(async (file) => ({
        name: file.name,
        content: await file.text(),
      })),
    );
    await post(requireProject() + "/wiki/import", { files });
    await loadView();
    notice("知识库已导入。");
  } catch (error) {
    notice(error.message, true);
  } finally {
    event.target.value = "";
  }
};
$("#generate-wiki").onclick = async () => {
  try {
    const base = requireProject(),
      task = await post(base + "/deepwiki/generate");
    if (task.from_cache) {
      await post(base + "/deepwiki/import");
      await loadView();
      notice("已导入现有 Wiki。");
      return;
    }
    sessionStorage.setItem("lumiwiki.wiki." + state.project.key, task.task_id);
    $("#wiki-progress").textContent = "Wiki 任务已提交，正在准备……";
    watchWiki(base, task.task_id);
  } catch (error) {
    notice(error.message, true);
  }
};
$("#import-generated").onclick = async () => {
  try {
    await post(requireProject() + "/deepwiki/import");
    await loadView();
    notice("Wiki 已导入。");
  } catch (error) {
    notice(error.message, true);
  }
};
$("#user-form").onsubmit = async (event) => {
  event.preventDefault();
  const question = $("#user-question").value;
  $("#user-messages").append(node("div", question, "message"));
  $("#user-submit").disabled = true;
  $("#user-stop").hidden = false;
  try {
    await stream("/api/v1/public/ask", { question }, $("#user-messages"), true);
    $("#user-question").value = "";
  } catch (error) {
    $("#user-messages").append(
      node(
        "p",
        error.name === "AbortError" ? "已停止。" : error.message,
        "error",
      ),
    );
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
  api("/api/v1/public/config")
    .then((data) => {
      $("#user-title").textContent = data.name;
      for (const question of data.recommendedQuestions)
        $("#recommended").append(
          button(question, () => {
            $("#user-question").value = question;
          }),
        );
    })
    .catch((error) =>
      $("#user-messages").append(node("p", error.message, "error")),
    );
} else if (state.token)
  refresh().catch((error) => {
    notice(error.message, true);
    sessionStorage.removeItem("lumiwiki.token");
  });
