import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { config, HttpError } from "../src/config.js";
import {
  atomic,
  createProject,
  getProject,
  migrateProjectSettings,
  projectDir,
  publicBrowserSettings,
  updateProject,
} from "../src/store.js";
import { createServer } from "../src/server.js";
import { closeAllBrowsers } from "../src/browser.js";
import { disposeConversations } from "../src/agent.js";
import { saveQa } from "../src/qa.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-public-projects-"));
config.data = tmp;
config.token = "project-settings-fixture";
config.deepwiki = "http://127.0.0.1:1";
Object.assign(process.env, {
  PUBLIC_BROWSER_ENABLED: "true",
  PUBLIC_TEST_URL: "http://127.0.0.1:9098",
  PUBLIC_TEST_USERNAME: "default-user",
  PUBLIC_TEST_PASSWORD: "default-password",
  LLM_MAX_TOKENS: "512",
});
const servers: http.Server[] = [];
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const visits: string[] = [];
const logins: Array<{ site: string; username: string; password: string }> = [];
const webUrl = await listen(
  http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      logins.push(
        Object.fromEntries(new URLSearchParams(raw)) as (typeof logins)[number],
      );
      res.end("<h1>已登录测试项目</h1>");
      return;
    }
    visits.push(req.url!);
    res.end(
      `<h1>测试项目 ${req.url}</h1><form action="/login" method="post"><input type="hidden" name="site" value="${req.url}"><label>用户名<input name="username"></label><label>密码<input name="password" type="password"></label><button>登录</button></form>`,
    );
  }),
);
let modelRequests = 0;
const modelInputs: string[] = [];
function stream(res: http.ServerResponse, name?: string, args: unknown = {}) {
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
    : { role: "assistant", content: "已完成项目问答。" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}
const modelUrl = await listen(
  http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    modelInputs.push(raw);
    modelRequests++;
    const tools = input.tools?.map((t: any) => t.function.name) || [];
    const results = input.messages.filter((m: any) => m.role === "tool");
    if (tools.includes("browser_observe") && !results.length)
      stream(res, "browser_observe");
    else if (tools.includes("browser_login") && results.length === 1) {
      const observed = JSON.parse(results[0].content);
      const ref = (label: string) =>
        observed.elements.find((e: any) => e.label === label).ref;
      stream(res, "browser_login", {
        usernameRef: ref("用户名"),
        passwordRef: ref("密码"),
        submitRef: ref("登录"),
      });
    } else stream(res);
  }),
);
config.llm = { baseUrl: modelUrl + "/v1", key: "fixture", model: "fixture" };
Object.assign(process.env, {
  PUBLIC_LLM_BASE_URL: modelUrl + "/v1",
  PUBLIC_LLM_API_KEY: "fixture",
  PUBLIC_LLM_MODEL: "fixture",
});
const appUrl = await listen(createServer());
config.port = Number(new URL(appUrl).port);
after(async () => {
  await disposeConversations();
  await closeAllBrowsers();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await rm(tmp, { recursive: true, force: true });
});
async function api(
  route: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const response = await fetch(appUrl + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-QA-Admin-Token": config.token,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}
async function publicAsk(question = "怎么记录一个新的备忘录啊？") {
  const response = await fetch(appUrl + "/api/v1/public/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const events = (await response.text())
    .split("\n")
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice(6)));
  assert.ok(
    events.some((e) => e.type === "done"),
    JSON.stringify(events),
  );
  assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events));
  return events;
}

