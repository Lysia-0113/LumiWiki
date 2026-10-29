// Actual management UI smoke using isolated data and a loopback model stub; no .env or paid API.
// node --import tsx scripts/verify-guide-ui.mjs
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const output = path.resolve(".webdemo/verification");
await mkdir(output, { recursive: true });
const runDir = await mkdtemp(path.join(output, "guide-ui-"));
let modelCalls = 0;
const target = http.createServer((request, response) => {
  if (request.url.startsWith("/deepwiki")) {
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><h1>专用账户测试系统</h1><p>当前余额100元</p>",
    );
  }
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const targetUrl = `http://127.0.0.1:${target.address().port}`;
const model = http.createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  const input = JSON.parse(body);
  const tools = input.tools.map((tool) => tool.function.name);
  assert.ok(tools.includes("guide_outline"));
  assert.ok(!tools.includes("image_annotate") && !tools.includes("qa_write"));
  modelCalls++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: "ui-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "当前信息不足，尚未提交完整目录。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
Object.assign(process.env, {
  PORT: "0",
  DATA_DIR: path.join(runDir, "data"),
  QA_ADMIN_TOKEN: randomUUID(),
  LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
  LLM_API_KEY: "local-ui-fixture",
  LLM_MODEL: "fixture",
  DEEPWIKI_BASE_URL: targetUrl + "/deepwiki",
  BROWSER_HEADLESS: "true",
  TARGET_REPO: "",
});
const { config } = await import("../src/config.ts");
const { main } = await import("../src/server.ts");
const { closeAllBrowsers } = await import("../src/browser.ts");
const { disposeConversations } = await import("../src/agent.ts");
const app = await main();
if (!app.listening) await once(app, "listening");
config.port = app.address().port;
const url = `http://127.0.0.1:${config.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator("#token").fill(config.token);
  await page.locator("#auth-form button").click();
  await page.locator("#admin").waitFor({ state: "visible" });
  await page.locator('#nav [data-view="config"]').click();
  await page.locator(".create-project summary").click();
  await page.locator('#project-form [name="name"]').fill("指南流程交互验证");
  await page
    .locator('#project-form [name="url"]')
    .fill(targetUrl + "/business");
  await page.locator("#project-form button").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#project-name").textContent ===
      "指南流程交互验证",
  );
  await page.locator('#nav [data-view="guides"]').click();
  await page.locator("#new-guide").click();
  await page.locator("#connect-browser").click();
  await page.waitForFunction(() =>
    document.querySelector("#browser-status").textContent.startsWith("已连接"),
  );
  await page.locator("#quick-start").check();
  await page.locator("#question").fill("生成完整的账户快速上手指南");
  await page.locator("#ask-button").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("指南尚未完整生成"),
  );
  assert.equal(modelCalls, 3);
  assert.ok(
    await page
      .locator("#notice")
      .evaluate((element) => element.classList.contains("error")),
  );
  assert.ok(
    !(await page.locator("#notice").textContent()).includes("本轮已完成"),
  );
  await page.screenshot({
    path: path.join(runDir, "incomplete-guide.png"),
    fullPage: true,
  });
  await page.locator('#nav [data-view="guides"]').click();
  const resume = page.getByRole("button", { name: "继续 / 重试未完成章节" });
  await resume.waitFor();
  assert.ok(
    (await page.locator("#guide-tasks").textContent()).includes("目录尚未确定"),
  );
  await page.screenshot({
    path: path.join(runDir, "task-recovery.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#notice").evaluate((element) => {
    element.textContent = "";
  });
  await resume.click();
  await page.waitForFunction(() =>
    document
      .querySelector("#notice")
      .textContent.includes("指南尚未完整生成"),
  );
  assert.equal(modelCalls, 6);
  assert.equal(await page.locator("#ask-button").isEnabled(), true);
  await page.locator('#nav [data-view="guides"]').click();
  await resume.waitFor();
  assert.equal(
    await page.locator("#guide-tasks .item").count(),
    1,
    "resume updates the same task rather than duplicating it",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        url,
        modelCalls,
        checks: [
          "管理台登录及创建项目",
          "连接专用测试浏览器",
          "未完成任务不误报完整成功",
          "持久化任务列表及恢复按钮",
          "恢复更新同一任务",
          "无页面脚本异常",
        ],
        screenshots: ["incomplete-guide.png", "task-recovery.png"],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      report: path.join(runDir, "report.json"),
      screenshot: path.join(runDir, "task-recovery.png"),
    }),
  );
} finally {
  await browser.close();
  await disposeConversations();
  await closeAllBrowsers();
  for (const server of [app, model, target]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
