// Real EspoCRM + configured model acceptance. No mock provider, no CRM writes.
// ESPO_TEST_USERNAME=... ESPO_TEST_PASSWORD=... node --env-file=.env --import tsx scripts/live-espo-guide.mjs /path/to/wiki.md
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const username = process.env.ESPO_TEST_USERNAME;
const password = process.env.ESPO_TEST_PASSWORD;
assert.ok(username && password, "set ESPO_TEST_USERNAME / ESPO_TEST_PASSWORD");
assert.ok(
  process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL,
  "load the real model configuration with --env-file",
);
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /KEY|TOKEN|PASSWORD/.test(key) && value)
  .map(([, value]) => value);
const redact = (value) =>
  secrets.reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    String(value),
  );
const output = path.resolve(".webdemo/verification");
await mkdir(output, { recursive: true });
const runDir = await mkdtemp(path.join(output, "live-espo-"));
const inputs = path.join(runDir, "inputs");
await mkdir(inputs);
const source =
  process.argv[2] ||
  path.join(
    os.homedir(),
    "Downloads",
    (await readdir(path.join(os.homedir(), "Downloads")))
      .filter((name) => /^espocrm_wiki_.*\.md$/.test(name))
      .sort()
      .at(-1) || "missing-wiki.md",
  );
const stagedWiki = path.join(inputs, "espocrm-wiki.md");
await copyFile(source, stagedWiki);
process.env.DATA_DIR = path.join(runDir, "data");
process.env.PORT = "0";
process.env.BROWSER_HEADLESS = "false";
process.env.TARGET_REPO = "";
const { config } = await import("../src/config.ts");
const { main } = await import("../src/server.ts");
const { getBrowser, closeAllBrowsers } = await import("../src/browser.ts");
const { disposeConversations } = await import("../src/agent.ts");
const { json, projectDir } = await import("../src/store.ts");
const { verifyChecks } = await import("../src/quick-start.ts");
const app = await main();
if (!app.listening) await once(app, "listening");
config.port = app.address().port;
const base = `http://127.0.0.1:${config.port}`;
const headers = {
  "X-QA-Admin-Token": config.token,
  "Content-Type": "application/json",
};
const api = async (route, data) => {
  const response = await fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    headers,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    `${route}: ${response.status} ${redact(result.error || "")}`,
  );
  return result;
};
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  appUrl: base,
  targetUrl: "http://localhost:8080/",
  model: config.llm.model,
  runDir,
  stages: [],
  blockedBusinessRequests: [],
  browserErrors: [],
};
const trace = [];
const uiBrowser = await chromium.launch({ channel: "chrome", headless: true });
let project;
const persist = async () =>
  writeFile(
    path.join(runDir, "report.json"),
    redact(JSON.stringify(report, null, 2)),
    { mode: 0o600 },
  );
