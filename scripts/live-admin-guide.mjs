// Explicit paid-model acceptance against an isolated local backend console.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
process.loadEnvFile(".env");
const { config } = await import("../src/config.ts");
const output = path.resolve(".webdemo/verification");
config.data = path.join(output, "admin-runs", randomUUID());
const { createProject, projectDir } = await import("../src/store.ts");
const { importWiki } = await import("../src/knowledge.ts");
const { ask, disposeConversations } = await import("../src/agent.ts");
const { connectBrowser, closeAllBrowsers } = await import("../src/browser.ts");
const { startAdminConsole } = await import("../test/fixtures/admin-console.ts");
const { inspectAdminReadback } = await import(
  "../test/fixtures/admin-readback.ts"
);
const app = await startAdminConsole();
const events = [];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 900000);
const cancel = () => controller.abort();
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
const report = {
  checkedAt: new Date().toISOString(),
  dataDir: config.data,
  status: "running",
};
const secrets = Object.entries(process.env)
  .filter(([k, v]) => /(KEY|TOKEN|PASSWORD)$/.test(k) && v)
  .map(([, v]) => v);
const redact = (value) =>
  secrets.reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    String(value),
  );
try {
  const project = await createProject({
    name: "企业采购后台（独立验收）",
    url: app.url,
  });
  await importWiki(
    project,
    "purchase-operations.md",
    "# Page: 角色与审批规则\n这是专用测试采购后台。业务管理下有采购管理，再进入采购单或审批日志。采购审核员可审批待审批采购单，只读观察员只能查看。列表每页5条，可按单号、状态过滤。审批抽屉有单据详情和审批意见标签。审批结果可选通过或转交复核，意见至少2字；转交必须选择复核员。通过后，采购单列表的状态列和审批日志的结果列均显示已通过；日志列为单号、结果、意见、操作人，并记录本次审批意见。审批必须确认，空意见不会提交。\n# Page: 本次任务\n仅处理PO-012，申请人李四，金额320元，初始待审批；其他单据保持原状。意见填写验收通过。初始该单不在第一页，可翻页或筛选，不能把当前页未出现当作全量不存在。提交后重新进入列表核对同一单号状态，并查看审批日志核对唯一记录。只能操作本次独立测试数据。\n",
  );
  const connection = await connectBrowser(project, true);
  await ask(
    project,
    {
      browserId: connection.id,
      mode: "quick_start",
      question:
        "请为采购审核员生成一份复杂后台操作指南，完成真实任务：从三级菜单进入采购单，确认第一页未显示目标时不能宣称不存在，再筛选定位PO-012（李四、320元），通过该行审批抽屉填写结果“通过”、意见“验收通过”，经过确认完成审批。随后刷新页面、重新进入列表筛选同一单号，核对已通过及操作人，再到审批日志核对只有本次记录。不要审批其他单据。这是已授权的独立测试服务。\n读取workflow与admin技能资料，规划profile=admin的一模块成功场景，至少两个中间检查点（唯一记录已定位、表单已正确填写），分别核验并截图后再继续。业务结果需最终验证，不用toast代替；关键截图用image_annotate画编号框。所有检查点与结果截图留在证据归档。document_write绑定模块，展示3至6步短说明和2至4张关键图，保留doc与page依据，最后quick_start_publish；宿主随后自动整理QA草稿。文案简短自然，不写验收过程，单号和意见仅作示例；不要输出ref或文件路径。完成后保留数据供宿主验收，不要撤销审批。",
    },
    (event) => {
      events.push(event);
      if (event.type === "tool")
        console.log(JSON.stringify({ tool: event.name, status: event.status }));
    },
    controller.signal,
  );
  const guide = events.find((e) => e.type === "guide")?.guide;
  assert.ok(guide, "must persist a guide");
  assert.equal(guide.verification.plan.profile, "admin");
  assert.ok(guide.verification.scenarios.every((s) => s.status === "verified"));
  assert.ok(
    guide.verification.scenarios.every(
      (s) =>
        s.checkpoints.length >= 2 &&
        s.checkpoints.every(
          (c) => c.images.length && c.evidence.checks.every((x) => x.passed),
        ),
    ),
  );
  assert.equal(app.events.length, 1, "exactly one approval");
  for (const state of guide.verification.scenarios) {
    const spec = guide.verification.plan.modules
      .find((m) => m.id === state.moduleId)
      .scenarios.find((s) => s.id === state.scenarioId);
    assert.deepEqual(
      [...new Set(state.outcomes.flatMap((p) => p.ids))].sort(),
      spec.outcomes.map((c) => c.id).sort(),
      "every declared outcome needs its own evidence",
    );
  }
  assert.equal(app.events[0].orderId, "PO-012");
  assert.equal(app.events[0].comment, "验收通过");
  // Verify fresh business data, independent of SPA re-query vs document reload.
  const readback = inspectAdminReadback(app.requests, "PO-012");
  assert.ok(
    readback.passed,
    "must read the same record and audit from the server after approval",
  );
  report.readback = readback;
  assert.ok(
    guide.verification.scenarios.every(
      (s) =>
        s.outcomes.length &&
        s.outcomes.every(
          (p) => p.images.length && p.evidence.checks.every((c) => c.passed),
        ),
    ),
  );
  assert.equal(app.orders.find((o) => o.id === "PO-012").status, "已通过");
  assert.ok(
    app.orders
      .filter((o) => o.id !== "PO-012")
      .every((o) => o.status === "待审批"),
  );
  const toolNames = events
    .filter((e) => e.type === "tool" && e.status === "done")
    .map((e) => e.name);
  assert.ok(
    !toolNames.some((n) => ["read", "bash", "ls", "grep", "find"].includes(n)),
  );
  assert.ok(toolNames.includes("browser_table"));
  assert.ok(toolNames.includes("image_annotate"));
  const module = guide.modules.find((m) => m.documentId);
  const doc = JSON.parse(
    await readFile(
      path.join(
        projectDir(project.key),
        "documents",
        module.documentId + ".json",
      ),
      "utf8",
    ),
  );
  assert.ok(
    doc.references.some((r) => r.kind === "doc") &&
      doc.references.some((r) => r.kind === "page"),
  );
  const images = new Set(
    doc.steps.flatMap((s) => (s.imageId ? [s.imageId] : [])),
  );
  assert.ok(
    images.size >= 1 && images.size <= 6,
    "guide selects key screenshots while complete evidence stays archived",
  );
  const htmlFile = path.join(
    projectDir(project.key),
    "guides",
    guide.id + ".html",
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(pathToFileURL(htmlFile).href);
    assert.ok((await page.locator("img").count()) >= 1);
    assert.ok(
      await page
        .locator("img")
        .evaluateAll((imgs) =>
          imgs.every((i) => i.complete && i.naturalWidth > 0),
        ),
    );
    await page.screenshot({
      path: path.join(output, "complex-admin-guide-preview.png"),
    });
  } finally {
    await browser.close();
  }
  const qaJob = events.find(
    (e) => e.type === "qa_generation" && e.job.status === "completed",
  )?.job;
  assert.ok(qaJob?.qaIds.length, "guide must automatically produce QA drafts");
  Object.assign(report, {
    qaJob,
    status: "pass",
    guideId: guide.id,
    htmlFile,
    projectId: project.key,
    tools: toolNames,
    checkpoints: guide.verification.scenarios.map((s) => ({
      id: s.scenarioId,
      checkpoints: s.checkpoints.map((c) => c.id),
    })),
    imageCount: images.size,
    domainEvents: app.events,
    requests: app.requests,
  });
  console.log(
    JSON.stringify({
      status: "pass",
      guideId: guide.id,
      imageCount: images.size,
    }),
  );
} catch (error) {
  Object.assign(report, {
    status: "failed",
    error: redact(error.stack || error.message),
    tools: events
      .filter((e) => e.type === "tool")
      .map((e) => ({ name: e.name, status: e.status })),
    workflow: events.filter((e) => e.type === "workflow").at(-1)?.workflow,
  });
  console.log(JSON.stringify({ status: "failed", error: report.error }));
  process.exitCode = 1;
} finally {
  report.requests = app.requests;
  report.domainEvents = app.events;
  report.orders = app.orders;
  clearTimeout(timeout);
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "complex-admin-live.json"),
    JSON.stringify(report, null, 2),
  );
  await disposeConversations();
  await closeAllBrowsers();
  await app.close();
}
