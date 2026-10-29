import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { atomic, createProject, json, projectDir } from "../src/store.js";
import { generateGuideQa, type GuideBundle } from "../src/quick-start-qa.js";
import { listQa, matchQa, saveQa } from "../src/qa.js";
import { connectBrowser, closeAllBrowsers } from "../src/browser.js";
import { ask, disposeConversations } from "../src/agent.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-qa-"));
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
  content = "完成",
) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = name
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + randomUUID(),
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { role: "assistant", content };
  res.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
async function serve(handler: (data: any, res: http.ServerResponse) => void) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    handler(body ? JSON.parse(body) : {}, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.llm = {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
}
async function guideFixture(ids = ["task"]) {
  const p = await createProject({ name: "qa fixture" });
  const guide: GuideBundle = {
    id: randomUUID(),
    title: "上手指南",
    modules: [],
  };
  for (const id of ids) {
    const documentId = randomUUID();
    guide.modules.push({ id, title: id, documentId });
    await atomic(
      path.join(projectDir(p.key), "documents", documentId + ".json"),
      {
        id: documentId,
        moduleId: id,
        title: id,
        summary: "找到待审批记录。",
        steps: [{ title: "提交", instruction: "填写意见后提交。" }],
        references: [{ kind: "doc", location: "wiki-page" }],
      },
    );
  }
  await atomic(
    path.join(projectDir(p.key), "guides", guide.id + ".json"),
    guide,
  );
  return { p, guide };
}
const qa = (question: string, moduleId = "task", refs?: unknown) => ({
  moduleId,
  question,
  answer: "打开记录，填写意见后提交。",
  aliases: [],
  ...(refs ? { references: refs } : {}),
});

test("独立原生Pi整理草稿：并发合并、拒绝跨模块/伪造引用、限额、去重、保留审核和来源", async () => {
  const { p, guide } = await guideFixture();
  let calls = 0;
  const outputs = [
    qa("如何提交？", "unknown"),
    qa("如何提交？", "task", [{ kind: "doc", location: "unread" }]),
    qa("如何提交？"),
    qa("如何提交?"),
    qa("需要什么权限？"),
    qa("如何看结果？"),
    qa("如何撤回？"),
  ];
  const close = await serve((input, res) => {
    assert.deepEqual(
      input.tools.map((x: any) => x.function.name),
      ["qa_write"],
    );
    if (calls === 1)
      assert.ok(JSON.stringify(input.messages).includes("对应指南"));
    if (calls === 2)
      assert.ok(JSON.stringify(input.messages).includes("引用必须来自"));
    if (calls === 4)
      assert.ok(JSON.stringify(input.messages).includes('\\"existing\\":true'));
    if (calls === 7)
      assert.ok(JSON.stringify(input.messages).includes("每模块最多3条"));
    const args = outputs[calls++];
    stream(res, args ? "qa_write" : undefined, args);
  });
  try {
    const a = generateGuideQa(p.key, guide.id),
      b = generateGuideQa(p.key, guide.id);
    assert.equal(a, b);
    const job = await a;
    assert.equal(job.status, "completed", job.error);
    const saved = await listQa(p.key);
    assert.equal(saved.length, 3);
    assert.ok(
      saved.every(
        (q) => q.status === "draft" && q.source?.guideId === guide.id,
      ),
    );
    assert.equal((await matchQa(p.key, "如何提交？")).decision, "direct");
    const original = saved.find((q) => q.question === "如何提交？")!;
    const reviewed = await saveQa(p.key, { ...original, status: "verified" });
    assert.deepEqual(reviewed.source, original.source);
    assert.equal(reviewed.createdAt, original.createdAt);
    const before = calls;
    await generateGuideQa(p.key, guide.id);
    assert.equal(
      calls,
      before,
      "completed guides do not invoke the model again",
    );
    assert.equal((await matchQa(p.key, "如何提交？")).decision, "direct");
  } finally {
    await close();
  }
});

test("QA失败保留指南与已有草稿，独立重试补齐模块，不覆盖已审核结果", async () => {
  const { p, guide } = await guideFixture(["a", "b"]);
  let calls = 0;
  const close = await serve((_input, res) => {
    const n = calls++;
    if (n === 0) stream(res, "qa_write", qa("A怎么操作？", "a"));
    else if (n === 2) stream(res, "qa_write", qa("A怎么操作？", "a"));
    else if (n === 3) stream(res, "qa_write", qa("B怎么操作？", "b"));
    else stream(res);
  });
  try {
    const failed = await generateGuideQa(p.key, guide.id);
    assert.equal(failed.status, "failed");
    assert.equal(
      (
        await json<GuideBundle>(
          path.join(projectDir(p.key), "guides", guide.id + ".json"),
        )
      ).title,
      "上手指南",
    );
    const [q] = await listQa(p.key);
    await saveQa(p.key, { ...q, answer: "人工确认的答案", status: "verified" });
    const retried = await generateGuideQa(p.key, guide.id);
    assert.equal(retried.status, "completed", retried.error);
    const saved = await listQa(p.key);
    assert.equal(saved.length, 2);
    assert.equal(saved.find((x) => x.id === q.id)?.answer, "人工确认的答案");
    assert.equal(saved.find((x) => x.id === q.id)?.status, "verified");
  } finally {
    await close();
  }
});

test("八模块总限额为20，并为后续模块保留名额", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const { p, guide } = await guideFixture(ids);
  const attempts = ids
    .slice(0, 6)
    .flatMap((id) => [1, 2, 3].map((n) => qa(`${id}问题${n}`, id)));
  attempts.push(
    qa("m6问题1", "m6"),
    qa("m6问题2", "m6"),
    qa("m7问题1", "m7"),
    qa("m7问题2", "m7"),
  );
  let calls = 0;
  const close = await serve((_input, res) => {
    const args = attempts[calls++];
    stream(res, args ? "qa_write" : undefined, args);
  });
  try {
    const job = await generateGuideQa(p.key, guide.id);
    assert.equal(job.status, "completed", job.error);
    const saved = await listQa(p.key);
    assert.equal(saved.length, 20);
    assert.ok(ids.every((id) => saved.some((q) => q.source?.moduleId === id)));
  } finally {
    await close();
  }
});

