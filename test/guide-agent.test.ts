import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
        content,
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
const document = (id: string, imageId: string, url: string) => ({
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
  references: [{ kind: "page", location: url + "/" }],
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
function assertHandoff(input: any) {
  assert.deepEqual(names(input).sort(), [
    "guide_chapter_block",
    "guide_chapter_ready",
    "guide_research_gap",
  ]);
}
function verifiedImage(input: any) {
  const result = [...input.messages]
    .reverse()
    .filter((message: any) => message.role === "tool")
    .map((message: any) => {
      try {
        return JSON.parse(message.content);
      } catch {
        return undefined;
      }
    })
    .find((result: any) => result?.screenshot?.id);
  assert.ok(result?.screenshot?.id, "核验工具应自动返回截图，无需单独截图调用");
  return result.screenshot.id as string;
}
function chapterAction(
  input: any,
  res: http.ServerResponse,
  id: string,
  n: number,
  url: string,
  images: Map<string, string>,
  limited = false,
) {
  assert.ok(!names(input).includes("document_write"));
  if (n === 4) {
    assertHandoff(input);
    const imageId = verifiedImage(input);
    images.set(id, imageId);
    stream(res, "guide_chapter_ready", {
      answers: [
        {
          question: `如何完成${id}？`,
          status: limited ? "limited" : "covered",
          explanation: limited
            ? "只能确认余额可见，其他操作未核实。"
            : "账户概览显示当前账户余额100元。",
        },
      ],
      references: [{ kind: "page", location: url + "/" }],
      images: [{ imageId, caption: "核对账户与余额" }],
    });
    return;
  }
  const actions: Array<[string, unknown]> = [
    ["browser_observe", {}],
    ["quick_start_plan", plan(id)],
    ["quick_start_begin", { moduleId: id, scenarioId: "read" }],
    ["quick_start_verify", {}],
  ];
  assert.ok(actions[n], "冻结后不应再请求探索模型收尾");
  const [name, args] = actions[n];
  stream(res, name, args, `${id.toUpperCase()}_PRIVATE_MODEL_TRACE`);
}
function assertWriter(input: any, id: string, imageId: string) {
  assert.deepEqual(names(input), ["document_write"]);
  assert.equal(
    input.messages.filter((message: any) => message.role === "user").length,
    1,
  );
  const text = userText(input);
  const brief = JSON.parse(text);
  assert.equal(brief.phase, "writer");
  assert.equal(brief.chapter.id, id);
  assert.equal(brief.images[0].imageId, imageId);
  assert.ok(
    brief.answers.length &&
      brief.references.length &&
      brief.verifiedTasks.length,
  );
  for (const privateContext of [
    "PRIVATE_MODEL_TRACE",
    "quick_start_verify",
    "initial-qa/SKILL.md",
    "directory",
    "previousAttempt",
    "<skill",
  ])
    assert.ok(!text.includes(privateContext), privateContext);
  assert.ok(!text.includes(longInstruction(id === "a" ? "b" : "a")));
}

test("原生Pi隔离planner、探索、writer及逐章QA；独立预算且拒绝跨章图片和伪造来源", async () => {
  const counts = {
    planner: 0,
    a: 0,
    b: 0,
    writerA: 0,
    writerB: 0,
    qaA: 0,
    qaB: 0,
  };
  const errors: string[] = [];
  const images = new Map<string, string>();
  const previousBudget = config.quickStartMaxTools;
  const previousWriterBudget = config.guideWriterMaxTools;
  config.quickStartMaxTools = 5;
  config.guideWriterMaxTools = 3;
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
        stream(res, "browser_observe", {}, "PLANNER_PRIVATE_MODEL_TRACE");
      } else {
        assert.equal(n, 2, "目录成功后宿主立即结束，不请求模型收尾");
        stream(res, "guide_outline", {
          title: "完整账户指南",
          audience: "账户角色",
          overview: "覆盖两个独立账户任务。",
          chapters: [chapter("a", url), chapter("b", url)],
        });
      }
      return;
    }
    if (tools.includes("guide_chapter_ready")) {
      const id = chapterId(input)!;
      assert.ok(["a", "b"].includes(id));
      const n = id === "a" ? counts.a++ : counts.b++;
      if (n === 0) {
        assert.ok(!messages.includes("PRIVATE_MODEL_TRACE"));
        assert.ok(!messages.includes(longInstruction("a")));
        assert.ok(messages.includes("References are relative to"));
        assert.ok(!messages.includes("initial-qa/SKILL.md"));
      }
      chapterAction(input, res, id, n, url, images);
      return;
    }
    if (tools.includes("document_write")) {
      const id = chapterId(input)!;
      const n = id === "a" ? counts.writerA++ : counts.writerB++;
      if (n === 0) assertWriter(input, id, images.get(id)!);
      assert.deepEqual(tools, ["document_write"]);
      if (id === "b" && n === 0) {
        stream(res, "document_write", document(id, images.get("a")!, url));
      } else if (id === "b" && n === 1) {
        assert.ok(messages.includes("本模块核验后的关键截图"));
        errors.push("cross-chapter-image-rejected");
        const doc = document(id, images.get(id)!, url);
        doc.references = [{ kind: "page", location: url + "/never-observed" }];
        stream(res, "document_write", doc);
      } else {
        assert.equal(n, id === "a" ? 0 : 2, "正文成功后不能请求ack");
        if (id === "b") {
          assert.ok(messages.includes("网页引用必须在当前章节会话实际观察过"));
          errors.push("unobserved-source-rejected");
        }
        stream(res, "document_write", document(id, images.get(id)!, url));
      }
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
        answer: "打开账户概览并核对当前账户的余额。",
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
      (event) => events.push(event),
      AbortSignal.timeout(30000),
    );
    const result = events.find((event) => event.type === "done")?.result;
    assert.equal(result?.complete, true, JSON.stringify(events));
    assert.deepEqual(counts, {
      planner: 3,
      a: 5,
      b: 5,
      writerA: 1,
      writerB: 3,
      qaA: 2,
      qaB: 2,
    });
    assert.deepEqual(errors, [
      "cross-chapter-image-rejected",
      "unobserved-source-rejected",
    ]);
    const task = await json<GuideTask>(
      path.join(projectDir(f.project.key), "runs", result.taskId + ".json"),
    );
    for (const saved of task.chapters) {
      assert.equal(saved.status, "generated");
      assert.ok(saved.documentId && saved.evidenceId);
      assert.equal(saved.lastAttempt?.toolCalls, 5);
    }
    assert.notEqual(
      task.chapters[0].lastAttempt?.sessionId,
      task.chapters[1].lastAttempt?.sessionId,
    );
    assert.deepEqual(
      task.performance
        ?.filter((item) => item.phase === "writer")
        .map((item) => item.toolCalls),
      [1, 3],
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
    config.guideWriterMaxTools = previousWriterBudget;
    await f.close();
  }
});

