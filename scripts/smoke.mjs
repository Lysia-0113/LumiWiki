import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

process.loadEnvFile(".env");
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const headers = {
  "Content-Type": "application/json",
  "X-QA-Admin-Token": process.env.QA_ADMIN_TOKEN,
};
async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}
const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-ui-"));
await writeFile(path.join(tmp, "main.go"), "package main\n");
const original = await api("/api/projects");
let project, browser, external;
const results = [];
try {
  assert.equal((await fetch(base + "/api/projects")).status, 403);
  results.push("管理接口未带口令返回403");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base);
  await page.locator("#token").fill(process.env.QA_ADMIN_TOKEN);
  await page.locator("#auth-form button").click();
  await page.locator("#admin").waitFor({ state: "visible" });
  project = await api("/api/projects", {
    name: "临时联调项目",
    path: tmp,
    url: process.env.PUBLIC_TEST_URL || "http://127.0.0.1:9098",
  });
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#project-name").textContent === "临时联调项目",
  );
  await page.locator('#nav [data-view="config"]').click();
  await page.locator("#wiki-upload").setInputFiles({
    name: "smoke.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Page: 系统概览\n说明\n# Page: 使用流程\n## 登录\n使用测试账号。",
    ),
  });
  await page.getByRole("heading", { name: "smoke.md", exact: true }).waitFor();
  const wiki = await api(`/api/projects/${project.key}/wiki`);
  assert.equal(wiki.files[0].pages.length, 2);
  results.push("管理台登录、项目切换、两页Markdown导入");
  const q = await api(`/api/projects/${project.key}/qa`, {
    question: "联调：如何登录？",
    answer: "使用专用测试账号登录。",
    status: "verified",
  });
  const user = await browser.newPage();
  await user.goto(base + "/user");
  await user.locator("#user-question").fill(q.question);
  await user.locator("#user-submit").click();
  await user.locator(".message.answer").filter({ hasText: q.answer }).waitFor();
  results.push("用户端命中已审核QA，未调用模型");
  await user.close();
  const { connectBrowser, getBrowser, observe, screenshot, closeBrowser } =
    await import("../src/browser.ts");
  external = await connectBrowser(project, true);
  const target = getBrowser(external.id, project.key);
  const snapshot = await observe(target);
  assert.ok(snapshot.elements.some((e) => e.type === "password"));
  await target.page
    .locator('input[name="username"]')
    .fill(process.env.PUBLIC_TEST_USERNAME || "demo");
  await target.page
    .locator('input[name="password"]')
    .fill(process.env.PUBLIC_TEST_PASSWORD || "123456");
  await target.page
    .locator('form[data-form="login"] button[type="submit"]')
    .click();
  await target.page.waitForFunction(
    () => document.querySelector("#gp-account-name")?.textContent === "demo",
  );
  const image = await screenshot(target);
  assert.equal(image.browserId, external.id);
  await closeBrowser(external.id, project.key);
  external = null;
  results.push("独立浏览器登录临时Gymbook、观察与截图");
  assert.deepEqual(pageErrors, []);
  results.push("管理台无JavaScript运行错误");
  if (original.activeProjectId)
    await api(`/api/projects/${original.activeProjectId}/activate`, {});
  await page.locator("#refresh").click();
  await page.locator('#nav [data-view="guides"]').click();
  await page.waitForTimeout(300);
  await mkdir(".webdemo/verification", { recursive: true });
  await page.screenshot({
    path: ".webdemo/verification/admin.png",
    fullPage: true,
  });
  console.log(results.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  await writeFile(
    ".webdemo/verification/smoke.json",
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
  );
} finally {
  if (original.activeProjectId)
    await api(`/api/projects/${original.activeProjectId}/activate`, {}).catch(
      () => {},
    );
  if (project)
    await api(`/api/projects/${project.key}`, undefined, "DELETE").catch(
      () => {},
    );
  if (external) {
    const { closeBrowser } = await import("../src/browser.ts");
    await closeBrowser(external.id, project.key).catch(() => {});
  }
  await browser?.close();
  await rm(tmp, { recursive: true, force: true });
}
