import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { ask, disposeConversations } from "../src/agent.js";
import {
  closeAllBrowsers,
  connectBrowser,
  getBrowser,
} from "../src/browser.js";
import { createProject, json, projectDir } from "../src/store.js";
import {
  GuideWorkflow,
  guideTaskActive,
  type GuideTask,
} from "../src/guide-workflow.js";
import { listQa } from "../src/qa.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-guide-agents-"));
config.data = tmp;
after(async () => {
  await disposeConversations();
  await closeAllBrowsers();
  await rm(tmp, { recursive: true, force: true });
});
function stream(
  res: http.ServerResponse,
  name?: string,
  args: unknown = {},
  content = "阶段已完成",
) {
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
    : { role: "assistant", content };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
const userText = (input: any) =>
  input.messages
    .filter((message: any) => message.role === "user")
    .map((message: any) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part: any) => part.text || "").join("\n"),
    )
    .join("\n");
const names = (input: any): string[] =>
  input.tools.map((tool: any) => tool.function.name);
const chapterId = (input: any) =>
  /"chapter"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/.exec(userText(input))?.[1];
const moduleId = (input: any) =>
  /"moduleId"\s*:\s*"([^"]+)"/.exec(userText(input))?.[1];
const check = {
  id: "balance",
  description: "账户余额可见",
  target: { text: "当前余额100元" },
  assertion: "visible",
};
const chapter = (id: string, url: string) => ({
  id,
  title: `账户任务${id}`,
  goal: `完成${id}任务`,
  scope: ["账户概览"],
  questions: [`如何完成${id}？`],
  entryUrls: [url + "/"],
});
const plan = (id: string) => ({
  title: `账户任务${id}`,
  audience: "账户用户",
  profile: "general",
  modules: [
    {
      id,
      title: `账户任务${id}`,
      coverageReason: "当前章节只读业务查询",
      scenarios: [
        {
          id: "read",
          kind: "success",
          goal: "查询当前账户余额",
          setup: "已有测试账户",
          cleanup: "只读无需清理",
          preconditions: [check],
          outcomes: [check],
        },
      ],
    },
  ],
});
const longInstruction = (id: string) =>
  `章节${id}独立业务说明。` +
  "进入账户概览，核对当前角色和账户信息，查看余额及其对应账户，切换账户后重新核对，不把其他账户的余额当作当前值。".repeat(
    10,
  );
