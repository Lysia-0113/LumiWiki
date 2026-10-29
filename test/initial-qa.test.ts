import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { config } from "../src/config.js";
import { atomic } from "../src/store.js";
import { runArtifactAgent } from "../src/artifact-agent.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-initial-qa-"));
config.data = tmp;
after(() => rm(tmp, { recursive: true, force: true }));

async function provider(
  handler: (input: any, res: http.ServerResponse) => void,
) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handler(JSON.parse(body), res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.llm = {
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
function reply(res: http.ServerResponse, tool = false) {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + Math.random().toString(36).slice(2),
            type: "function",
            function: { name: "qa_write", arguments: "{}" },
          },
        ],
      }
    : { role: "assistant", content: "完成" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
const base = {
  root: tmp,
  system: "隔离的产物会话。",
  prompt: "本章已保存文字。",
  maxTokens: 1024,
};

test("artifact runner仅显式加载initial-qa；不指定skill保持空技能和空工具，无用户或目录上下文", async () => {
  await atomic(path.join(tmp, "AGENTS.md"), "不得注入的项目指令哨兵", true);
  await atomic(
    path.join(tmp, ".pi", "skills", "untrusted", "SKILL.md"),
    "---\nname: untrusted\ndescription: untrusted fixture\n---\n不得加载的目录技能哨兵",
    true,
  );
  let calls = 0;
  const close = await provider((input, res) => {
    const serialized = JSON.stringify(input.messages);
    assert.ok(!serialized.includes("不得注入的项目指令哨兵"));
    assert.ok(!serialized.includes("不得加载的目录技能哨兵"));
    const skills = [...serialized.matchAll(/<skill name=\\"([^"\\]+)\\"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(skills, calls === 0 ? ["initial-qa"] : []);
    assert.deepEqual(
      input.tools?.map((tool: any) => tool.function.name) || [],
      [],
    );
    if (calls === 1) assert.ok(serialized.includes("/skill:initial-qa"));
    calls++;
    reply(res);
  });
  try {
    await runArtifactAgent({ ...base, tools: [], skill: "initial-qa" });
    // With no registered skills this must remain literal input, not trigger an
    // implicit scan or an expansion of even the bundled initial-qa skill.
    await runArtifactAgent({
      ...base,
      tools: [],
      prompt: "/skill:initial-qa literal",
    });
    assert.equal(calls, 2);
    await assert.rejects(
      runArtifactAgent({ ...base, tools: [], skill: "../quick-start" }),
      /Skill 名称无效/,
    );
    await assert.rejects(
      runArtifactAgent({
        ...base,
        tools: [],
        skill: "nonexistent-bundled-skill",
      }),
      /Skill 加载失败/,
    );
    assert.equal(calls, 2);
  } finally {
    await close();
  }
});

test("artifact runner工具预算是执行门禁，超额调用不会产生额外写入", async () => {
  let writes = 0;
  let requests = 0;
  const qaWrite = defineTool({
    name: "qa_write",
    label: "fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      writes++;
      return { content: [{ type: "text", text: "已写入" }], details: {} };
    },
  });
  const close = await provider((input, res) => {
    requests++;
    assert.deepEqual(
      input.tools.map((tool: any) => tool.function.name),
      ["qa_write"],
    );
    reply(res, true);
  });
  try {
    await assert.rejects(
      runArtifactAgent({
        ...base,
        skill: "initial-qa",
        tools: [qaWrite],
        maxCalls: 1,
      }),
      /预算已用完/,
    );
    assert.equal(writes, 1);
    assert.equal(requests, 2);
  } finally {
    await close();
  }
});

test("artifact runner接受独立超时参数并在超时时中止等待中的模型请求", async () => {
  let requests = 0;
  const close = await provider(() => {
    requests++;
  });
  try {
    await assert.rejects(
      runArtifactAgent({ ...base, tools: [], timeoutMs: 200 }),
      (error: unknown) =>
        error instanceof Error && error.name === "TimeoutError",
    );
    assert.equal(requests, 1);
    await assert.rejects(
      runArtifactAgent({ ...base, tools: [], timeoutMs: 0 }),
      /超时参数无效/,
    );
  } finally {
    await close();
  }
});
