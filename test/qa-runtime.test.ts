import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { atomic, createProject, json, projectDir } from "../src/store.js";
import type { QaFinish } from "../src/qa-result.js";
import { importWiki } from "../src/knowledge.js";
import { createServer } from "../src/server.js";
import { disposeConversations } from "../src/agent.js";
import { closeAllBrowsers } from "../src/browser.js";
import { listQa, matchQa, saveQa } from "../src/qa.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-qa-runtime-"));
config.data = tmp;
config.token = "qa-runtime-fixture";
config.vision = false;
const servers: http.Server[] = [];
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

type Request = {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
};
let requests: Request[] = [];
let reads: Array<{ pageId: string; section?: number }> = [];
let replyMode:
  | "success"
  | "empty"
  | "error"
  | "partial"
  | "plain"
  | "cutoff"
  | "after_finish_error"
  | "duplicate_finish"
  | "browser" = "success";
let finishOverrides: Partial<QaFinish> = {};
let beforeFinish: (() => Promise<void>) | undefined;
let partialClosed: (() => void) | undefined;
const answer =
  "方法一：点击「Search」，输入记得的关键词，再点击搜索。\n方法二：打开「Calendar」，按日期查找笔记。";
const modelUrl = await listen(
  http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input: Request = JSON.parse(raw);
    if (req.url?.endsWith("/embeddings")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      return;
    }
    requests.push(input);
    if (replyMode === "error") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture model failed" } }));
      return;
    }
    if (replyMode === "partial") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.once("close", () => partialClosed?.());
      res.write(
        `data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "尚未完成的回答" }, finish_reason: null }] })}\n\n`,
      );
      return;
    }
    const resultCount = input.messages.filter((m) => m.role === "tool").length;
    const read = reads[resultCount];
    const finished =
      resultCount > reads.length + (replyMode === "browser" ? 1 : 0);
    if (beforeFinish && !read && !finished) {
      const action = beforeFinish;
      beforeFinish = undefined;
      await action();
    }
    if (replyMode === "after_finish_error" && finished) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "failed after qa_finish" } }));
      return;
    }
    const finish: QaFinish = {
      outcome: "answered",
      answer,
      scope: "general",
      evidence: [
        ...new Set(system(input).match(/[a-f0-9-]{36}:p\d+/g) || []),
      ].map((location) => ({ kind: "doc", location })),
      ...finishOverrides,
    };
    const name = read
      ? "wiki_read"
      : replyMode === "browser" && resultCount === 0
        ? "browser_observe"
        : !["empty", "plain", "cutoff"].includes(replyMode) &&
            (!finished ||
              (replyMode === "duplicate_finish" &&
                resultCount === reads.length + 1))
          ? "qa_finish"
          : undefined;
    const delta = name
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + randomUUID(),
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "browser_observe" ? {} : read || finish,
                ),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content:
            replyMode === "empty"
              ? " "
              : finished
                ? "已提交，不应重复展示。"
                : answer,
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : replyMode === "cutoff" ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  }),
);
config.llm = { baseUrl: modelUrl + "/v1", key: "fixture", model: "fixture" };
Object.assign(process.env, {
  PUBLIC_LLM_BASE_URL: modelUrl + "/v1",
  PUBLIC_LLM_API_KEY: "fixture",
  PUBLIC_LLM_MODEL: "fixture",
  PUBLIC_LLM_VISION: "false",
  LLM_MAX_TOKENS: "512",
});
const appUrl = await listen(createServer());
config.port = Number(new URL(appUrl).port);
after(async () => {
  await disposeConversations();
  await closeAllBrowsers();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(tmp, { recursive: true, force: true });
});