test("项目保存独立默认值；旧项目只迁移一次，网址始终跟随目标网页", async () => {
  const p = await createProject({ name: "新项目", url: webUrl + "/new" });
  assert.equal(p.publicBrowser?.url, null);
  assert.equal(p.publicBrowser?.username, "default-user");
  const id = randomUUID();
  await atomic(path.join(projectDir(id), "project.json"), {
    key: id,
    name: "旧项目",
    path: null,
    url: webUrl + "/legacy/",
    createdAt: new Date().toISOString(),
  });
  await migrateProjectSettings();
  const migrated = await getProject(id);
  assert.deepEqual(migrated.publicBrowser, p.publicBrowser);
  try {
    process.env.PUBLIC_BROWSER_ENABLED = "false";
    process.env.PUBLIC_TEST_PASSWORD = "different-global-password";
    await migrateProjectSettings();
    assert.deepEqual(
      (await getProject(id)).publicBrowser,
      migrated.publicBrowser,
    );
    assert.deepEqual(
      publicBrowserSettings(await getProject(p.key)),
      p.publicBrowser,
    );
    const updated = await updateProject(id, { url: webUrl + "/changed/" });
    assert.equal(updated.publicBrowser?.url, null);
    assert.equal(updated.url, webUrl + "/changed/");
    assert.equal(updated.publicBrowser?.password, "default-password");
  } finally {
    process.env.PUBLIC_BROWSER_ENABLED = "true";
    process.env.PUBLIC_TEST_PASSWORD = "default-password";
  }
});

test("管理接口支持项目探索设置，隐藏密码，部分更新保留密码并可清除", async () => {
  const p = await api("/api/projects", {
    name: "账号设置",
    url: webUrl,
    publicBrowser: {
      enabled: true,
      username: "settings-user",
      password: "settings-secret",
    },
  });
  const route = `/api/projects/${p.key}`;
  for (const data of [
    p,
    await api(route),
    await api("/api/projects"),
    await api(route + "/activate", {}),
  ]) {
    assert.ok(!JSON.stringify(data).includes("settings-secret"));
  }
  assert.equal(p.publicBrowser.passwordConfigured, true);
  const updated = await api(
    route,
    { publicBrowser: { enabled: false, url: webUrl + "/test/" } },
    "PATCH",
  );
  assert.equal(updated.publicBrowser.passwordConfigured, true);
  assert.equal(
    (await getProject(p.key)).publicBrowser?.password,
    "settings-secret",
  );
  assert.equal(
    (await getProject(p.key)).publicBrowser?.username,
    "settings-user",
  );
  await api(route, { publicBrowser: { password: "", url: "" } }, "PATCH");
  assert.equal((await getProject(p.key)).publicBrowser?.password, "");
  assert.equal((await getProject(p.key)).publicBrowser?.url, null);
  for (const invalid of [
    { enabled: "true" },
    { url: "javascript:alert(1)" },
    { password: 123 },
    null,
  ]) {
    await assert.rejects(
      updateProject(p.key, { publicBrowser: invalid as any }),
      (e) => e instanceof HttpError && e.status === 400,
    );
  }
  assert.equal((await fetch(appUrl + route)).status, 403);
  const publicConfig = await api("/api/v1/public/config");
  assert.ok(!JSON.stringify(publicConfig).includes("settings-user"));
  assert.ok(!("publicBrowser" in publicConfig));
});

test("公共问答忽略全局旧地址，切换项目后访问各自网址并使用各自测试账号", async () => {
  const a = await api("/api/projects", {
    name: "项目 A",
    url: webUrl + "/alpha/",
    publicBrowser: {
      enabled: true,
      username: "alpha-user",
      password: "alpha-secret",
    },
  });
  const b = await api("/api/projects", {
    name: "项目 B",
    url: webUrl + "/beta/",
    publicBrowser: {
      enabled: true,
      username: "beta-user",
      password: "beta-secret",
    },
  });
  try {
    process.env.PUBLIC_BROWSER_ENABLED = "false";
    process.env.PUBLIC_TEST_USERNAME = "unrelated-global-user";
    for (const [p, site, username, password] of [
      [a, "/alpha/", "alpha-user", "alpha-secret"],
      [b, "/beta/", "beta-user", "beta-secret"],
    ] as const) {
      await api(`/api/projects/${p.key}/activate`, {});
      const events = await publicAsk();
      assert.ok(visits.includes(site));
      assert.deepEqual(logins.at(-1), { site, username, password });
      assert.ok(!JSON.stringify(events).includes(password));
      assert.ok(modelInputs.every((raw) => !raw.includes(password)));
    }
  } finally {
    process.env.PUBLIC_BROWSER_ENABLED = "true";
    process.env.PUBLIC_TEST_USERNAME = "default-user";
  }
});

