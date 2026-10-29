// 显式调用的真实模型验收，会使用 .env 配置的模型服务并保存指南草稿。
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
process.loadEnvFile(".env");
const { activeProject, getProject, projectDir } = await import(
  "../src/store.ts"
);
const { ask, disposeConversations } = await import("../src/agent.ts");
const { connectBrowser, getBrowser, closeAllBrowsers } = await import(
  "../src/browser.ts"
);
const project = await getProject(await activeProject());
const report = {
  checkedAt: new Date().toISOString(),
  project: project.name,
  cases: [],
};
const privateValues = Object.entries(process.env)
  .filter(([k, v]) => /(KEY|TOKEN|PASSWORD)$/.test(k) && v)
  .map(([, v]) => v);
const redact = (value) =>
  privateValues.reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    String(value),
  );
function record(label, events) {
  const tools = events
    .filter((e) => e.type === "tool" && e.status === "done")
    .map((e) => e.name);
  assert.ok(
    !tools.some((t) => ["read", "ls", "grep", "find", "bash"].includes(t)),
  );
  const done = events.find((e) => e.type === "done");
  assert.ok(done);
  const result = {
    name: label,
    status: "pass",
    tools,
    runId: done.result.runId,
    answerChars: done.result.answer.length,
  };
  report.cases.push(result);
  return result;
}
function emitter(label, events) {
  return (e) => {
    events.push(e);
    if (e.type === "tool" || e.type === "skill")
      console.log(
        JSON.stringify({
          case: label,
          type: e.type,
          name: e.name,
          status: e.status,
        }),
      );
  };
}
try {
  assert.equal(
    project.url,
    process.env.PUBLIC_TEST_URL,
    "真实浏览器验收必须绑定专用测试网址",
  );
  const publicBrowser = await connectBrowser(project, true);
  const publicEvents = [];
  await ask(
    project,
    {
      question:
        "请实际使用浏览器登录配置的专用测试账号，打开钱包页面，告诉我当前余额以及钱包页面支持哪些操作。不要充值、退款或创建预约，不要输出账号密码。",
      browserId: publicBrowser.id,
    },
    emitter("public-browser", publicEvents),
    AbortSignal.timeout(180000),
    true,
  );
  const pub = record("低置信度模型自动登录与钱包观察", publicEvents);
  assert.ok(pub.tools.includes("browser_login"));
  assert.ok(pub.tools.includes("browser_observe"));
  console.log(
    JSON.stringify({
      case: "public-browser",
      status: "pass",
      tools: pub.tools.length,
    }),
  );
  const guideBrowser = await connectBrowser(project, true);
  const page = getBrowser(guideBrowser.id, project.key).page;
  await page
    .locator('input[name="username"]')
    .fill(process.env.PUBLIC_TEST_USERNAME);
  await page
    .locator('input[name="password"]')
    .fill(process.env.PUBLIC_TEST_PASSWORD);
  await page.locator('form[data-form="login"] button[type="submit"]').click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#gp-account-name")?.textContent),
  );
  const guideEvents = [];
  await ask(
    project,
    {
      question:
        "为普通用户生成一份快速上手指南，恰好2个模块：查看羽毛球预约日历，以及查看钱包余额与流水。独立测试浏览器已经人工登录。先读取技能workflow资料和最相关的1至2页Wiki。先用browser_navigate分别进入两个模块页面，确认实际结果区域、余额和记录的可见内容，再锁定任务契约；不要把未观察到的Wiki术语设为必需文本。显式使用profile=general，每个模块选一个只读success场景，coverageReason说明本次仅做查询，不覆盖预约和余额错误分支。定义当前界面可验证的前置和结果条件。锁定计划后才能处理公告和导航；按prepare、begin、操作、verify、截图顺序执行，每个模块把验证后截图用image_annotate画编号框并在文案说明编号，document_write绑定moduleId并包含doc与page依据。先由全局只读探索会话用guide_outline确定这两个章节及完整questions清单，再分别由独立章节会话核验并用document_write提交完整操作说明和coverage；整本由宿主组装，不调用发布工具，不限制正文长度或图片数量。编号的详细解释放image_annotate.description，由宿主自动放在图下。只做查询，不提交预约、充值、退款或取消。不要输出账号密码。",
      browserId: guideBrowser.id,
      mode: "quick_start",
    },
    emitter("quick-start", guideEvents),
    AbortSignal.timeout(600000),
  );
  record("快速上手 Skill 与离线指南", guideEvents);
  assert.ok(
    guideEvents.some((e) => e.type === "skill" && e.name === "quick-start"),
  );
  const guide = guideEvents.find((e) => e.type === "guide")?.guide;
  assert.ok(guide, "必须实际保存指南");
  assert.equal(guide.complete, true);
  assert.equal(guide.verification.level, "ui-checks");
  assert.ok(
    guide.verification.chapters.every(
      (chapter) => chapter.status === "generated",
    ),
  );
  assert.ok(
    guideEvents.some(
      (e) =>
        e.type === "tool" && e.name === "image_annotate" && e.status === "done",
    ),
  );
  assert.equal(guide.modules.length, 2);
  assert.ok(guide.modules.every((m) => m.documentId));
  for (const mod of guide.modules) {
    const doc = JSON.parse(
      await readFile(
        path.join(
          projectDir(project.key),
          "documents",
          mod.documentId + ".json",
        ),
        "utf8",
      ),
    );
    assert.ok(
      doc.steps.some((s) => s.imageId || s.images?.length),
      "每模块必须有真实截图",
    );
    assert.ok(
      doc.verification.scenarios.every(
        (scenario) => scenario.status === "verified",
      ),
    );
    assert.ok(doc.coverage.every((item) => item.status === "covered"));
    assert.ok(doc.references.some((r) => r.kind === "doc"));
    assert.ok(doc.references.some((r) => r.kind === "page"));
    assert.ok(!doc.references.some((r) => r.kind === "code"));
  }
  const htmlFile = path.join(
    projectDir(project.key),
    "guides",
    guide.id + ".html",
  );
  const html = await readFile(htmlFile, "utf8");
  assert.ok(html.includes("data:image/png;base64,"));
  assert.ok(!html.includes("/api/artifacts/"));
  report.guide = { id: guide.id, title: guide.title, htmlFile };
  console.log(
    JSON.stringify({
      case: "quick-start",
      status: "pass",
      guideId: guide.id,
      modules: guide.modules.length,
    }),
  );
} catch (e) {
  report.error = redact(e.message);
  console.log(JSON.stringify({ status: "failed", error: report.error }));
  process.exitCode = 1;
} finally {
  await disposeConversations();
  await closeAllBrowsers();
  await mkdir(".webdemo/verification", { recursive: true });
  await writeFile(
    ".webdemo/verification/live-guide.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
