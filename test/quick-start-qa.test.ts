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
function qaInput(input: any) {
  assert.deepEqual(
    input.tools.map((x: any) => x.function.name),
    ["qa_write"],
  );
  const message = input.messages.find((m: any) => m.role === "user");
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.map((part: any) => part.text || "").join("\n");
  assert.deepEqual(
    [...text.matchAll(/<skill name="([^"]+)"/g)].map((m) => m[1]),
    ["initial-qa"],
    "the initial-qa skill must actually be expanded by the native Pi session",
  );
  return JSON.parse(
    text.slice(text.indexOf("</skill>") + "</skill>".length).trim(),
  );
}
async function guideFixture(
  ids = ["task"],
  fields: Record<string, unknown> = {},
) {
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
        ...fields,
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
    assert.equal(qaInput(input).moduleId, "task");
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
    const draftHit = await matchQa(p.key, "如何提交？");
    assert.equal(draftHit.decision, "direct");
    assert.equal(draftHit.qa?.status, "draft");
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

test("QA失败不阻塞其他章节，保留指南与草稿，重试只补缺章且不覆盖审核结果", async () => {
  const { p, guide } = await guideFixture(["a", "b", "c"]);
  let failB = true;
  const sessions: string[] = [];
  const close = await serve((input, res) => {
    const chapter = qaInput(input);
    const first = !input.messages.some((m: any) => m.role === "tool");
    if (first) sessions.push(chapter.moduleId);
    if (first && !(chapter.moduleId === "b" && failB))
      stream(
        res,
        "qa_write",
        qa(`${chapter.moduleId}怎么操作？`, chapter.moduleId),
      );
    else stream(res);
  });
  try {
    const failed = await generateGuideQa(p.key, guide.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /b.*本章尚未生成/);
    const stored = await json<GuideBundle>(
      path.join(projectDir(p.key), "guides", guide.id + ".json"),
    );
    assert.equal(stored.title, "上手指南");
    assert.deepEqual(stored.modules, guide.modules);
    assert.equal(
      failed.qaIds.length,
      2,
      "a failed chapter does not stop later chapters",
    );
    const q = (await listQa(p.key)).find((q) => q.source?.moduleId === "a")!;
    await saveQa(p.key, { ...q, answer: "人工确认的答案", status: "verified" });
    failB = false;
    const retried = await generateGuideQa(p.key, guide.id);
    assert.equal(retried.status, "completed", retried.error);
    const saved = await listQa(p.key);
    assert.equal(saved.length, 3);
    assert.equal(saved.find((x) => x.id === q.id)?.answer, "人工确认的答案");
    assert.equal(saved.find((x) => x.id === q.id)?.status, "verified");
    assert.deepEqual(sessions, ["a", "b", "c", "b"]);
    await generateGuideQa(p.key, guide.id);
    assert.deepEqual(sessions, ["a", "b", "c", "b"]);
  } finally {
    await close();
  }
});

test("超过20章逐章隔离，每章一条即可完成且不受快速上手工具/输出预算限制", async () => {
  const ids = Array.from({ length: 24 }, (_, i) => `m${i}`);
  const { p, guide } = await guideFixture(ids);
  const old = {
    tools: config.quickStartMaxTools,
    tokens: config.quickStartMaxTokens,
    onlineTools: config.maxTools,
  };
  config.quickStartMaxTools = 1;
  config.quickStartMaxTokens = 256;
  config.maxTools = 1;
  const sessions: string[] = [];
  const close = await serve((input, res) => {
    const chapter = qaInput(input);
    assert.equal(input.max_tokens ?? input.max_completion_tokens, 4096);
    assert.equal(
      chapter.modules,
      undefined,
      "the full book must not be injected",
    );
    const first = !input.messages.some((m: any) => m.role === "tool");
    if (first) {
      assert.equal(
        input.messages.filter((m: any) => m.role === "user").length,
        1,
      );
      sessions.push(chapter.moduleId);
      stream(
        res,
        "qa_write",
        qa(`${chapter.moduleId}如何提交？`, chapter.moduleId),
      );
    } else stream(res);
  });
  try {
    const job = await generateGuideQa(p.key, guide.id);
    assert.equal(job.status, "completed", job.error);
    const saved = await listQa(p.key);
    assert.equal(saved.length, 24);
    assert.deepEqual(sessions, ids);
    assert.ok(
      ids.every(
        (id) => saved.filter((q) => q.source?.moduleId === id).length === 1,
      ),
    );
  } finally {
    config.quickStartMaxTools = old.tools;
    config.quickStartMaxTokens = old.tokens;
    config.maxTools = old.onlineTools;
    await close();
  }
});

test("初始QA读取已保存长文可选字段，保留步骤文字但不加载多图像素或审计上下文", async () => {
  const fields = {
    audience: "采购审批人",
    prerequisites: ["已登录", "具有审批权限"],
    details: "填写审批意见后提交。",
    outcomes: ["审批状态更新"],
    troubleshooting: "列表未更新时刷新当前查询。",
    limitations: ["只能操作待审批记录"],
    steps: [
      {
        title: "提交",
        instruction: "选择审批结果并填写意见。",
        expectedResult: "列表显示新状态",
        imageId: "missing-image-not-to-be-read",
        images: [{ imageId: "another-missing-image", caption: "示意图" }],
      },
    ],
    audit: "不应注入的核验日志",
    unrelatedMetadata: "不应注入的其他上下文",
  };
  const { p, guide } = await guideFixture(["task"], fields);
  const close = await serve((input, res) => {
    const chapter = qaInput(input);
    for (const field of [
      "audience",
      "prerequisites",
      "details",
      "outcomes",
      "troubleshooting",
      "limitations",
    ] as const)
      assert.deepEqual(chapter[field], fields[field]);
    assert.deepEqual(chapter.steps, [
      {
        title: "提交",
        instruction: "选择审批结果并填写意见。",
        expectedResult: "列表显示新状态",
      },
    ]);
    assert.equal(chapter.documentId, guide.modules[0].documentId);
    assert.equal(chapter.audit, undefined);
    assert.equal(chapter.unrelatedMetadata, undefined);
    const serialized = JSON.stringify(input.messages);
    assert.ok(!serialized.includes("missing-image"));
    assert.ok(!serialized.includes("data:image/"));
    if (!input.messages.some((m: any) => m.role === "tool"))
      stream(res, "qa_write", qa("审批后会看到什么结果？"));
    else stream(res);
  });
  try {
    const job = await generateGuideQa(p.key, guide.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.qaIds.length, 1);
  } finally {
    await close();
  }
});

test("替换章节documentId后补充新版本QA，保留旧版本审核条目且重试幂等", async () => {
  const { p, guide } = await guideFixture();
  let calls = 0;
  const close = await serve((input, res) => {
    qaInput(input);
    calls++;
    if (!input.messages.some((m: any) => m.role === "tool"))
      stream(res, "qa_write", qa("如何提交？"));
    else stream(res);
  });
  try {
    assert.equal((await generateGuideQa(p.key, guide.id)).status, "completed");
    const [old] = await listQa(p.key);
    await saveQa(p.key, {
      ...old,
      answer: "旧版人工审核答案",
      status: "verified",
    });
    assert.equal((await matchQa(p.key, "如何提交？")).decision, "direct");
    const guideFile = path.join(
      projectDir(p.key),
      "guides",
      guide.id + ".json",
    );
    const current = await json<GuideBundle>(guideFile);
    const documentId = randomUUID();
    const doc = await json<Record<string, unknown>>(
      path.join(
        projectDir(p.key),
        "documents",
        current.modules[0].documentId + ".json",
      ),
    );
    await atomic(
      path.join(projectDir(p.key), "documents", documentId + ".json"),
      {
        ...doc,
        id: documentId,
        details: "这是另一次保存的章节版本。",
      },
    );
    current.modules[0].documentId = documentId;
    await atomic(guideFile, current);
    assert.equal(
      (await matchQa(p.key, "如何提交？")).decision,
      "agent",
      "来源章节已更换，保留旧审核记录但不能继续直答",
    );
    const updated = await generateGuideQa(p.key, guide.id);
    assert.equal(updated.status, "completed", updated.error);
    assert.equal(updated.qaIds.length, 1, "当前任务只统计当前版本QA");
    const saved = await listQa(p.key);
    assert.equal(saved.length, 2);
    assert.equal(
      saved.find((q) => q.id === old.id)?.answer,
      "旧版人工审核答案",
    );
    assert.equal(saved.find((q) => q.id === old.id)?.status, "verified");
    assert.equal(
      saved.find((q) => q.id !== old.id)?.source?.documentId,
      documentId,
    );
    assert.equal(saved.find((q) => q.id !== old.id)?.status, "draft");
    assert.equal(calls, 4);
    await generateGuideQa(p.key, guide.id);
    assert.equal(calls, 4);
  } finally {
    await close();
  }
});

test("每章工具预算耗尽不挤占后续章，失败后下次只补未保存章节", async () => {
  const { p, guide } = await guideFixture(["a", "b"]);
  let exhaustA = true;
  let rejectedAttempts = 0;
  const sessions: string[] = [];
  const close = await serve((input, res) => {
    const chapter = qaInput(input);
    const first = !input.messages.some((m: any) => m.role === "tool");
    if (first) sessions.push(chapter.moduleId);
    if (chapter.moduleId === "a" && exhaustA) {
      rejectedAttempts++;
      stream(res, "qa_write", qa("越界的问题", "b"));
    } else if (first) {
      stream(
        res,
        "qa_write",
        qa(`${chapter.moduleId}怎么提交？`, chapter.moduleId),
      );
    } else stream(res);
  });
  try {
    const failed = await generateGuideQa(p.key, guide.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /预算/);
    assert.ok(rejectedAttempts <= 13);
    assert.deepEqual(
      (await listQa(p.key)).map((q) => q.source?.moduleId),
      ["b"],
    );
    exhaustA = false;
    const completed = await generateGuideQa(p.key, guide.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal((await listQa(p.key)).length, 2);
    assert.deepEqual(sessions, ["a", "b", "a"]);
  } finally {
    await close();
  }
});

test("初始QA保留结构化故障处理和可信图例文字，不读取截图像素", async () => {
  const fields = {
    troubleshooting: [
      { problem: "审批按钮禁用", solution: "核对当前角色和单据状态。" },
    ],
    figureLegends: {
      "figure-id": [
        {
          number: 1,
          label: "提交审批",
          description: "确认审批意见后提交，随后查看单据的新状态。",
        },
      ],
    },
  };
  const { p, guide } = await guideFixture(["task"], fields);
  const close = await serve((input, res) => {
    const chapter = qaInput(input);
    assert.deepEqual(chapter.troubleshooting, fields.troubleshooting);
    assert.deepEqual(chapter.figureLegends, fields.figureLegends);
    assert.deepEqual(
      input.tools.map((tool: any) => tool.function.name),
      ["qa_write"],
    );
    if (!input.messages.some((message: any) => message.role === "tool"))
      stream(res, "qa_write", qa("审批按钮禁用怎么办？"));
    else stream(res);
  });
  try {
    const job = await generateGuideQa(p.key, guide.id);
    assert.equal(job.status, "completed", job.error);
  } finally {
    await close();
  }
});

test("真实浏览器与原生Pi：目录、探索、writer、初始QA各自独立，宿主自动汇总", async () => {
  const web = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h1>账户概览</h1><p>当前余额100元</p>");
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(web.address() as any).port}`;
  const p = await createProject({ name: "自动衔接", url });
  const browser = await connectBrowser(p, true);
  const check = {
    id: "balance",
    description: "余额已显示",
    target: { text: "当前余额100元" },
    assertion: "visible",
  };
  const question = "在哪里查看余额？";
  const counts = { planner: 0, chapter: 0, writer: 0, qa: 0 };
  let imageId: string;
  const close = await serve((input, res) => {
    const names = input.tools.map((tool: any) => tool.function.name);
    if (names.includes("guide_outline")) {
      assert.ok(
        !names.includes("image_annotate") && !names.includes("document_write"),
      );
      const n = counts.planner++;
      if (n === 0) stream(res, "browser_observe");
      else if (n === 1)
        stream(res, "guide_outline", {
          title: "账户上手",
          audience: "账户用户",
          overview: "了解账户及余额查询。",
          chapters: [
            {
              id: "balance",
              title: "查看余额",
              goal: "查询当前账户余额",
              scope: ["账户概览"],
              questions: [question],
              entryUrls: [url + "/"],
            },
          ],
        });
      else stream(res, undefined, {}, "规划已保存。");
      return;
    }
    if (names.includes("guide_chapter_ready")) {
      assert.ok(
        !names.includes("document_write") && !names.includes("qa_write"),
      );
      const n = counts.chapter++;
      if (n === 4) {
        assert.deepEqual(names.sort(), [
          "guide_chapter_block",
          "guide_chapter_ready",
          "guide_research_gap",
        ]);
        imageId = JSON.parse(
          [...input.messages]
            .reverse()
            .find((message: any) => message.role === "tool").content,
        ).screenshot.id;
        stream(res, "guide_chapter_ready", {
          answers: [
            {
              question,
              status: "covered",
              explanation: "账户概览显示当前账户余额100元。",
            },
          ],
          references: [{ kind: "page", location: url + "/" }],
          images: [{ imageId, caption: "当前账户余额" }],
        });
        return;
      }
      const actions: Array<[string, unknown]> = [
        ["browser_observe", {}],
        [
          "quick_start_plan",
          {
            title: "查看余额",
            audience: "账户用户",
            profile: "general",
            modules: [
              {
                id: "balance",
                title: "查看余额",
                coverageReason: "只读查询",
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
      ];
      assert.ok(actions[n], "事实冻结后不请求探索收尾");
      stream(res, ...actions[n]);
      return;
    }
    if (names.includes("document_write")) {
      assert.deepEqual(names, ["document_write"]);
      assert.equal(counts.writer++, 0, "正文成功后不请求ack");
      const message = input.messages.find(
        (message: any) => message.role === "user",
      );
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part: any) => part.text || "").join("\n");
      const brief = JSON.parse(text);
      assert.equal(brief.phase, "writer");
      assert.equal(brief.chapter.id, "balance");
      assert.equal(brief.images[0].imageId, imageId);
      assert.equal(brief.answers[0].question, question);
      assert.ok(
        !text.includes("quick_start_verify") && !text.includes("<skill"),
      );
      stream(res, "document_write", {
        moduleId: "balance",
        title: "查看余额",
        summary: "登录后查看账户余额。",
        prerequisites: ["已登录账户"],
        steps: [
          {
            title: "查看账户",
            instruction: "打开账户概览即可看到当前余额。",
            imageId,
          },
        ],
        coverage: [
          {
            question,
            status: "covered",
            explanation: "查看账户步骤说明查询入口和余额位置。",
          },
        ],
        references: [{ kind: "page", location: url + "/" }],
      });
      return;
    }
    assert.deepEqual(names, ["qa_write"]);
    if (counts.qa++ === 0) stream(res, "qa_write", qa(question, "balance"));
    else stream(res);
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
      (event) => events.push(event),
      AbortSignal.timeout(30000),
    );
    const guide = events.find((event) => event.type === "guide")?.guide;
    assert.ok(guide, JSON.stringify(events));
    assert.equal(guide.complete, true);
    assert.equal(
      events.find(
        (event) =>
          event.type === "qa_generation" && event.job.status === "completed",
      )?.job.qaIds.length,
      1,
    );
    assert.equal(
      events.find((event) => event.type === "done")?.result.complete,
      true,
    );
    assert.ok(
      events
        .find((event) => event.type === "done")
        ?.result.answer.includes("QA 草稿"),
    );
    assert.equal((await listQa(p.key)).length, 1);
    const draftHit = await matchQa(p.key, question);
    assert.equal(draftHit.decision, "direct");
    assert.equal(draftHit.qa?.status, "draft");
    assert.deepEqual(counts, { planner: 2, chapter: 5, writer: 1, qa: 2 });
  } finally {
    await close();
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  }
});
