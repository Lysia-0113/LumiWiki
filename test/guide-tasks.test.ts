import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { createProject, projectDir } from "../src/store.js";
import { ask, disposeConversations } from "../src/agent.js";
import {
  connectBrowser,
  closeBrowser,
  closeAllBrowsers,
} from "../src/browser.js";
import {
  getGuideTask,
  listGuideTasks,
  saveGuideTask,
  setGuideTaskActive,
} from "../src/guide-tasks.js";
import { QuickStartRun } from "../src/quick-start.js";
import { createServer } from "../src/server.js";
import { chromium } from "playwright";

const temp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-durable-"));
config.data = temp;
after(async () => {
  await disposeConversations();
  await closeAllBrowsers();
  await rm(temp, { recursive: true, force: true });
});
function stream(res: http.ServerResponse, name?: string, args: unknown = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = name
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { role: "assistant", content: "本轮结束" };
  res.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
async function server(handler: http.RequestListener) {
  const app = http.createServer(handler);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  return {
    app,
    url: `http://127.0.0.1:${(app.address() as any).port}`,
    close: async () => {
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
}
async function model(handler: (input: any, res: http.ServerResponse) => void) {
  const result = await server(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handler(JSON.parse(body), res);
  });
  config.llm = {
    baseUrl: result.url + "/v1",
    key: "fixture",
    model: "fixture",
  };
  return result;
}

test("指南超过120次工具调用仍运行，未发布任务明确暂停，普通问答仍有限额", async () => {
  const project = await createProject({ name: "unlimited" });
  const before = config.maxTools;
  config.maxTools = 1;
  let calls = 0;
  let phase: "guide" | "chat" = "guide";
  let chatBudgetError = false;
  const llm = await model((input, res) => {
    calls++;
    if (phase === "guide")
      stream(res, calls <= 121 ? "quick_start_status" : undefined);
    else {
      if (calls === 3)
        chatBudgetError = JSON.stringify(input.messages).includes(
          "工具调用预算已用完",
        );
      stream(res, calls <= 2 ? "quick_start_status" : undefined);
    }
  });
  try {
    const events: any[] = [];
    await ask(
      project,
      { question: "生成指南", mode: "quick_start" },
      (e) => events.push(e),
      AbortSignal.timeout(30000),
    );
    const done = events.find((e) => e.type === "done").result;
    assert.equal(done.outcome, "paused");
    const record = JSON.parse(
      await readFile(
        path.join(projectDir(project.key), "runs", done.runId + ".json"),
        "utf8",
      ),
    );
    assert.equal(record.toolCalls, 121);
    assert.equal(
      (await getGuideTask(project.key, done.taskId)).workflow.published,
      false,
    );
    phase = "chat";
    calls = 0;
    await ask(
      project,
      { question: "普通提问" },
      () => {},
      AbortSignal.timeout(10000),
    );
    assert.equal(chatBudgetError, true);
  } finally {
    config.maxTools = before;
    await llm.close();
  }
});

test("取消后进度落盘，重建会话和浏览器续跑，已保存模块与业务写入不重做", async () => {
  let writes = 0;
  const web = await server((req, res) => {
    if (req.method === "POST") {
      writes++;
      res.end("ok");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<h1>账户概览</h1><p>当前余额100元</p><button onclick="fetch('/create',{method:'POST'}).then(()=>document.querySelector('#result').textContent='已创建记录')">创建记录</button><div id="result">${writes ? "已创建记录" : "尚未创建"}</div>`,
    );
  });
  const project = await createProject({ name: "resume", url: web.url });
  let browser = await connectBrowser(project, true);
  const check = (id: string, text: string) => ({
    id,
    description: text,
    target: { text },
    assertion: "visible",
  });
  const plan = {
    title: "账户指南",
    audience: "用户",
    profile: "general",
    modules: [
      {
        id: "create",
        title: "创建记录",
        coverageReason: "成功场景",
        scenarios: [
          {
            id: "create-one",
            kind: "success",
            goal: "创建一条记录",
            setup: "已有账户",
            cleanup: "保留本次记录",
            preconditions: [check("ready", "账户概览")],
            outcomes: [check("created", "已创建记录")],
          },
        ],
      },
      {
        id: "balance",
        title: "查看余额",
        coverageReason: "只读场景",
        scenarios: [
          {
            id: "view",
            kind: "success",
            goal: "查看余额",
            setup: "已有账户",
            cleanup: "无需清理",
            preconditions: [check("ready", "账户概览")],
            outcomes: [check("balance", "当前余额100元")],
          },
        ],
      },
    ],
  };
  let stage: "first" | "blocked" | "resume" = "first";
  let index = 0;
  let buttonRef: string,
    imageId: string,
    firstDocumentId: string,
    secondDocumentId: string;
  const llm = await model((input, res) => {
    if (input.tools?.[0]?.function.name === "qa_write") {
      stream(res);
      return;
    }
    const result = [...input.messages]
      .reverse()
      .find((message: any) => message.role === "tool");
    let data: any;
    try {
      data = result ? JSON.parse(result.content) : undefined;
    } catch {
      data = { error: result.content };
    }
    if (stage === "first") {
      if (index === 1)
        buttonRef = data.elements.find((e: any) => e.label === "创建记录").ref;
      if (index === 7) imageId = data.id;
      if (index === 8)
        assert.ok(
          data.error.includes("模块已完成，请先用 document_write 保存"),
        );
      const actions: Array<[string, unknown]> = [
        ["browser_observe", {}],
        ["quick_start_plan", plan],
        ["quick_start_begin", { moduleId: "create", scenarioId: "create-one" }],
        ["browser_act", { action: "click", ref: buttonRef }],
        ["browser_wait", { checks: [check("created", "已创建记录")] }],
        ["quick_start_verify", {}],
        ["browser_screenshot", {}],
        ["browser_act", { action: "click", ref: buttonRef }],
        [
          "document_write",
          {
            moduleId: "create",
            title: "创建记录",
            summary: "创建一条记录。",
            steps: [
              {
                title: "创建",
                instruction: "点击创建记录按钮，完成后显示已创建记录。",
                imageId,
              },
            ],
            references: [{ kind: "page", location: web.url + "/" }],
          },
        ],
      ];
      const action = actions[index++];
      stream(res, action?.[0], action?.[1]);
    } else if (stage === "blocked") {
      index++;
      stream(res, index <= 5 ? "browser_act" : undefined, {
        action: "click",
        ref: "interrupted-submit",
      });
    } else {
      if (index === 0) {
        const context = JSON.stringify(input.messages);
        assert.ok(context.includes(firstDocumentId));
        assert.ok(context.includes("不重复创建或提交业务数据"));
      }
      if (index === 3) imageId = data.id;
      if (index === 4) secondDocumentId = data.id;
      const actions: Array<[string, unknown]> = [
        ["quick_start_begin", { moduleId: "balance", scenarioId: "view" }],
        ["quick_start_verify", {}],
        ["browser_screenshot", {}],
        [
          "document_write",
          {
            moduleId: "balance",
            title: "查看余额",
            summary: "查看当前账户余额。",
            steps: [
              {
                title: "查看",
                instruction: "打开账户概览查看当前余额。",
                imageId,
              },
            ],
            references: [{ kind: "page", location: web.url + "/" }],
          },
        ],
        [
          "quick_start_publish",
          {
            modules: [
              { moduleId: "create", documentId: firstDocumentId },
              { moduleId: "balance", documentId: secondDocumentId },
            ],
          },
        ],
      ];
      const action = actions[index++];
      stream(res, action?.[0], action?.[1]);
    }
  });
  try {
    const abort = new AbortController();
    const events: any[] = [];
    await assert.rejects(
      ask(
        project,
        {
          question: "创建一条记录并生成账户指南",
          browserId: browser.id,
          mode: "quick_start",
        },
        (event) => {
          events.push(event);
          if (event.type === "document") {
            firstDocumentId = (event.document as any).id;
            abort.abort();
          }
        },
        abort.signal,
      ),
    );
    const taskId = events.find((event) => event.type === "guide_task").task.id;
    const saved = await getGuideTask(project.key, taskId);
    assert.equal(saved.status, "paused");
    assert.equal(saved.workflow.documents.create, firstDocumentId!);
    assert.equal(writes, 1);
    await disposeConversations(project.key);
    await closeBrowser(browser.id, project.key);
    await assert.rejects(
      ask(
        project,
        { question: "继续", taskId, mode: "quick_start" },
        () => {},
        new AbortController().signal,
      ),
      /请先连接目标网页/,
    );
    browser = await connectBrowser(project, true);
    // A crash journal must prevent retrying a potentially completed write.
    const interrupted = await getGuideTask(project.key, taskId);
    interrupted.pendingAction = {
      tool: "browser_act",
      at: new Date().toISOString(),
    };
    await saveGuideTask(interrupted);
    stage = "blocked";
    index = 0;
    const blocked: any[] = [];
    await ask(
      project,
      { question: "继续", taskId, browserId: browser.id, mode: "quick_start" },
      (event) => blocked.push(event),
      AbortSignal.timeout(10000),
    );
    assert.equal(writes, 1);
    assert.equal(
      blocked.find((event) => event.type === "done").result.outcome,
      "blocked",
    );
    assert.ok((await getGuideTask(project.key, taskId)).pendingAction);
    stage = "resume";
    index = 0;
    const resumed: any[] = [];
    await ask(
      project,
      { question: "继续", taskId, browserId: browser.id, mode: "quick_start" },
      (event) => resumed.push(event),
      AbortSignal.timeout(30000),
    );
    assert.equal(writes, 1, "恢复不得再次创建记录");
    assert.equal(
      resumed.find((event) => event.type === "done").result.outcome,
      "completed",
    );
    const completed = await getGuideTask(project.key, taskId);
    assert.equal(completed.id, saved.id);
    assert.equal(completed.status, "completed");
    assert.equal(Object.keys(completed.workflow.documents).length, 2);
    assert.ok(resumed.some((event) => event.type === "guide"));
  } finally {
    await llm.close();
    await web.close();
  }
});

test("进程中断后的运行标记与待核对操作可恢复，API按项目和口令隔离任务", async () => {
  const project = await createProject({ name: "snapshot" });
  const other = await createProject({ name: "other" });
  const run = new QuickStartRun();
  run.reset();
  const now = new Date().toISOString();
  await saveGuideTask({
    version: 1,
    id: run.runId,
    projectId: project.key,
    sessionId: randomUUID(),
    question: "任务",
    status: "running",
    createdAt: now,
    updatedAt: now,
    browserRequired: true,
    pendingAction: { tool: "browser_act", at: now },
    workflow: run.report(),
    context: {
      wikiIds: [],
      documentIds: [],
      screenshotIds: [],
      observedUrls: [],
      seenControls: [],
      guideIds: [],
    },
  });
  const [summary] = await listGuideTasks(project.key);
  assert.equal(summary.status, "paused");
  assert.equal(summary.requiresReview, true);
  await assert.rejects(getGuideTask(other.key, run.runId), /不存在/);
  await assert.rejects(getGuideTask(project.key, "../outside"), /标识无效/);
  config.token = "test-admin";
  const api = createServer();
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  config.port = (api.address() as any).port;
  const base = `http://127.0.0.1:${config.port}`;
  try {
    assert.equal(
      (await fetch(`${base}/api/projects/${project.key}/tasks`)).status,
      403,
    );
    const response = await fetch(`${base}/api/projects/${project.key}/tasks`, {
      headers: { "X-QA-Admin-Token": config.token },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.items[0].requiresReview, true);
    assert.equal(body.items[0].status, "paused");
    await fetch(`${base}/api/projects/${project.key}/activate`, {
      method: "POST",
      headers: {
        "X-QA-Admin-Token": config.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.locator("#token").fill(config.token);
      await page.locator("#auth-form button").click();
      await page.locator("#admin").waitFor({ state: "visible" });
      setGuideTaskActive(project.key, run.runId, true);
      await page.locator('#nav [data-view="guides"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#guide-tasks")?.textContent?.includes("处理中"),
      );
      setGuideTaskActive(project.key, run.runId, false);
      await page.getByRole("button", { name: "继续任务" }).waitFor();
      assert.ok(
        (await page.locator("#guide-tasks").textContent())?.includes(
          "已暂停，可继续",
        ),
      );
      await page.reload();
      await page.locator("#admin").waitFor({ state: "visible" });
      await page.locator('#nav [data-view="guides"]').click();
      await page.getByRole("button", { name: "继续任务" }).waitFor();
      let submissions = 0;
      page.on("request", (request) => {
        if (request.url().endsWith("/api/ask")) submissions++;
      });
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.getByRole("button", { name: "继续任务" }).click();
      assert.equal(submissions, 0, "尚未人工核对的中断写操作不能恢复执行");
    } finally {
      await browser.close();
    }
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

test("跨模块有实际进展时由原生Pi持续续跑，不受两次收尾次数限制", async () => {
  const project = await createProject({ name: "progress" });
  const check = {
    id: "ready",
    description: "页面存在",
    target: { text: "目标" },
    assertion: "visible",
  };
  const modules = Array.from({ length: 4 }, (_, i) => ({
    id: `module-${i}`,
    title: `模块${i}`,
    coverageReason: "确认权限",
    scenarios: [
      {
        id: "case",
        kind: "permission",
        goal: "检查权限",
        setup: "当前账号",
        cleanup: "无需清理",
        preconditions: [check],
        outcomes: [check],
      },
    ],
  }));
  let calls = 0;
  const llm = await model((_input, res) => {
    const call = calls++;
    if (call === 0)
      stream(res, "quick_start_plan", {
        title: "权限指南",
        audience: "用户",
        profile: "general",
        modules,
      });
    else if (call <= 8 && call % 2 === 1)
      stream(res, "quick_start_block", {
        moduleId: `module-${(call - 1) / 2}`,
        scenarioId: "case",
        reason: "当前账号没有该模块的权限",
      });
    else stream(res);
  });
  try {
    const events: any[] = [];
    await ask(
      project,
      { question: "检查四个模块的访问权限", mode: "quick_start" },
      (e) => events.push(e),
      AbortSignal.timeout(15000),
    );
    const done = events.find((e) => e.type === "done").result;
    const saved = await getGuideTask(project.key, done.taskId);
    assert.equal(
      saved.workflow.scenarios.filter((s) => s.status === "blocked").length,
      4,
    );
    assert.equal(done.outcome, "blocked");
    assert.equal(saved.workflow.continuations, 3);
  } finally {
    await llm.close();
  }
});
