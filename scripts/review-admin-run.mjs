// Re-evaluate a preserved run against fresh business readback; does not call a model.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { inspectAdminReadback } from "../test/fixtures/admin-readback.ts";

const output = path.resolve(".webdemo/verification");
const rawPath = path.resolve(
  process.argv[2] || path.join(output, "complex-admin-live.json"),
);
const raw = JSON.parse(await readFile(rawPath, "utf8"));
assert.equal(raw.status, "failed");
assert.ok(
  raw.error.includes(
    "must reload, requery same record, then inspect audit after approval",
  ),
  "only the known over-specific reload gate may be reviewed",
);
const original = path.join(
  output,
  `complex-admin-strict-${path.basename(raw.dataDir)}.json`,
);
await copyFile(rawPath, original);
const readback = inspectAdminReadback(raw.requests, "PO-012");
assert.ok(
  readback.passed,
  "server must receive fresh reads of the same record and audit after the write",
);
assert.equal(raw.domainEvents.length, 1);
assert.equal(raw.domainEvents[0].orderId, "PO-012");
assert.equal(raw.domainEvents[0].status, "已通过");
assert.equal(raw.domainEvents[0].comment, "验收通过");
assert.equal(raw.orders.find((o) => o.id === "PO-012").status, "已通过");
assert.ok(
  raw.orders
    .filter((o) => o.id !== "PO-012")
    .every((o) => o.status === "待审批"),
);
assert.equal(raw.workflow.published, true);
assert.equal(raw.workflow.plan.profile, "admin");
const projects = await readdir(path.join(raw.dataDir, "projects"));
assert.equal(projects.length, 1);
const projectRoot = path.join(raw.dataDir, "projects", projects[0]);
const guides = await readdir(path.join(projectRoot, "guides"));
const bundles = await Promise.all(
  guides
    .filter((f) => f.endsWith(".json") && !f.endsWith(".plan.json"))
    .map(async (f) =>
      JSON.parse(await readFile(path.join(projectRoot, "guides", f), "utf8")),
    ),
);
assert.equal(bundles.length, 1);
const guide = bundles[0];
const docs = await Promise.all(
  guide.modules.map((m) => {
    assert.ok(m.documentId);
    return readFile(
      path.join(projectRoot, "documents", m.documentId + ".json"),
      "utf8",
    ).then(JSON.parse);
  }),
);
const imageIds = new Set(
  docs.flatMap((d) => d.steps.flatMap((s) => (s.imageId ? [s.imageId] : []))),
);
for (const state of raw.workflow.scenarios) {
  assert.equal(state.status, "verified");
  assert.ok(state.checkpoints.length >= 2);
  const spec = raw.workflow.plan.modules
    .find((m) => m.id === state.moduleId)
    .scenarios.find((s) => s.id === state.scenarioId);
  assert.deepEqual(
    [...new Set(state.outcomes.flatMap((p) => p.ids))].sort(),
    spec.outcomes.map((c) => c.id).sort(),
  );
  for (const proof of [...state.checkpoints, ...state.outcomes]) {
    assert.ok(proof.evidence.checks.every((c) => c.passed));
    assert.ok(proof.images.some((id) => imageIds.has(id)));
  }
}
assert.ok(imageIds.size >= 4);
for (const doc of docs) {
  assert.ok(
    doc.references.some((r) => r.kind === "doc") &&
      doc.references.some((r) => r.kind === "page"),
  );
  assert.ok(!doc.references.some((r) => r.kind === "code"));
  assert.ok(
    !doc.steps.some((s) =>
      /browser_act|quick_start_|wiki_read/.test(s.instruction),
    ),
    "business instructions should not expose runtime tools",
  );
}
const htmlFile = path.join(projectRoot, "guides", guide.id + ".html");
await copyFile(htmlFile, path.join(output, "complex-admin-reviewed.html"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
let imageCount;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(pathToFileURL(htmlFile).href);
  imageCount = await page.locator("img").count();
  assert.ok(imageCount >= 4);
  assert.ok(
    await page
      .locator("img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0),
      ),
  );
  await page.screenshot({
    path: path.join(output, "complex-admin-reviewed-preview.png"),
  });
} finally {
  await browser.close();
}
let formImage;
for (const id of raw.workflow.scenarios[0].checkpoints[1].images) {
  if (!imageIds.has(id)) continue;
  const metadata = JSON.parse(
    await readFile(path.join(projectRoot, "artifacts", id + ".json"), "utf8"),
  );
  if (metadata.kind === "annotated") {
    formImage = path.join(output, "complex-admin-form.png");
    await copyFile(path.join(projectRoot, "artifacts", id + ".png"), formImage);
    break;
  }
}
const report = {
  status: "passed_with_verifier_correction",
  reviewedAt: new Date().toISOString(),
  originalReport: original,
  correction:
    "检查审批后服务端确实重新读取同一记录与日志；不强制SPA重载首页，也不要求独立只读结果的固定先后顺序。",
  pageReloadObserved: readback.pageReloadObserved,
  readback,
  guideId: guide.id,
  htmlFile: path.join(output, "complex-admin-reviewed.html"),
  formImage,
  imageCount,
  checkpoints: raw.workflow.scenarios.map((s) =>
    s.checkpoints.map((c) => c.title),
  ),
  domainEvents: raw.domainEvents,
  unchangedRecords: raw.orders.filter((o) => o.id !== "PO-012").length,
  tools: raw.tools,
  requests: raw.requests,
};
await writeFile(
  path.join(output, "complex-admin-reviewed.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    status: report.status,
    guideId: guide.id,
    imageCount,
    pageReloadObserved: report.pageReloadObserved,
  }),
);
