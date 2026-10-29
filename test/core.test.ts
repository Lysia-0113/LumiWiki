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
import { cosine, matchQa, saveQa } from "../src/qa.js";
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
test("草稿不参与直答，已审核问答支持规范化精确匹配", async () => {
  const p = await createProject({ name: "qa" });
  const q = await saveQa(p.key, { question: "如何预约？", answer: "先登录。" });
  assert.equal((await matchQa(p.key, "如何预约")).decision, "agent");
  await saveQa(p.key, { ...q, status: "verified" });
  const matched = await matchQa(p.key, "如何预约");
  assert.equal(matched.decision, "direct");
  assert.equal(matched.tier, "exact");
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1], [1, 2]));
});
test("实际 Pi SDK 聊天工具循环与 SSE，不注册指南、画框或文件工具", async () => {
  const p = await createProject({ name: "sdk" });
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
    const names = input.tools.map((t: any) => t.function.name);
    assert.ok(
      !names.some((name: string) =>
        [
          "read",
          "ls",
          "grep",
          "find",
          "bash",
          "document_write",
          "image_annotate",
          "quick_start_plan",
          "qa_write",
        ].includes(name),
      ),
    );
    assert.equal(
      input.max_tokens ?? input.max_completion_tokens,
      Number(process.env.LLM_MAX_TOKENS || 4096),
    );
    assert.ok(
      !JSON.stringify(input.messages).includes("References are relative to"),
      "在线问答不加载任何生成技能",
    );
    const delta =
      calls === 1
        ? {
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
          }
        : { role: "assistant", content: "已读取知识库。" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.llm = {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  const events: any[] = [];
  try {
    await ask(
      p,
      { question: "读取知识库", mode: "chat" },
      (event) => events.push(event),
      AbortSignal.timeout(20000),
    );
    assert.equal(calls, 2);
    assert.ok(
      events.some(
        (event) => event.type === "tool" && event.name === "wiki_read",
      ),
    );
    assert.ok(events.some((event) => event.type === "text"));
    const done = events.find((event) => event.type === "done").result;
    const saved = JSON.parse(
      await readFile(
        path.join(projectDir(p.key), "runs", done.runId + ".json"),
        "utf8",
      ),
    );
    assert.equal(saved.toolCalls, 1);
    assert.equal(saved.workflow, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    status: "verified",
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
