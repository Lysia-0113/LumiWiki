import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { config } from "../src/config.js";
import { createProject, sourcePath, projectDir } from "../src/store.js";
import {
  importWiki,
  listWiki,
  parseWiki,
  readPage,
  wikiContext,
} from "../src/knowledge.js";
import { ask, disposeConversations } from "../src/agent.js";
import {
  cosine,
  listQa,
  matchQa,
  recordQaUse,
  saveQa,
  updateQaState,
} from "../src/qa.js";
import { projectSkills, runPrompt } from "../src/skills.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-test-"));
config.data = path.join(tmp, "data");
after(async () => {
  await disposeConversations();
  await rm(tmp, { recursive: true, force: true });
});
test("页边界忽略代码块中的假标题，字符偏移保留中文及 emoji", () => {
  const content =
    "# Page: 第一页\n中文😀\n```md\n# Page: 假页\n```\n# Page: 第二页\n## 使用\n正文";
  const file = parseWiki(content, "sample.md");
  assert.equal(file.pages.length, 2);
  assert.equal(
    content.slice(file.pages[0].start, file.pages[0].end).includes("中文😀"),
    true,
  );
  assert.equal(file.pages[1].title, "第二页");
});
test("DeepWiki 导出锚点与单页回退均可读取", () => {
  const file = parseWiki(
    "<a id='page-1'></a>\n\n## 总览\n正文\n<a id='page-2'></a>\n## 流程\n正文",
    "wiki.md",
  );
  assert.equal(file.pages.length, 2);
  assert.equal(file.pages[0].title, "总览");
  assert.equal(parseWiki("# 单页\n正文", "x.md").pages.length, 1);
  assert.throws(() => parseWiki("正文", "../x.md"));
});
test("知识库来源路径校验拒绝路径穿越、隐藏凭证和符号链接越界", async () => {
  const repo = path.join(tmp, "repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "main.go"), "package main\nfunc main() {}\n");
  await writeFile(path.join(tmp, "outside.txt"), "outside");
  await symlink(path.join(tmp, "outside.txt"), path.join(repo, "outside.txt"));
  const p = await createProject({ name: "test", path: repo });
  assert.equal(
    await sourcePath(p, "main.go"),
    await realpath(path.join(repo, "main.go")),
  );
  await assert.rejects(sourcePath(p, "../outside.txt"));
  await assert.rejects(sourcePath(p, ".env"));
  await assert.rejects(sourcePath(p, "outside.txt"));
});
test("同名导入替换旧版本，小库全文注入不截断 20k–30k 的单页", async () => {
  const p = await createProject({ name: "wiki" });
  const first = await importWiki(p, "a.md", "# 旧版\n旧正文");
  const body = "# 新版\n" + "中".repeat(25000);
  const second = await importWiki(p, "a.md", body);
  const files = await listWiki(p.key);
  assert.equal(files.length, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(
    (await wikiContext(p.key)).content.includes("中".repeat(25000)),
    true,
  );
  const page = await readPage(p.key, second.pages[0].id);
  assert.equal(page.truncated, true);
  await assert.rejects(readPage(p.key, first.pages[0].id));
});
test("可用问答不论核验状态都支持精确匹配；停用与核验互不影响", async () => {
  const p = await createProject({ name: "qa" });
  const q = await saveQa(p.key, { question: "如何预约？", answer: "先登录。" });
  assert.equal((await matchQa(p.key, "如何预约")).decision, "direct");
  await updateQaState(p.key, q.id, { enabled: false });
  await updateQaState(p.key, q.id, { status: "verified" });
  assert.equal((await listQa(p.key))[0].enabled, false);
  assert.equal((await matchQa(p.key, "如何预约")).decision, "agent");
  await updateQaState(p.key, q.id, { enabled: true });
  const matched = await matchQa(p.key, "如何预约");
  assert.equal(matched.decision, "direct");
  assert.equal(matched.tier, "exact");
  assert.equal(matched.qa?.status, "verified");
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1], [1, 2]));
});
test("旧QA默认可用，精确匹配优先人工核验；编辑保留其他问法和停用状态", async () => {
  const p = await createProject({ name: "旧qa" });
  const draft = await saveQa(p.key, {
    question: "如何预约？",
    answer: "AI答案",
    aliases: ["怎么订课？"],
  });
  const file = path.join(projectDir(p.key), "qa", draft.id + ".json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.enabled;
  await writeFile(file, JSON.stringify(legacy));
  assert.equal((await listQa(p.key))[0].enabled, true);
  assert.equal((await matchQa(p.key, "怎么订课？")).qa?.id, draft.id);
  const verified = await saveQa(p.key, {
    question: draft.question,
    answer: "人工答案",
    status: "verified",
  });
  assert.equal((await matchQa(p.key, draft.question)).qa?.id, verified.id);
  await updateQaState(p.key, draft.id, { enabled: false });
  const edited = await saveQa(p.key, {
    id: draft.id,
    question: draft.question,
    answer: "编辑答案",
  });
  assert.deepEqual(edited.aliases, draft.aliases);
  assert.equal(edited.enabled, false);
  assert.equal(await recordQaUse(p.key, draft, draft.question), undefined);
  await assert.rejects(
    saveQa(p.key, {
      question: "无效",
      answer: "无效",
      enabled: "false" as any,
    }),
    /可用状态无效/,
  );
  await assert.rejects(
    updateQaState(p.key, draft.id, { status: "invalid" as any }),
    /问答状态无效/,
  );
});
test("实际 Pi SDK 完成工具调用循环与 SSE 文本事件（本地协议桩，无付费模型）", async () => {
  const repo = path.join(tmp, "sdk-repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "main.go"), "package main\n");
  const p = await createProject({ name: "sdk", path: repo });
  const file = await importWiki(
    p,
    "sdk.md",
    "# Page: 使用说明\n" + "项目使用方法。".repeat(6000),
  );
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const choice =
      calls === 1
        ? {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_invalid_document",
                  type: "function",
                  function: {
                    name: "document_write",
                    arguments: JSON.stringify({
                      title: "跳过检查",
                      summary: "不能保存",
                      steps: [
                        {
                          title: "伪完成",
                          instruction: "没有验证",
                          expectedResult: "成功",
                        },
                      ],
                      references: [
                        { kind: "page", location: "http://fixture.invalid" },
                      ],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          }
        : calls === 2
          ? {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: {
                      name: "wiki_read",
                      arguments: JSON.stringify({ pageId: file.pages[0].id }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            }
          : {
              delta: { role: "assistant", content: "已读取知识库。" },
              finish_reason: "stop",
            };
    assert.ok(input.messages);
    assert.equal(
      input.max_tokens ?? input.max_completion_tokens,
      config.quickStartMaxTokens,
    );
    if (calls === 2)
      assert.ok(
        JSON.stringify(input.messages).includes(
          "快速上手文档必须绑定 moduleId",
        ),
      );
    assert.ok(
      JSON.stringify(input.messages).includes("References are relative to"),
    );
    assert.ok(
      !JSON.stringify(input.messages).includes("./lumiwiki test"),
      "开发者验收文档不得注入技能上下文",
    );
    assert.ok(
      !input.tools.some((t: { function: { name: string } }) =>
        ["read", "ls", "grep", "find", "bash"].includes(t.function.name),
      ),
    );
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, ...choice }],
        }) +
        "\n\n",
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  Object.assign(config.llm, {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    key: "fixture-key",
    model: "fixture",
  });
  const events: Array<Record<string, unknown>> = [];
  try {
    await ask(
      p,
      { question: "读取知识库", mode: "quick_start" },
      (e) => events.push(e),
      AbortSignal.timeout(20000),
    );
    assert.equal(calls, 5, "未汇总任务最多由Pi收尾hook续跑两次");
    assert.ok(events.some((e) => e.type === "tool" && e.name === "wiki_read"));
    assert.ok(events.some((e) => e.type === "text"));
    assert.ok(events.some((e) => e.type === "done"));
    const done = events.find((e) => e.type === "done")!.result as {
      runId: string;
    };
    const saved = JSON.parse(
      await readFile(
        path.join(projectDir(p.key), "runs", done.runId + ".json"),
        "utf8",
      ),
    );
    assert.equal(
      saved.toolCalls,
      1,
      "Pi hook must block document_write before its handler consumes budget",
    );
    assert.ok(events.some((e) => e.type === "workflow"));
    assert.equal(saved.workflow.continuations, 2);
    assert.ok(
      events.some((e) => e.type === "skill" && e.name === "quick-start"),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("中相似度 Judge 只能选择已提供的候选，不能把第二条答案错配成第一条", async () => {
  const p = await createProject({ name: "judge" });
  await saveQa(p.key, {
    question: "候选一",
    answer: "第一条答案",
    status: "verified",
  });
  const second = await saveQa(p.key, {
    question: "候选二",
    answer: "第二条答案",
    status: "draft",
  });
  await saveQa(p.key, {
    question: "停用候选",
    answer: "不能被选择",
    enabled: false,
  });
  let valid = true;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const data = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/embeddings")) {
      const score =
        data.input === "测试问题" ? 1 : data.input === "候选一" ? 0.75 : 0.7;
      res.end(
        JSON.stringify({
          data: [{ embedding: [score, Math.sqrt(1 - score * score)] }],
        }),
      );
    } else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  canAnswer: true,
                  qaId: valid ? second.id : "unknown",
                }),
              },
            },
          ],
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const vars = [
    "EMBEDDING_BASE_URL",
    "EMBEDDING_API_KEY",
    "EMBEDDING_MODEL",
    "QA_JUDGE_BASE_URL",
    "QA_JUDGE_API_KEY",
    "QA_JUDGE_MODEL",
  ];
  const old = vars.map((k) => process.env[k]);
  Object.assign(process.env, {
    EMBEDDING_BASE_URL: `http://127.0.0.1:${port}/v1`,
    EMBEDDING_API_KEY: "test",
    EMBEDDING_MODEL: "embedding",
    QA_JUDGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    QA_JUDGE_API_KEY: "test",
    QA_JUDGE_MODEL: "judge",
  });
  try {
    const hit = await matchQa(p.key, "测试问题");
    assert.equal(hit.tier, "medium");
    assert.equal(hit.qa?.id, second.id);
    valid = false;
    assert.equal((await matchQa(p.key, "测试问题")).decision, "agent");
  } finally {
    vars.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    });
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("快速上手技能仅从应用目录加载，公共探索不加载管理技能", () => {
  const loaded = projectSkills();
  assert.equal(loaded.diagnostics.length, 0);
  assert.ok(
    loaded.skills.some(
      (s) =>
        s.name === "quick-start" &&
        s.filePath.endsWith("/skills/quick-start/SKILL.md"),
    ),
  );
  assert.equal(projectSkills(true).skills.length, 0);
  assert.equal(
    runPrompt("生成预约指南", "quick_start"),
    "/skill:quick-start 生成预约指南",
  );
  assert.equal(runPrompt("普通问题", "chat"), "普通问题");
});
test("DeepWiki 语义页ID及上页未闭合代码块不会吞掉后续页面", () => {
  const md =
    "# Wiki Documentation for fixture\n\n## Table of Contents\n- [介绍](#page-intro)\n- [使用](#page-use)\n\n<a id='page-intro'></a>\n## 介绍\n```go\npackage main\n\n<a id='page-use'></a>\n## 使用\n正文";
  const file = parseWiki(md, "generated.md");
  assert.equal(file.pages.length, 2);
  assert.equal(file.pages[1].title, "使用");
});