async function eventsFor(
  projectKey: string,
  publicMode: boolean,
  question = "怎么查找之前的笔记？",
) {
  requests = [];
  const response = await fetch(
    appUrl + (publicMode ? "/api/v1/public/ask" : "/api/ask"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(publicMode ? {} : { "X-QA-Admin-Token": config.token }),
      },
      body: JSON.stringify({
        projectKey,
        question,
        ...(publicMode ? {} : { mode: "qa" }),
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.ok(response.ok, JSON.stringify(events));
  return events;
}

async function ask(projectKey: string, publicMode: boolean) {
  const events = await eventsFor(projectKey, publicMode);
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  assert.equal(events.find((e) => e.type === "done")?.result.answer, answer);
  return [...requests];
}

const system = (request: Request) =>
  request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
const tools = (request: Request) =>
  request.tools?.map((t) => t.function.name) || [];

test("管理与用户 QA 共用普通用户提示词，小库全文注入且不混入其他项目或指南工作流", async () => {
  const project = await createProject({
    name: "笔记项目",
    publicBrowser: { enabled: false },
  });
  await importWiki(
    project,
    "notes.md",
    "# 查找笔记\n点击 Search，输入关键词后搜索。也可以打开 Calendar 按日期找笔记。",
  );
  const other = await createProject({
    name: "其他项目",
    publicBrowser: { enabled: false },
  });
  await importWiki(
    other,
    "other.md",
    "# 其他项目\nOTHER_PROJECT_PRIVATE_CONTENT",
  );
  await atomic(path.join(tmp, "deployment.json"), {
    activeProjectId: other.key,
  });
  reads = [];
  const [admin] = await ask(project.key, false);
  const [user] = await ask(project.key, true);
  assert.equal(system(admin), system(user));
  for (const input of [admin, user]) {
    const prompt = system(input);
    assert.ok(prompt.includes("点击 Search，输入关键词后搜索"));
    assert.ok(prompt.includes("回答面向普通用户"));
    assert.ok(prompt.includes("通常控制在200字以内"));
    assert.ok(!prompt.includes("OTHER_PROJECT_PRIVATE_CONTENT"));
    assert.ok(!prompt.includes("先用受限导航探查各任务页面"));
    assert.ok(!prompt.includes("结论区分知识库描述和实际页面观察"));
    assert.ok(!prompt.includes("References are relative to"));
    assert.deepEqual(tools(input), ["qa_finish"]);
  }
});

test("两端 QA 大库按目录调用 wiki_read，支持小节且拒绝跨项目读取", async () => {
  const project = await createProject({
    name: "大知识库",
    publicBrowser: { enabled: false },
  });
  const file = await importWiki(
    project,
    "notes.md",
    "# Page: 查找笔记\n## 关键词\nSEARCH_BODY_ONLY：点击 Search 并输入关键词。\n## 日期\nCALENDAR_BODY_ONLY：打开 Calendar，选择日期查看笔记。",
  );
  const other = await createProject({ name: "隔离项目" });
  const foreign = await importWiki(
    other,
    "foreign.md",
    "# 保密\nFOREIGN_WIKI_BODY",
  );
  reads = [
    { pageId: foreign.pages[0].id },
    { pageId: file.pages[0].id, section: 2 },
    { pageId: file.pages[0].id },
  ];
  const originalLimit = config.wikiLimit;
  config.wikiLimit = 1;
  try {
    const admin = await ask(project.key, false);
    const user = await ask(project.key, true);
    assert.equal(system(admin[0]), system(user[0]));
    for (const inputs of [admin, user]) {
      assert.equal(inputs.length, 5);
      assert.deepEqual(tools(inputs[0]), ["qa_finish", "wiki_read"]);
      assert.ok(system(inputs[0]).includes(file.pages[0].id));
      assert.ok(!system(inputs[0]).includes("SEARCH_BODY_ONLY"));
      const results = inputs.at(-1)!.messages.filter((m) => m.role === "tool");
      assert.ok(results[0].content.includes("找不到这一页"));
      const section = JSON.parse(results[1].content);
      assert.equal(section.section, 2);
      assert.ok(section.content.includes("CALENDAR_BODY_ONLY"));
      assert.ok(!section.content.includes("SEARCH_BODY_ONLY"));
      const page = JSON.parse(results[2].content);
      assert.ok(page.content.includes("SEARCH_BODY_ONLY"));
      assert.ok(page.content.includes("CALENDAR_BODY_ONLY"));
      assert.ok(!JSON.stringify(inputs).includes("FOREIGN_WIKI_BODY"));
    }
  } finally {
    config.wikiLimit = originalLimit;
  }
});

test("未导入 Wiki 时两端 QA 仍可运行，不声明不存在的读取工具", async () => {
  const project = await createProject({
    name: "空知识库",
    publicBrowser: { enabled: false },
  });
  reads = [];
  const [admin] = await ask(project.key, false);
  const [user] = await ask(project.key, true);
  assert.equal(system(admin), system(user));
  assert.deepEqual(tools(admin), ["qa_finish"]);
  assert.deepEqual(tools(user), ["qa_finish"]);
  assert.ok(!system(user).includes("知识库全文："));
  assert.ok(!system(user).includes("目录（按 pageId"));
});

test("首次AI回答保存为可用未核验QA；后续直接复用，状态独立且不产生重复条目", async () => {
  const project = await createProject({
    name: "用户回答审核",
    publicBrowser: { enabled: false },
  });
  await importWiki(
    project,
    "notes.md",
    "# 查找笔记\n点击 Search 搜索，或在 Calendar 按日期查找。",
  );
  reads = [];
  const question = "怎么查找之前的笔记？";
  const firstEvents = await eventsFor(project.key, true);
  assert.equal(requests.length, 2);
  assert.equal(
    firstEvents.find((e) => e.type === "done")?.result.qaStatus,
    "draft",
  );
  assert.equal(firstEvents.find((e) => e.type === "qa")?.tier, "generated");
  const getQa = async (isPublic: boolean) => {
    const response = await fetch(
      appUrl +
        (isPublic
          ? `/api/v1/public/qa?project=${project.key}`
          : `/api/projects/${project.key}/qa`),
      { headers: isPublic ? {} : { "X-QA-Admin-Token": config.token } },
    );
    assert.ok(response.ok);
    return (await response.json()).items;
  };
  const [draft] = await getQa(false);
  assert.equal(draft.question, question);
  assert.equal(draft.answer, answer);
  assert.equal(draft.status, "draft");
  assert.equal(draft.enabled, true);
  assert.equal(draft.origin, "public");
  assert.equal(draft.provenance.evidence[0].kind, "doc");
  assert.equal(
    firstEvents.find((e) => e.type === "done")?.result.admission.decision,
    "admitted",
  );
  assert.ok(!JSON.stringify(firstEvents).includes("sha256"));
  assert.equal((await getQa(true))[0].status, "draft");
  assert.equal((await matchQa(project.key, question)).decision, "direct");

  await ask(project.key, true);
  assert.equal(requests.length, 0, "未核验答案可复用，不调用 Agent");
  assert.equal((await getQa(false)).length, 1, "直答不产生重复QA");
  assert.equal((await getQa(false))[0].usage.directAnswers, 1);

  const update = async (input: unknown) => {
    const response = await fetch(appUrl + `/api/projects/${project.key}/qa`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-QA-Admin-Token": config.token,
      },
      body: JSON.stringify(input),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const edited = await update({
    id: draft.id,
    question,
    answer,
    status: "draft",
  });
  assert.equal(edited.origin, "public");
  const patch = async (input: unknown) => {
    const response = await fetch(
      appUrl + `/api/projects/${project.key}/qa/${draft.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-QA-Admin-Token": config.token,
        },
        body: JSON.stringify(input),
      },
    );
    assert.ok(response.ok);
    return response.json();
  };
  await Promise.all([patch({ status: "verified" }), patch({ enabled: false })]);
  const [disabled] = await getQa(false);
  assert.equal(disabled.status, "verified");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.usage.directAnswers, 1);
  assert.deepEqual(await getQa(true), []);
  assert.equal((await matchQa(project.key, question)).decision, "agent");
  const publicConfig = await (
    await fetch(appUrl + `/api/v1/public/config?project=${project.key}`)
  ).json();
  assert.deepEqual(publicConfig.recommendedQuestions, []);
  await patch({ enabled: true });
  assert.equal((await getQa(true)).length, 1);
  const events = await eventsFor(project.key, true);
  assert.equal(requests.length, 0, "审核后复用已有答案，不调用模型");
  assert.ok(events.some((e) => e.type === "qa" && e.qa.id === draft.id));
  assert.equal(
    events.find((e) => e.type === "done")?.result.qaStatus,
    "verified",
  );
  const saved = await getQa(false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].usage.directAnswers, 2);
  assert.equal(saved.find((q: any) => q.id === draft.id).status, "verified");
  await patch({ status: "draft" });
  assert.equal((await getQa(false))[0].enabled, true);
  assert.equal((await getQa(true))[0].status, "draft");
  await Promise.all(
    Array.from({ length: 5 }, () => eventsFor(project.key, true)),
  );
  assert.equal(
    (await getQa(false))[0].usage.directAnswers,
    7,
    "并发计数不丢失",
  );
});

test("直答把完整实际问法记入原QA，不产生重复条目或改动核验状态", async () => {
  const project = await createProject({
    name: "直答记录",
    publicBrowser: { enabled: false },
  });
  const question = "笔记".repeat(8000);
  const verified = await saveQa(project.key, {
    question: "怎么查找之前的笔记？",
    answer,
    aliases: [question],
    status: "verified",
  });
  const events = await eventsFor(project.key, true, question);
  assert.ok(events.some((e) => e.type === "done"));
  assert.equal(requests.length, 0);
  const all = await listQa(project.key);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].usage?.recentQuestions, [question]);
  assert.equal(all[0].usage?.directAnswers, 1);
  assert.equal(all.find((q) => q.id === verified.id)?.status, "verified");
});
test("未核验QA可通过语义匹配复用，停用候选不影响匹配或生成重复QA", async () => {
  const project = await createProject({
    name: "未核验语义复用",
    publicBrowser: { enabled: false },
  });
  const qa = await saveQa(project.key, {
    question: "怎么找以前的笔记？",
    answer,
  });
  await saveQa(project.key, {
    question: "停用的问题",
    answer: "停用答案",
    enabled: false,
  });
  const keys = ["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL"];
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    EMBEDDING_BASE_URL: modelUrl + "/v1",
    EMBEDDING_API_KEY: "fixture",
    EMBEDDING_MODEL: "fixture",
  });
  try {
    const events = await eventsFor(project.key, true, "在哪里搜索旧笔记？");
    const hit = events.find((e) => e.type === "qa");
    assert.equal(hit.qa.id, qa.id);
    assert.equal(hit.qa.status, "draft");
    assert.equal(hit.tier, "high");
    assert.equal(requests.length, 0, "语义命中不调用回答模型");
    assert.equal((await listQa(project.key)).length, 2);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test("模型失败和空答案不会写入待审核 QA", async () => {
  const project = await createProject({
    name: "失败回答",
    publicBrowser: { enabled: false },
  });
  reads = [];
  try {
    for (const mode of ["error", "empty"] as const) {
      replyMode = mode;
      const events = await eventsFor(project.key, true);
      assert.ok(events.some((e) => e.type === "error"));
      assert.ok(!events.some((e) => e.type === "done"));
      assert.deepEqual(await listQa(project.key), []);
    }
  } finally {
    replyMode = "success";
  }
});

test(
  "用户中途停止时不把流式片段保存为待审核 QA",
  { timeout: 20000 },
  async () => {
    const project = await createProject({
      name: "停止回答",
      publicBrowser: { enabled: false },
    });
    const closed = new Promise<void>((resolve) => {
      partialClosed = resolve;
    });
    const controller = new AbortController();
    replyMode = "partial";
    try {
      const response = await fetch(appUrl + "/api/v1/public/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: project.key,
          question: "怎么搜索？",
        }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("尚未完成的回答")) {
        const chunk = await reader.read();
        assert.ok(!chunk.done);
        text += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      await reader.cancel().catch(() => {});
      await closed;
      assert.deepEqual(await listQa(project.key), []);
    } finally {
      controller.abort();
      replyMode = "success";
      partialClosed = undefined;
    }
  },
);

test("澄清、证据不足和账号动态结果正常回答，但不成为下次直答", async () => {
  reads = [];
  try {
    for (const result of [
      {
        outcome: "needs_clarification",
        scope: "general",
        answer: "你指的是哪个模块的提交操作？",
      },
      {
        outcome: "insufficient_evidence",
        scope: "general",
        answer: "现有资料不足，无法确认退款入口。",
      },
      {
        outcome: "answered",
        scope: "context_specific",
        answer: "当前账号有3条待审批记录。",
      },
    ] as const) {
      const project = await createProject({
        name: result.outcome,
        publicBrowser: { enabled: false },
      });
      await importWiki(
        project,
        "notes.md",
        "# 操作\n可查询待审批记录，按所属模块提交。",
      );
      finishOverrides = result;
      const first = await eventsFor(project.key, true, "怎么提交？");
      const done = first.find((e) => e.type === "done").result;
      assert.equal(done.answer, result.answer);
      assert.equal(done.answerOutcome, result.outcome);
      assert.equal(done.admission.decision, "skipped");
      assert.equal(done.qaId, null);
      assert.ok(!first.some((e) => e.type === "qa" || e.type === "error"));
      const again = await eventsFor(project.key, true, "怎么提交？");
      assert.equal(requests.length, 2, "不能把澄清等输出固化为精确直答");
      assert.equal(
        again.find((e) => e.type === "done").result.admission.decision,
        "skipped",
      );
      assert.deepEqual(await listQa(project.key), []);
      const attempts = await readdir(
        path.join(projectDir(project.key), "qa-attempts"),
      );
      assert.equal(attempts.length, 2);
      const attempt = await json<any>(
        path.join(projectDir(project.key), "qa-attempts", attempts[0]),
      );
      assert.equal(attempt.result.outcome, result.outcome);
    }
  } finally {
    finishOverrides = {};
  }
});

test("模型未提交结构化结果时仍显示文字，但不推测其可复用性", async () => {
  const project = await createProject({
    name: "unclassified",
    publicBrowser: { enabled: false },
  });
  await importWiki(project, "notes.md", "# 查找\n点击 Search。");
  reads = [];
  replyMode = "plain";
  try {
    const events = await eventsFor(project.key, true);
    const done = events.find((e) => e.type === "done").result;
    assert.equal(done.answer, answer);
    assert.equal(done.answerOutcome, "unclassified");
    assert.equal(done.admission.reason, "no_result");
    assert.deepEqual(await listQa(project.key), []);
  } finally {
    replyMode = "success";
  }
});

test("qa_finish不能引用未读取的目录页或其他项目证据", async () => {
  const project = await createProject({
    name: "unread",
    publicBrowser: { enabled: false },
  });
  const local = await importWiki(project, "local.md", "# 本地\nLOCAL_CONTENT");
  const other = await createProject({ name: "foreign" });
  const foreign = await importWiki(
    other,
    "foreign.md",
    "# 外部\nFOREIGN_SECRET",
  );
  const limit = config.wikiLimit;
  config.wikiLimit = 1;
  reads = [];
  try {
    for (const location of [local.pages[0].id, foreign.pages[0].id]) {
      finishOverrides = { evidence: [{ kind: "doc", location }] };
      const events = await eventsFor(project.key, true);
      assert.equal(
        events.find((e) => e.type === "done").result.answerOutcome,
        "unclassified",
      );
      assert.ok(
        requests
          .at(-1)!
          .messages.some(
            (m) => m.role === "tool" && m.content.includes("实际读取"),
          ),
      );
      assert.ok(!JSON.stringify(requests).includes("FOREIGN_SECRET"));
      assert.deepEqual(await listQa(project.key), []);
    }
  } finally {
    config.wikiLimit = limit;
    finishOverrides = {};
  }
});

test("完整结构化结果只展示一次；重复finish不能覆盖已提交结果", async () => {
  const project = await createProject({
    name: "finish-once",
    publicBrowser: { enabled: false },
  });
  await importWiki(project, "notes.md", "# 查找\n点击 Search。");
  reads = [];
  replyMode = "duplicate_finish";
  try {
    const events = await eventsFor(project.key, true);
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
      answer,
    );
    assert.equal(
      events.find((e) => e.type === "done").result.admission.decision,
      "admitted",
    );
    assert.ok(
      requests
        .at(-1)!
        .messages.some(
          (m) => m.role === "tool" && m.content.includes("已经提交"),
        ),
    );
    assert.equal((await listQa(project.key)).length, 1);
  } finally {
    replyMode = "success";
  }
});

test("提交finish后模型失败或输出截断时，都不执行QA入库", async () => {
  reads = [];
  try {
    for (const mode of ["after_finish_error", "cutoff"] as const) {
      const project = await createProject({
        name: mode,
        publicBrowser: { enabled: false },
      });
      await importWiki(project, "notes.md", "# 查找\n点击 Search。");
      replyMode = mode;
      const events = await eventsFor(project.key, true);
      assert.ok(events.some((e) => e.type === "error"));
      assert.ok(!events.some((e) => e.type === "done" || e.type === "qa"));
      assert.deepEqual(await listQa(project.key), []);
    }
  } finally {
    replyMode = "success";
  }
});

test("运行期间Wiki被替换时，旧会话证据不能使新答案自动入库", async () => {
  const project = await createProject({
    name: "wiki-race",
    publicBrowser: { enabled: false },
  });
  await importWiki(project, "notes.md", "# 查找\n旧版搜索入口。");
  reads = [];
  beforeFinish = () =>
    importWiki(project, "notes.md", "# 查找\n新版入口已迁移。").then(() => {});
  try {
    const events = await eventsFor(project.key, true);
    const done = events.find((e) => e.type === "done").result;
    assert.equal(done.answer, answer);
    assert.equal(done.admission.reason, "stale_evidence");
    assert.deepEqual(await listQa(project.key), []);
  } finally {
    beforeFinish = undefined;
  }
});

test("实际浏览器观察不能被模型省略引用后伪装成纯Wiki自动入库", async () => {
  const webUrl = await listen(
    http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<main><h1>查找笔记</h1><button>Search</button><p>当前账号有3条笔记</p></main>",
      );
    }),
  );
  const project = await createProject({
    name: "browser-admission",
    url: webUrl,
    publicBrowser: { enabled: true },
  });
  await importWiki(project, "notes.md", "# 查找\n点击 Search。");
  const headless = process.env.BROWSER_HEADLESS;
  process.env.BROWSER_HEADLESS = "true";
  reads = [];
  replyMode = "browser";
  try {
    const events = await eventsFor(project.key, true);
    const done = events.find((e) => e.type === "done").result;
    assert.equal(done.answer, answer);
    assert.equal(done.admission.decision, "candidate");
    assert.equal(done.qaId, null);
    assert.ok(!events.some((e) => e.type === "qa" || e.type === "error"));
    assert.ok(!JSON.stringify(events).includes("browserId"));
    assert.ok(!JSON.stringify(events).includes(webUrl));
    const [candidate] = await listQa(project.key);
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.status, "draft");
    assert.ok(candidate.provenance?.evidence.some((e) => e.kind === "page"));
    assert.equal(
      (await matchQa(project.key, candidate.question)).decision,
      "agent",
    );
    const listed = await (
      await fetch(appUrl + `/api/v1/public/qa?project=${project.key}`)
    ).json();
    assert.deepEqual(listed.items, []);
  } finally {
    replyMode = "success";
    if (headless === undefined) delete process.env.BROWSER_HEADLESS;
    else process.env.BROWSER_HEADLESS = headless;
    await closeAllBrowsers();
  }
});

test("相同新问题并发生成后由入库门禁合并，不新增重复QA", async () => {
  const project = await createProject({
    name: "concurrent",
    publicBrowser: { enabled: false },
  });
  await importWiki(project, "notes.md", "# 查找\n点击 Search。");
  reads = [];
  const results = await Promise.all([
    eventsFor(project.key, true),
    eventsFor(project.key, true),
  ]);
  assert.ok(results.every((events) => events.some((e) => e.type === "done")));
  const decisions = results
    .map(
      (events) =>
        events.find((e) => e.type === "done").result.admission.decision,
    )
    .sort();
  assert.deepEqual(decisions, ["admitted", "duplicate"]);
  assert.equal((await listQa(project.key)).length, 1);
});