test("部分指南明确标记未完成；续跑跳过已保存章节和目录，仅补失败章及缺少的QA", async () => {
  let failB = true;
  const counts = { planner: 0, a: 0, b: 0, writerA: 0, writerB: 0, qa: 0 };
  const local = new Map<string, number>(),
    images = new Map<string, string>();
  const f = await fixture((input, res, url) => {
    const tools = names(input);
    if (tools.includes("guide_outline")) {
      const n = counts.planner++;
      if (n === 0) stream(res, "browser_observe");
      else {
        assert.equal(n, 1);
        stream(res, "guide_outline", {
          title: "可恢复指南",
          audience: "账户用户",
          overview: "两个任务分别生成。",
          chapters: [chapter("a", url), chapter("b", url)],
        });
      }
      return;
    }
    if (tools.includes("guide_chapter_ready")) {
      const id = chapterId(input)!;
      const key = `${id}-${failB ? "first" : "retry"}`;
      const n = local.get(key) || 0;
      local.set(key, n + 1);
      if (id === "a") counts.a++;
      else counts.b++;
      if (id === "b" && failB) {
        assert.equal(n, 0, "受阻后不请求模型收尾");
        stream(res, "guide_chapter_block", {
          reason: "缺少本章需要的有效测试数据，请人工准备后继续",
        });
      } else chapterAction(input, res, id, n, url, images);
      return;
    }
    if (tools.includes("document_write")) {
      const id = chapterId(input)!;
      assertWriter(input, id, images.get(id)!);
      if (id === "a") counts.writerA++;
      else counts.writerB++;
      stream(res, "document_write", document(id, images.get(id)!, url));
      return;
    }
    assert.deepEqual(tools, ["qa_write"]);
    counts.qa++;
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
    assert.deepEqual(counts, {
      planner: 2,
      a: 5,
      b: 1,
      writerA: 1,
      writerB: 0,
      qa: 2,
    });
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
    assert.deepEqual(counts, {
      planner: 2,
      a: 5,
      b: 6,
      writerA: 1,
      writerB: 1,
      qa: 4,
    });
    const restored = await GuideWorkflow.load(f.project.key, partial.taskId);
    assert.equal(restored.chapter("a").documentId, firstDocument);
    assert.equal(restored.chapter("b").attempts, 2);
    assert.equal((await listQa(f.project.key)).length, 2);
  } finally {
    await f.close();
  }
});

test("writer失败后保留冻结证据，续跑只写作不操作UI，limited事实不能升级为covered", async () => {
  let retry = false,
    plannerCalls = 0,
    exploreCalls = 0,
    writerCalls = 0;
  const images = new Map<string, string>();
  const f = await fixture((input, res, url) => {
    const tools = names(input);
    if (tools.includes("guide_outline")) {
      assert.ok(!retry);
      if (plannerCalls++ === 0) stream(res, "browser_observe");
      else
        stream(res, "guide_outline", {
          title: "有限指南",
          audience: "账户用户",
          overview: "只记录已确认事实。",
          chapters: [chapter("a", url)],
        });
    } else if (tools.includes("guide_chapter_ready")) {
      assert.ok(!retry, "恢复writer不得重新探索");
      chapterAction(input, res, "a", exploreCalls++, url, images, true);
    } else if (tools.includes("document_write")) {
      assert.deepEqual(tools, ["document_write"]);
      const n = writerCalls++;
      if (!retry) {
        stream(res);
        return;
      }
      if (n === 2) assertWriter(input, "a", images.get("a")!);
      else
        assert.ok(
          JSON.stringify(input.messages).includes(
            "写作不能把未核实事实升级为已覆盖",
          ),
        );
      const doc = document("a", images.get("a")!, url);
      if (n > 2) {
        doc.coverage[0].status = "limited";
        doc.coverage[0].explanation = "只能确认余额可见，其他操作未核实。";
      }
      stream(res, "document_write", doc);
    } else {
      assert.deepEqual(tools, ["qa_write"]);
      if (!input.messages.some((message: any) => message.role === "tool"))
        stream(res, "qa_write", {
          moduleId: "a",
          question: "如何完成a？",
          answer: "余额可查看，其他操作尚未核实。",
        });
      else stream(res);
    }
  });
  try {
    const first: any[] = [];
    await ask(
      f.project,
      { question: "生成指南", browserId: f.browser.id, mode: "quick_start" },
      (event) => first.push(event),
      AbortSignal.timeout(30000),
    );
    const failed = first.find((event) => event.type === "done")?.result;
    const before = await GuideWorkflow.load(f.project.key, failed.taskId);
    assert.equal(before.chapter("a").status, "failed");
    assert.ok(before.chapter("a").evidenceId);
    assert.equal(before.chapter("a").stage, "writing");
    assert.equal(writerCalls, 2);
    retry = true;
    const second: any[] = [];
    await ask(
      f.project,
      {
        question: "继续任务",
        browserId: f.browser.id,
        taskId: failed.taskId,
        mode: "quick_start",
      },
      (event) => second.push(event),
      AbortSignal.timeout(30000),
    );
    const done = second.find((event) => event.type === "done")?.result;
    assert.equal(done.complete, false, "保留limited覆盖，不伪装完整指南");
    const restored = await GuideWorkflow.load(f.project.key, failed.taskId);
    assert.equal(restored.chapter("a").status, "generated");
    assert.equal(restored.chapter("a").coverageComplete, false);
    assert.equal(
      restored.chapter("a").evidenceId,
      before.chapter("a").evidenceId,
    );
    assert.equal(restored.chapter("a").version, before.chapter("a").version);
    assert.deepEqual(
      restored.chapter("a").lastAttempt,
      before.chapter("a").lastAttempt,
    );
    assert.equal(plannerCalls, 2);
    assert.equal(exploreCalls, 5);
    assert.equal(writerCalls, 4);
    assert.ok(
      second
        .filter((event) => event.type === "tool")
        .every(
          (event) =>
            event.name === "document_write" || event.name === "qa_write",
        ),
    );
  } finally {
    await f.close();
  }
});

test("核验截图后立即handoff；定向研究只读、仅一次，耗尽独立小预算强制返回handoff", async () => {
  const previousResearchBudget = config.guideResearchMaxTools,
    previousBudget = config.quickStartMaxTools;
  config.guideResearchMaxTools = 2;
  config.quickStartMaxTools = 9;
  let plannerCalls = 0,
    calls = 0;
  const images = new Map<string, string>();
  const f = await fixture((input, res, url) => {
    const tools = names(input),
      messages = JSON.stringify(input.messages);
    if (tools.includes("guide_outline")) {
      if (plannerCalls++ === 0) stream(res, "browser_observe");
      else
        stream(res, "guide_outline", {
          title: "补充指南",
          audience: "账户用户",
          overview: "按问题补充事实。",
          chapters: [chapter("a", url)],
        });
    } else if (tools.includes("guide_chapter_ready")) {
      const n = calls++;
      if (n < 4) {
        chapterAction(input, res, "a", n, url, images);
        return;
      }
      if (n === 4 || n === 7) {
        assertHandoff(input);
        if (n === 4) images.set("a", verifiedImage(input));
        stream(res, "guide_research_gap", {
          questions: ["如何完成a？"],
          reason: "补充核对余额查询入口的说明",
        });
      } else if (n === 5 || n === 6) {
        assert.ok(tools.includes("browser_observe"));
        for (const forbidden of [
          "guide_research_gap",
          "quick_start_plan",
          "quick_start_verify",
          "document_write",
        ])
          assert.ok(!tools.includes(forbidden));
        if (n === 5)
          stream(res, "browser_act", {
            action: "fill",
            ref: "untrusted",
            value: "不能写入",
          });
        else {
          assert.ok(messages.includes("全局初探只允许"));
          stream(res, "browser_observe");
        }
      } else {
        assert.equal(n, 8);
        assertHandoff(input);
        assert.ok(messages.includes("每章只能申请一次"));
        chapterAction(input, res, "a", 4, url, images);
      }
    } else if (tools.includes("document_write")) {
      assertWriter(input, "a", images.get("a")!);
      stream(res, "document_write", document("a", images.get("a")!, url));
    } else {
      assert.deepEqual(tools, ["qa_write"]);
      if (!input.messages.some((message: any) => message.role === "tool"))
        stream(res, "qa_write", {
          moduleId: "a",
          question: "如何完成a？",
          answer: "打开账户概览查看余额。",
        });
      else stream(res);
    }
  });
  try {
    const events: any[] = [];
    await ask(
      f.project,
      { question: "生成指南", browserId: f.browser.id, mode: "quick_start" },
      (event) => events.push(event),
      AbortSignal.timeout(30000),
    );
    assert.equal(
      events.find((event) => event.type === "done")?.result.complete,
      true,
      JSON.stringify(events),
    );
    assert.equal(calls, 9);
    assert.deepEqual(
      events
        .filter((event) => event.type === "agent_phase" && event.stage)
        .map((event) => event.stage),
      ["handoff", "research", "handoff"],
    );
    assert.equal(
      await getBrowser(f.browser.id, f.project.key)
        .page.getByLabel("备注")
        .inputValue(),
      "原值",
    );
  } finally {
    config.guideResearchMaxTools = previousResearchBudget;
    config.quickStartMaxTools = previousBudget;
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