test("独立探索地址覆盖目标网页；关闭浏览器和已审核问答不启动浏览器", async () => {
  const p = await api("/api/projects", {
    name: "独立测试环境",
    url: "http://127.0.0.1:1/unused",
    publicBrowser: {
      enabled: true,
      url: webUrl + "/isolated/",
      username: "test-user",
      password: "test-secret",
    },
  });
  await publicAsk();
  assert.deepEqual(logins.at(-1), {
    site: "/isolated/",
    username: "test-user",
    password: "test-secret",
  });
  await api(
    `/api/projects/${p.key}`,
    {
      url: webUrl + "/moved/",
      publicBrowser: { url: "" },
    },
    "PATCH",
  );
  await publicAsk();
  assert.equal(logins.at(-1)?.site, "/moved/");
  await api(
    `/api/projects/${p.key}`,
    { publicBrowser: { enabled: false } },
    "PATCH",
  );
  const before = visits.length;
  await publicAsk();
  assert.equal(visits.length, before);
  await api(
    `/api/projects/${p.key}`,
    { publicBrowser: { enabled: true } },
    "PATCH",
  );
  await saveQa(p.key, {
    question: "现有答案",
    answer: "已审核回答",
    status: "verified",
  });
  const previousRequests = modelRequests;
  const events = await publicAsk("现有答案");
  assert.ok(events.some((e) => e.type === "qa" && e.tier === "exact"));
  assert.equal(modelRequests, previousRequests);
  assert.equal(visits.length, before);
});

test("管理台可编辑当前项目配置，密码留空保留，切换项目显示各自设置", async () => {
  const a = await api("/api/projects", {
    name: "界面 A",
    url: webUrl + "/ui-a/",
  });
  const b = await api("/api/projects", {
    name: "界面 B",
    url: webUrl + "/ui-b/",
    publicBrowser: { enabled: false, username: "ui-b-user", password: "" },
  });
  await api(`/api/projects/${a.key}/activate`, {});
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(appUrl);
    await page.locator("#token").fill(config.token);
    await page.locator("#auth-form button").click();
    await page.locator("#project-settings").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#project-target-url").inputValue(),
      webUrl + "/ui-a/",
    );
    await page.locator("#public-browser-url").fill(webUrl + "/ui-a-test/");
    await page.locator("#public-browser-username").fill("ui-a-user");
    await page.locator("#public-browser-password").fill("ui-a-secret");
    await page.locator("#project-settings-form button").click();
    await page.waitForFunction(() =>
      document.querySelector("#notice")?.textContent?.includes("设置已保存"),
    );
    const saved = await getProject(a.key);
    assert.equal(saved.publicBrowser?.url, webUrl + "/ui-a-test/");
    assert.equal(saved.publicBrowser?.password, "ui-a-secret");
    assert.equal(
      await page.locator("#public-browser-password").inputValue(),
      "",
    );
    await page.locator("#project-settings-form button").click();
    await page.waitForFunction(
      () =>
        !(
          document.querySelector(
            "#project-settings-form button",
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      (await getProject(a.key)).publicBrowser?.password,
      "ui-a-secret",
    );
    await page
      .locator("#projects .item")
      .filter({ hasText: "界面 B" })
      .getByRole("button")
      .click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#public-browser-username") as HTMLInputElement)
          ?.value === "ui-b-user",
    );
    assert.equal(
      await page.locator("#public-browser-enabled").isChecked(),
      false,
    );
    assert.equal(await page.locator("#public-browser-url").inputValue(), "");
    assert.equal(
      await page
        .locator("#public-browser-password")
        .getAttribute("placeholder"),
      "未设置",
    );
    await page
      .locator("#projects .item")
      .filter({ hasText: "界面 A" })
      .getByRole("button")
      .click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#public-browser-username") as HTMLInputElement)
          ?.value === "ui-a-user",
    );
    await page.locator("#clear-public-password").check();
    await page.locator("#project-settings-form button").click();
    await page.waitForFunction(
      () =>
        !(
          document.querySelector(
            "#project-settings-form button",
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal((await getProject(a.key)).publicBrowser?.password, "");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