try {
  project = await api("/api/projects", {
    name: "EspoCRM · 真实提速验收",
    url: report.targetUrl,
  });
  report.projectId = project.key;
  await api(`/api/projects/${project.key}/wiki/import`, {
    files: [
      {
        name: "espocrm-generated.md",
        content: await readFile(stagedWiki, "utf8"),
      },
    ],
  });
  const connection = await api("/api/browser", { projectKey: project.key });
  const browser = getBrowser(connection.id, project.key);
  const userField = browser.page
    .locator('input[name="userName"], input[name="username"], #field-userName')
    .first();
  await userField.waitFor({ state: "visible", timeout: 30000 });
  await userField.fill(username);
  await browser.page
    .locator('input[name="password"], #field-password')
    .first()
    .fill(password);
  await browser.page
    .locator('#btn-login, button[type="submit"]')
    .first()
    .click();
  await userField.waitFor({ state: "hidden", timeout: 30000 });
  await browser.page
    .locator("body")
    .getByText("Stream", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await browser.page.screenshot({
    path: path.join(runDir, "crm-logged-in.png"),
    mask: [browser.page.locator('input[type="password"], [data-private]')],
  });
  // Protect the live CRM: login is already complete, all subsequent API writes are blocked.
  await browser.context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      report.blockedBusinessRequests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
  report.preflight = {
    home: await verifyChecks(
      browser.page,
      [
        {
          id: "home-stream",
          description: "真实Home的Stream标题",
          target: { role: "heading", name: "Stream" },
          assertion: "visible",
        },
        {
          id: "home-activities",
          description: "真实Home的My Activities标题",
          target: { role: "heading", name: "My Activities" },
          assertion: "visible",
        },
      ],
      0,
    ),
    refreshDiagnostics: {
      text: await browser.page.getByText("Refresh", { exact: true }).count(),
      visibleText: await browser.page
        .getByText("Refresh", { exact: true })
        .filter({ visible: true })
        .count(),
      title: await browser.page
        .getByTitle("Refresh", { exact: true })
        .filter({ visible: true })
        .count(),
      label: await browser.page
        .getByLabel("Refresh", { exact: true })
        .filter({ visible: true })
        .count(),
    },
  };
  assert.ok(
    report.preflight.home.every((check) => check.passed),
    "real Home heading preflight failed",
  );
  await browser.page
    .locator('a[href="#Account"]')
    .filter({ visible: true })
    .click();
  await browser.page
    .locator("h3")
    .filter({ hasText: "Accounts" })
    .waitFor({ timeout: 20000 });
  report.preflight.accounts = await verifyChecks(
    browser.page,
    [
      {
        id: "account-title",
        description: "忽略真实标题外侧装饰图标",
        target: { role: "heading", name: "Accounts" },
        assertion: "visible",
      },
      {
        id: "account-create",
        description: "真实客户列表创建入口，只定位",
        target: { role: "link", name: "+ Create Account" },
        assertion: "visible",
      },
      { id: "literal-create", description: "分散文字与图标组成的同名新建入口", target: { text: "+ Create Account" }, assertion: "visible" },
      { id: "literal-count", description: "同一计数按钮的嵌套文字不当成两个控件", target: { text: "0 / 0" }, assertion: "visible" },
    ],
    0,
  );
  assert.ok(
    report.preflight.accounts.every((check) => check.passed),
    "real Accounts locator preflight failed: " +
      JSON.stringify(report.preflight.accounts),
  );
  await browser.page.goto(report.targetUrl + "#", {
    waitUntil: "domcontentloaded",
  });
  await browser.page
    .getByRole("heading", { name: "Stream", exact: true })
    .waitFor({ timeout: 20000 });
  console.log(
    JSON.stringify({ stage: "real-dom-preflight", ...report.preflight }),
  );
  const ui = await uiBrowser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  ui.on("pageerror", (error) =>
    report.browserErrors.push(redact(error.message)),
  );
  await ui.goto(base);
  await ui.locator("#token").fill(config.token);
  await ui.locator("#auth-form button").click();
  await ui.locator("#admin").waitFor({ state: "visible" });
  console.log(
    JSON.stringify({
      stage: "real-browser-ready",
      appUrl: base,
      projectId: project.key,
      report: path.join(runDir, "report.json"),
    }),
  );
  await persist();
  const question = `这是已授权的EspoCRM专用环境真实只读验收，浏览器已由宿主登录。请用下载后导入的真实Wiki和实际页面生成完整快速上手指南，恰好两个互相独立的章节：
1. id=orientation，认识Home并找到Accounts入口。只解释如何识别Home、Stream和My Activities当前显示内容，以及如何通过左侧导航进入Accounts并返回Home。不巡览其他实体，不展开全部全局菜单，不研究其他角色权限。
2. id=accounts，阅读Accounts列表。只解释列表入口、页面标题、All过滤/列表搜索入口、当前记录计数与No Data空态，以及Create Account入口的位置；只识别新建入口，不打开或提交创建表单。
目录中必须原样使用以下questions，不能自行附加高亮颜色、DOM结构或后端实现条件：orientation第1题“如何根据Home的地址、面板标题和No Data识别当前位置并理解当前空态？”，第2题“如何从Home经左侧Accounts入口进入客户列表，再回到Home？”；accounts第1题“如何找到Accounts列表并读取标题、All过滤、列表搜索、当前计数和No Data？”，第2题“Create Account入口位于哪里，怎样确认它的作用（只定位、不打开）？”。两章没有必须创建的数据依赖，dependsOn均为空，建议阅读顺序可用readingPrerequisites。每章恰好2个questions，聚焦上述业务范围，不扩展到全站、写操作、导入、删除、邮件或角色管理，不把Wiki中的代码架构、元数据或后端服务实现单列为新用户指南问题。每章显式profile=general，一个只读success场景即可；该只读验收不设置中间checkpoints，最终核验并自动截图足够，不能为了形式重复巡览。先核对本页定位器唯一性，重复No Data按面板scope或真实count处理，Create Account用实际可访问名称限定而非宽泛href。按需读取最相关Wiki页，不反复读全文。
核验会自动截图；通过后立即guide_chapter_ready，不额外截图、不继续自由导航。每章选至少一张自动归档的截图，并在ready.images[].marks批量标注一至两个确实需要解释的精确小目标；不要框全页、整块大面板或让框互相重叠。所有原questions逐一提交事实和来源，真实无法确认项明确limited。独立writer生成完整、自然的业务说明，不以短为目标、不抄内部验收术语，保留必要的doc和page来源。禁止创建、编辑、删除任何CRM业务数据，禁止输出账号密码。`;
  const start = Date.now();
  const response = await fetch(base + "/api/ask", {
    method: "POST",
    headers,
    body: JSON.stringify({
      question,
      mode: "quick_start",
      projectKey: project.key,
      browserId: connection.id,
    }),
    signal: AbortSignal.timeout(
      Number(process.env.LIVE_TIMEOUT_SECONDS || 900) * 1000,
    ),
  });
  assert.ok(response.ok, `guide request: ${response.status}`);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    result;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "session") report.taskId = event.taskId;
        if (event.type === "guide_metrics") {
          report.stages.push(event.metrics);
          console.log(JSON.stringify({ stage: "metrics", ...event.metrics }));
          await persist();
        }
        if (event.type === "agent_phase")
          console.log(
            JSON.stringify({
              stage: event.phase,
              substage: event.stage,
              chapterId: event.chapterId,
              status: event.status,
              elapsedSeconds: Math.round((Date.now() - start) / 1000),
            }),
          );
        if (event.type === "tool") {
          const item = {
            type: "tool",
            name: event.name,
            status: event.status,
            ...(event.error ? { error: redact(event.error) } : {}),
            elapsedSeconds: Math.round((Date.now() - start) / 1000),
          };
          trace.push(item);
          if (event.status !== "start") console.log(JSON.stringify(item));
        }
        if (event.type === "done") result = event.result;
        if (event.type === "error") throw new Error(redact(event.error));
      }
    }
    if (done) break;
  }
  report.elapsedSeconds = (Date.now() - start) / 1000;
  report.result = result;
  assert.ok(result?.guideId, "the real model did not produce a saved guide");
  const root = projectDir(project.key);
  const guide = await json(path.join(root, "guides", result.guideId + ".json"));
  report.guideId = guide.id;
  report.complete = guide.complete;
  report.limitations = guide.limitations;
  assert.equal(
    guide.modules.filter((module) => module.documentId).length,
    2,
    "both real chapters must have documents",
  );
  const chapters = [];
  for (const module of guide.modules) {
    const doc = await json(
      path.join(root, "documents", module.documentId + ".json"),
    );
    const selected = doc.steps.flatMap((step) => [
      ...(step.imageId ? [step.imageId] : []),
      ...(step.images || []).map((image) => image.imageId),
    ]);
    assert.ok(selected.length, "each chapter needs real screenshots");
    const artifacts = await Promise.all(
      [...new Set(selected)].map((id) =>
        json(path.join(root, "artifacts", id + ".json")),
      ),
    );
    assert.ok(
      artifacts.some((artifact) => artifact.kind === "annotated"),
      "each chapter needs a real numbered annotation",
    );
    assert.ok(doc.references.some((reference) => reference.kind === "page"));
    assert.ok(doc.references.some((reference) => reference.kind === "doc"));
    chapters.push({
      id: module.id,
      steps: doc.steps.length,
      characters:
        doc.summary.length +
        (doc.details || "").length +
        doc.steps.reduce((sum, step) => sum + step.instruction.length, 0),
      images: selected.length,
      annotations: artifacts.filter((artifact) => artifact.kind === "annotated")
        .length,
      coverage: doc.coverage,
    });
  }
  report.chapters = chapters;
  const htmlFile = path.join(runDir, "guide.html");
  await copyFile(path.join(root, "guides", guide.id + ".html"), htmlFile);
  await copyFile(
    path.join(root, "guides", guide.id + ".md"),
    path.join(runDir, "guide.md"),
  );
  const html = await readFile(htmlFile, "utf8");
  assert.ok(
    !html.includes(password),
    "guide must not contain the login password",
  );
  await ui.goto(pathToFileURL(htmlFile).href);
  await ui.locator("img").first().waitFor();
  await ui.waitForFunction(() =>
    [...document.images].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  await ui.screenshot({
    path: path.join(runDir, "guide-preview.png"),
    fullPage: true,
  });
  report.preview = path.join(runDir, "guide-preview.png");
  assert.equal(
    report.blockedBusinessRequests.length,
    0,
    "the guide must not attempt CRM writes",
  );
  assert.deepEqual(report.browserErrors, []);
  assert.equal(
    guide.qaGeneration?.status,
    "completed",
    guide.qaGeneration?.error || "initial QA did not complete",
  );
  report.qaCount = guide.qaGeneration.qaIds.length;
  report.status = guide.complete ? "passed" : "partial";
  console.log(
    JSON.stringify({
      stage: "finished",
      status: report.status,
      seconds: report.elapsedSeconds,
      chapters: chapters.map(({ id, characters, images }) => ({
        id,
        characters,
        images,
      })),
      qaCount: report.qaCount,
      report: path.join(runDir, "report.json"),
    }),
  );
} catch (error) {
  report.status = "failed";
  report.error = redact(error.stack || error.message);
  console.error(
    JSON.stringify({
      stage: "failed",
      error: report.error,
      report: path.join(runDir, "report.json"),
    }),
  );
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  await writeFile(
    path.join(runDir, "trace.json"),
    JSON.stringify(trace, null, 2),
    { mode: 0o600 },
  );
  await uiBrowser.close();
  await disposeConversations();
  await closeAllBrowsers();
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
}
