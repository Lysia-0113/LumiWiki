import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import { config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { atomic, createProject, projectDir } from "../src/store.js";
import { importWiki } from "../src/knowledge.js";
import { writeDocument } from "../src/documents.js";
import { saveQa, listQa } from "../src/qa.js";
import { disposeConversations } from "../src/agent.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-workspace-"));
config.data = tmp;
config.token = "workspace-fixture";
after(async () => {
  await disposeConversations();
  await rm(tmp, { recursive: true, force: true });
});
test("三栏目工作台接入真实产物、文字 QA 生成/编辑/审核、知识库导入和项目隔离", async () => {
  const model = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "ui", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "打开设置，选择个人资料，然后保存修改。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  config.llm = {
    baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  const first = await createProject({
      name: "memos",
      url: "http://127.0.0.1:8081",
    }),
    second = await createProject({ name: "另一个项目" });
  await atomic(path.join(tmp, "deployment.json"), {
    activeProjectId: first.key,
  });
  const docId = randomUUID(),
    guideId = randomUUID(),
    imageId = randomUUID();
  await mkdir(path.join(projectDir(first.key), "artifacts"), {
    recursive: true,
  });
  await writeFile(
    path.join(projectDir(first.key), "artifacts", imageId + ".png"),
    await sharp({
      create: { width: 80, height: 50, channels: 3, background: "#286451" },
    })
      .png()
      .toBuffer(),
  );
  await writeDocument(first.key, {
    id: docId,
    moduleId: "notes",
    title: "创建笔记",
    summary: "记录第一条笔记",
    steps: [{ title: "填写内容", instruction: "输入内容后保存。", imageId }],
    references: [],
  });
  await atomic(path.join(projectDir(first.key), "guides", guideId + ".json"), {
    id: guideId,
    title: "Memos 新用户上手指南",
    modules: [{ id: "notes", title: "创建笔记", documentId: docId }],
    createdAt: new Date().toISOString(),
    qaGeneration: { status: "completed", qaIds: [] },
  });
  const qa = await saveQa(
    first.key,
    {
      question: "保存后的笔记还可以修改吗？",
      answer: "找到对应笔记，打开操作菜单并选择编辑。",
      status: "draft",
    },
    { guideId, moduleId: "notes", documentId: docId, references: [] },
  );
  await saveQa(first.key, {
    question: "内容会被当作 HTML 执行吗？",
    answer: "<img src=x onerror=alert(1)> 只作为文字显示。",
    status: "verified",
  });
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.port = (server.address() as any).port;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${config.port}`);
    await page.locator("#token").fill(config.token);
    await page.locator("#auth-form button").click();
    await page.locator("#admin").waitFor({ state: "visible" });
    assert.equal(await page.locator("#nav button").count(), 3);
    assert.equal(await page.locator("#status-grid").isVisible(), false);
    await page
      .getByRole("button", { name: "Memos 新用户上手指南", exact: false })
      .click();
    await page.locator("#guide-detail img").waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(
        "#guide-detail img",
      ) as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    });
    await page.locator("#new-guide").click();
    await page.locator("#quick-start").uncheck();
    await page.locator("#question").fill("仅回答一个问题，不生成文档");
    await page.locator("#ask-button").click();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#ask-button") as HTMLButtonElement).disabled,
    );
    assert.ok(
      (await page.locator("#notice").textContent())?.includes(
        "未生成新的指南或文档",
      ),
    );
    await page.locator('#nav [data-view="qa"]').click();
    await page
      .locator("#qa-list button")
      .filter({ hasText: qa.question })
      .click();
    assert.equal(await page.locator("#qa-detail img").count(), 0);
    await page.getByRole("button", { name: "编辑答案", exact: true }).click();
    await page.locator("#qa-form textarea").fill("修改后的纯文字操作步骤。");
    await page.locator("#qa-form button.primary").click();
    await page.getByRole("button", { name: "✓ 通过审核", exact: true }).click();
    await page.getByRole("button", { name: "退回草稿", exact: true }).waitFor();
    const edited = (await listQa(first.key)).find((item) => item.id === qa.id)!;
    assert.equal(edited.status, "verified");
    assert.equal(edited.source?.guideId, guideId);
    await page.locator("#new-qa").click();
    await page.locator('#qa-form [name="question"]').fill("手工新增的问题");
    await page.locator("#qa-form textarea").fill("手工文字答案");
    await page.locator("#qa-form button.primary").click();
    await page
      .locator("#qa-detail h2")
      .filter({ hasText: "手工新增的问题" })
      .waitFor();
    await page.locator(".qa-compose summary").click();
    await page.locator("#qa-question").fill("如何修改个人资料？");
    await page.locator("#qa-ask-button").click();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#qa-ask-button") as HTMLButtonElement)
          .disabled,
    );
    assert.ok(
      (await listQa(first.key)).some(
        (item) => item.question === "如何修改个人资料？",
      ),
      String(await page.locator("#notice").textContent()) +
        " " +
        String(await page.locator("#qa-messages").textContent()),
    );
    await page
      .locator("#qa-detail h2")
      .filter({ hasText: "如何修改个人资料？" })
      .waitFor();
    assert.equal(
      await page.locator("#qa-detail .text-answer").textContent(),
      "打开设置，选择个人资料，然后保存修改。",
    );
    assert.equal(await page.locator("#qa-detail img").count(), 0);
    await mkdir(path.join(process.cwd(), ".webdemo", "verification"), {
      recursive: true,
    });
    await page.screenshot({
      path: path.join(
        process.cwd(),
        ".webdemo",
        "verification",
        "workspace-desktop.png",
      ),
      fullPage: true,
    });
    await page.locator("#open-config").click();
    await page.locator("#wiki-upload").setInputFiles({
      name: "workspace.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 页面说明\n使用帮助"),
    });
    await page
      .getByRole("heading", { name: "workspace.md", exact: true })
      .waitFor();
    await page.locator("#project-select").selectOption(second.key);
    await page.locator('#nav [data-view="qa"]').click();
    await page.waitForFunction(
      () => document.querySelector("#qa-count")?.textContent === "0 条",
    );
    assert.equal(await page.locator("#qa-list button").count(), 0);
    await page.locator("#project-select").selectOption(first.key);
    await page
      .locator("#qa-list button")
      .filter({ hasText: "如何修改个人资料？" })
      .waitFor();
    await page.reload();
    await page.locator("#admin").waitFor({ state: "visible" });
    await page.locator('#nav [data-view="qa"]').click();
    await page
      .locator("#qa-list button")
      .filter({ hasText: "如何修改个人资料？" })
      .waitFor();
    const publicPage = await browser.newPage();
    await publicPage.goto(`http://127.0.0.1:${config.port}/user`);
    await publicPage.locator('[data-public-view="qa"]').click();
    await publicPage.locator("#user-question").fill(qa.question);
    await publicPage.locator("#user-submit").click();
    await publicPage
      .locator(".message.answer")
      .filter({ hasText: "修改后的纯文字操作步骤。" })
      .waitFor();
    assert.equal(await publicPage.locator("#user-messages img").count(), 0);
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    model.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => model.close(() => resolve())),
    ]);
  }
});