test("真实浏览器与原生Pi：指南汇总后宿主自动启动QA会话，未核验QA默认可复用", async () => {
  const web = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h1>账户概览</h1><p>当前余额100元</p>");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(web.address() as any).port}`;
  const p = await createProject({ name: "自动衔接", url });
  const browser = await connectBrowser(p, true);
  let calls = 0;
  let imageId: string, documentId: string;
  const check = {
    id: "balance",
    description: "余额已显示",
    target: { text: "当前余额100元" },
    assertion: "visible",
  };
  const close = await serve((input, res) => {
    const toolResult = [...input.messages]
      .reverse()
      .find((m: any) => m.role === "tool");
    if (calls === 4) imageId = JSON.parse(toolResult.content).id;
    if (calls === 5) documentId = JSON.parse(toolResult.content).id;
    const actions = [
      [
        "quick_start_plan",
        {
          title: "账户上手",
          audience: "账户用户",
          profile: "general",
          modules: [
            {
              id: "balance",
              title: "查看余额",
              coverageReason: "只读流程",
              scenarios: [
                {
                  id: "view",
                  kind: "success",
                  goal: "查看余额",
                  setup: "已有账户",
                  cleanup: "无需清理",
                  preconditions: [check],
                  outcomes: [check],
                },
              ],
            },
          ],
        },
      ],
      ["quick_start_begin", { moduleId: "balance", scenarioId: "view" }],
      ["quick_start_verify", {}],
      ["browser_screenshot", {}],
      [
        "document_write",
        {
          moduleId: "balance",
          title: "查看余额",
          summary: "登录后查看账户余额。",
          steps: [
            {
              title: "查看账户",
              instruction: "打开账户概览即可看到当前余额。",
              imageId,
            },
          ],
          references: [{ kind: "page", location: url + "/" }],
        },
      ],
      [
        "quick_start_publish",
        { modules: [{ moduleId: "balance", documentId }] },
      ],
      [undefined, {}],
      ["qa_write", qa("在哪里查看余额？", "balance")],
      [undefined, {}],
    ];
    if (calls === 7)
      assert.deepEqual(
        input.tools.map((x: any) => x.function.name),
        ["qa_write"],
      );
    const [name, args] = actions[calls++] || [];
    stream(res, name as string | undefined, args);
  });
  try {
    const events: any[] = [];
    await ask(
      p,
      {
        browserId: browser.id,
        mode: "quick_start",
        question: "生成余额快速上手",
      },
      (e) => events.push(e),
      new AbortController().signal,
    );
    const guide = events.find((e) => e.type === "guide")?.guide;
    assert.ok(guide, JSON.stringify(events));
    assert.equal(
      events.find(
        (e) => e.type === "qa_generation" && e.job.status === "completed",
      )?.job.qaIds.length,
      1,
    );
    assert.ok(
      events
        .find((e) => e.type === "done")
        ?.result.answer.includes("未核验 QA"),
    );
    assert.equal((await listQa(p.key)).length, 1);
    assert.equal((await matchQa(p.key, "在哪里查看余额？")).decision, "direct");
    assert.equal(calls, 9);
  } finally {
    await close();
    web.closeAllConnections();
    await new Promise<void>((r) => web.close(() => r()));
  }
});