const document = (id: string, imageId: string) => ({
  moduleId: id,
  title: `账户任务${id}`,
  summary: `章节${id}摘要`,
  details: `本章${id}补充解释。`.repeat(80),
  prerequisites: ["已登录正确的测试账户"],
  steps: [
    {
      title: "查看账户",
      instruction: longInstruction(id),
      images: [{ imageId, caption: "核对账户与余额" }],
    },
  ],
  coverage: [
    {
      question: `如何完成${id}？`,
      status: "covered",
      explanation: "查看账户步骤及补充解释完整说明操作与结果。",
    },
  ],
  references: [] as Array<{ kind: string; location: string }>,
});
async function fixture(
  handler: (input: any, res: http.ServerResponse, url: string) => void,
) {
  const web = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<h1>账户概览</h1><p>当前余额100元</p><label>备注<input value="原值"></label>',
    );
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(web.address() as any).port}`;
  const model = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      handler(JSON.parse(body), res, url);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  config.llm = {
    baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  const project = await createProject({ name: "章节隔离", url });
  const browser = await connectBrowser(project, true);
  return {
    project,
    browser,
    url,
    async close() {
      await getBrowser(browser.id, project.key).context.close();
      for (const server of [model, web]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
function chapterAction(
  input: any,
  res: http.ServerResponse,
  id: string,
  n: number,
  url: string,
  images: Map<string, string>,
  badImage?: string,
) {
  if (n === 5)
    images.set(
      id,
      JSON.parse(
        [...input.messages]
          .reverse()
          .find((message: any) => message.role === "tool").content,
      ).id,
    );
  const doc = document(id, badImage || images.get(id)!);
  doc.references = [{ kind: "page", location: url + "/" }];
  const actions: Array<[string?, unknown?]> = [
    ["browser_observe", {}],
    ["quick_start_plan", plan(id)],
    ["quick_start_begin", { moduleId: id, scenarioId: "read" }],
    ["quick_start_verify", {}],
    ["browser_screenshot", {}],
    ["document_write", doc],
    [undefined, {}],
  ];
  const [name, args] = actions[n] || [];
  stream(res, name, args, `${id.toUpperCase()}_PRIVATE_MODEL_TRACE`);
}

test("真实Pi逐章隔离、独立预算、拒绝跨章截图，宿主保留长正文且QA不重用探索上下文", async () => {
  const counts = { planner: 0, a: 0, b: 0, qaA: 0, qaB: 0 };
  const errors: string[] = [];
  let taskId: string;
  const images = new Map<string, string>();
  const previousBudget = config.quickStartMaxTools;
  config.quickStartMaxTools = 6;
  const f = await fixture((input, res, url) => {
    const tools = names(input),
      messages = JSON.stringify(input.messages);
    if (tools.includes("guide_outline")) {
      assert.ok(
        !tools.includes("document_write") && !tools.includes("image_annotate"),
      );
      const n = counts.planner++;
      if (n === 0)
        stream(res, "browser_act", {
          action: "fill",
          ref: "untrusted",
          value: "不能写入",
        });
      else if (n === 1) {
        assert.ok(messages.includes("全局初探只允许"));
        stream(res, "browser_observe");
      } else if (n === 2)
        stream(res, "guide_outline", {
          title: "完整账户指南",
          audience: "账户角色",
          overview: "覆盖两个独立账户任务。",
          chapters: [chapter("a", url), chapter("b", url)],
        });
      else stream(res, undefined, {}, "PLANNER_PRIVATE_MODEL_TRACE");
      return;
    }
    if (tools.includes("document_write")) {
      const id = chapterId(input)!;
      assert.ok(["a", "b"].includes(id));
      assert.ok(
        tools.includes("image_annotate") &&
          !tools.includes("qa_write") &&
          !tools.includes("guide_outline") &&
          !tools.includes("quick_start_publish"),
      );
      const n = id === "a" ? counts.a++ : counts.b++;
      if (n === 0) {
        assert.ok(!messages.includes("PLANNER_PRIVATE_MODEL_TRACE"));
        if (id === "b") {
          assert.ok(!messages.includes("A_PRIVATE_MODEL_TRACE"));
          assert.ok(!messages.includes(longInstruction("a")));
        }
        assert.ok(messages.includes("References are relative to"));
        assert.ok(!messages.includes("initial-qa/SKILL.md"));
      }
      if ((id === "a" && n === 6) || (id === "b" && n === 7)) {
        const saved = JSON.parse(
          readFileSync(
            path.join(projectDir(f.project.key), "runs", taskId + ".json"),
            "utf8",
          ),
        );
        assert.equal(
          saved.chapters.find((item: any) => item.spec.id === id).status,
          "generated",
          "章节提交工具返回前即完成持久化，不依赖模型最后一句回复",
        );
      }
      if (id === "b" && n === 5)
        return chapterAction(input, res, id, n, url, images, images.get("a"));
      if (id === "b" && n === 6) {
        assert.ok(messages.includes("本模块核验后的关键截图"));
        errors.push("cross-chapter-image-rejected");
        const doc = document("b", images.get("b")!);
        doc.references = [{ kind: "page", location: url + "/" }];
        stream(res, "document_write", doc);
        return;
      }
      chapterAction(input, res, id, n, url, images);
      return;
    }
    assert.deepEqual(tools, ["qa_write"]);
    const id = moduleId(input)!;
    assert.ok(!messages.includes("PRIVATE_MODEL_TRACE"));
    assert.ok(messages.includes(longInstruction(id)));
    assert.ok(!messages.includes(longInstruction(id === "a" ? "b" : "a")));
    const n = id === "a" ? counts.qaA++ : counts.qaB++;
    if (n === 0)
      stream(res, "qa_write", {
        moduleId: id,
        question: `如何完成${id}？`,
        answer: `打开账户概览并核对当前账户的余额。`,
      });
    else stream(res);
  });
  try {
    const events: any[] = [];
    await ask(
      f.project,
      {
        question: "生成完整账户快速上手指南",
        browserId: f.browser.id,
        mode: "quick_start",
      },
      (event) => {
        events.push(event);
        if (event.type === "session") taskId = String(event.taskId);
      },
      AbortSignal.timeout(30000),
    );
    const result = events.find((event) => event.type === "done")?.result;
    assert.equal(result?.complete, true, JSON.stringify(events));
    assert.deepEqual(counts, { planner: 4, a: 7, b: 8, qaA: 2, qaB: 2 });
    assert.deepEqual(errors, ["cross-chapter-image-rejected"]);
    const task = await json<GuideTask>(
      path.join(projectDir(f.project.key), "runs", result.taskId + ".json"),
    );
    assert.equal(task.chapters[0].lastAttempt?.toolCalls, 6);
    assert.equal(task.chapters[1].lastAttempt?.toolCalls, 6);
    assert.notEqual(
      task.chapters[0].lastAttempt?.sessionId,
      task.chapters[1].lastAttempt?.sessionId,
    );
    const md = await readFile(
      path.join(projectDir(f.project.key), "guides", result.guideId + ".md"),
      "utf8",
    );
    assert.ok(
      md.includes(longInstruction("a")) && md.includes(longInstruction("b")),
    );
    assert.equal((await listQa(f.project.key)).length, 2);
    assert.equal(
      await getBrowser(f.browser.id, f.project.key)
        .page.getByLabel("备注")
        .inputValue(),
      "原值",
    );
    assert.equal(getBrowser(f.browser.id, f.project.key).busy, false);
    assert.equal(guideTaskActive(f.project.key, result.taskId), false);
  } finally {
    config.quickStartMaxTools = previousBudget;
    await f.close();
  }
});

test("部分指南明确标记未完成；续跑跳过已保存章节和目录，仅补失败章及缺少的QA", async () => {
  let failB = true;
  let plannerCalls = 0,
    aCalls = 0,
    bCalls = 0,
    qaCalls = 0;
  const local = new Map<string, number>(),
    images = new Map<string, string>();
  const f = await fixture((input, res, url) => {
    const tools = names(input);
    if (tools.includes("guide_outline")) {
      const n = plannerCalls++;
      if (n === 0) stream(res, "browser_observe");
      else if (n === 1)
        stream(res, "guide_outline", {
          title: "可恢复指南",
          audience: "账户用户",
          overview: "两个任务分别生成。",
          chapters: [chapter("a", url), chapter("b", url)],
        });
      else stream(res);
      return;
    }
    if (tools.includes("document_write")) {
      const id = chapterId(input)!;
      const key = `${id}-${failB ? "first" : "retry"}`;
      const n = local.get(key) || 0;
      local.set(key, n + 1);
      if (id === "a") aCalls++;
      else bCalls++;
      if (id === "b" && failB) {
        if (n === 0)
          stream(res, "guide_chapter_block", {
            reason: "缺少本章需要的有效测试数据，请人工准备后继续",
          });
        else stream(res);
        return;
      }
      chapterAction(input, res, id, n, url, images);
      return;
    }
    assert.deepEqual(tools, ["qa_write"]);
    qaCalls++;
    const id = moduleId(input)!;
    if (!input.messages.some((message: any) => message.role === "tool"))
      stream(res, "qa_write", {
        moduleId: id,
        question: `如何完成${id}？`,
        answer: "打开账户概览，核对账户信息和余额。",
      });
    else stream(res);
  });
  try {
    const first: any[] = [];
    await ask(
      f.project,
      {
        question: "生成完整指南",
        browserId: f.browser.id,
        mode: "quick_start",
      },
      (event) => first.push(event),
      AbortSignal.timeout(30000),
    );
    const partial = first.find((event) => event.type === "done")?.result;
    assert.equal(partial.status, "partial");
    assert.equal(partial.complete, false);
    const original = await GuideWorkflow.load(f.project.key, partial.taskId);
    const firstDocument = original.chapter("a").documentId;
    assert.equal(aCalls, 7);
    assert.equal(bCalls, 2);
    failB = false;
    const second: any[] = [];
    await ask(
      f.project,
      {
        question: "继续任务",
        browserId: f.browser.id,
        taskId: partial.taskId,
        mode: "quick_start",
      },
      (event) => second.push(event),
      AbortSignal.timeout(30000),
    );
    const done = second.find((event) => event.type === "done")?.result;
    assert.equal(done.complete, true, JSON.stringify(second));
    assert.equal(done.guideId, partial.guideId);
    assert.equal(plannerCalls, 3);
    assert.equal(aCalls, 7, "已完成章节不重跑");
    assert.equal(bCalls, 9);
    assert.equal(qaCalls, 4, "首次只处理a，续跑只初始化b的QA");
    const restored = await GuideWorkflow.load(f.project.key, partial.taskId);
    assert.equal(restored.chapter("a").documentId, firstDocument);
    assert.equal(restored.chapter("b").attempts, 2);
    assert.equal((await listQa(f.project.key)).length, 2);
  } finally {
    await f.close();
  }
});

test("目录未提交不会伪装成功；预先取消的任务仍持久化且释放浏览器", async () => {
  let calls = 0;
  const f = await fixture((_input, res) => {
    calls++;
    stream(res);
  });
  try {
    const events: any[] = [];
    await ask(
      f.project,
      { question: "生成指南", browserId: f.browser.id, mode: "quick_start" },
      (event) => events.push(event),
      AbortSignal.timeout(30000),
    );
    const result = events.find((event) => event.type === "done")?.result;
    assert.equal(result.complete, false);
    assert.equal(result.status, "failed");
    assert.equal(calls, 3);
    assert.ok(!events.some((event) => event.type === "guide"));
    const controller = new AbortController();
    controller.abort();
    const cancelled: any[] = [];
    await ask(
      f.project,
      { question: "生成指南", browserId: f.browser.id, mode: "quick_start" },
      (event) => cancelled.push(event),
      controller.signal,
    );
    const done = cancelled.find((event) => event.type === "done")?.result;
    assert.equal(done.status, "cancelled");
    assert.equal(calls, 3);
    assert.equal(getBrowser(f.browser.id, f.project.key).busy, false);
    assert.equal(guideTaskActive(f.project.key, done.taskId), false);
    assert.equal(
      (await GuideWorkflow.load(f.project.key, done.taskId)).task.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("并发恢复不同任务也必须独占同一浏览器，异步加载不会绕过占用检查", async () => {
  let calls = 0;
  const f = await fixture((_input, res) => {
    calls++;
    stream(res);
  });
  try {
    const a = GuideWorkflow.create(f.project.key, "任务a"),
      b = GuideWorkflow.create(f.project.key, "任务b");
    await a.save();
    await b.save();
    const outcomes = await Promise.allSettled(
      [a, b].map((flow) =>
        ask(
          f.project,
          {
            question: "继续任务",
            taskId: flow.task.id,
            browserId: f.browser.id,
            mode: "quick_start",
          },
          () => {},
          AbortSignal.timeout(30000),
        ),
      ),
    );
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = outcomes.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.match(rejected.reason.message, /浏览器正忙/);
    assert.equal(calls, 3);
    assert.equal(getBrowser(f.browser.id, f.project.key).busy, false);
  } finally {
    await f.close();
  }
});

test("关闭项目会等待活动指南取消并落盘，再释放任务和浏览器锁", async () => {
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const f = await fixture(() => {
    notify();
  });
  try {
    const events: any[] = [];
    const running = ask(
      f.project,
      { question: "生成指南", browserId: f.browser.id, mode: "quick_start" },
      (event) => events.push(event),
      AbortSignal.timeout(30000),
    );
    await started;
    await disposeConversations(f.project.key);
    await running;
    const done = events.find((event) => event.type === "done")?.result;
    assert.equal(done.status, "cancelled");
    assert.equal(
      (await GuideWorkflow.load(f.project.key, done.taskId)).task.status,
      "cancelled",
    );
    assert.equal(guideTaskActive(f.project.key, done.taskId), false);
    assert.equal(getBrowser(f.browser.id, f.project.key).busy, false);
  } finally {
    await f.close();
  }
});
