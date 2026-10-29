// Inspect a saved guide + QA through the running local service; no model calls.
import assert from "node:assert/strict";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
process.loadEnvFile(".env");
const { atomic, json, projectDir, validId } = await import("../src/store.ts");
const { escapeHtml, documentStyle } = await import("../src/documents.ts");
const { matchQa } = await import("../src/qa.ts");
const [projectId, guideId] = process.argv.slice(2);
assert.ok(
  validId(projectId) && validId(guideId),
  "provide PROJECT_ID GUIDE_ID",
);
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
const headers = { "X-QA-Admin-Token": process.env.QA_ADMIN_TOKEN };
async function api(route, method = "GET") {
  const res = await fetch(base + route, { method, headers });
  assert.ok(res.ok, `${route}: ${res.status}`);
  return res.json();
}
const root = projectDir(projectId),
  out = path.resolve(".webdemo/verification");
await mkdir(out, { recursive: true });
const guide = (await api(`/api/projects/${projectId}/guides`)).items.find(
  (g) => g.id === guideId,
);
assert.equal(guide.qaGeneration.status, "completed");
const projectQas = (await api(`/api/projects/${projectId}/qa`)).items;
const qas = projectQas.filter(
  (q) =>
    q.source?.guideId === guideId &&
    q.sourceCurrent !== false &&
    guide.modules.some(
      (module) =>
        module.id === q.source.moduleId &&
        module.documentId === q.source.documentId,
    ),
);
assert.ok(qas.length > 0);
for (const m of guide.modules.filter((m) => m.documentId)) {
  const doc = await json(path.join(root, "documents", m.documentId + ".json"));
  const matches = qas.filter((q) => q.source.moduleId === m.id);
  assert.ok(matches.length > 0 && matches.length <= 3);
  assert.ok(
    matches.every(
      (q) => q.status === "draft" && q.source.documentId === m.documentId,
    ),
  );
  assert.ok(
    matches.every((q) =>
      q.source.references.every((r) =>
        doc.references.some(
          (x) => x.kind === r.kind && x.location === r.location,
        ),
      ),
    ),
  );
  const verification = doc.verification || guide.verification;
  for (const state of verification.scenarios.filter(
    (s) => s.moduleId === m.id && s.status === "verified",
  )) {
    for (const proof of [...state.checkpoints, ...state.outcomes]) {
      assert.ok(
        proof.images.length && proof.evidence.checks.every((c) => c.passed),
      );
      for (const id of proof.images)
        await stat(path.join(root, "artifacts", id + ".png"));
    }
  }
  assert.ok(doc.steps.length > 0);
  if (doc.coverage)
    assert.ok(
      doc.coverage.every((item) =>
        ["covered", "limited"].includes(item.status),
      ),
    );
}
for (const q of qas)
  assert.equal(
    (await matchQa(projectId, q.question)).decision,
    "agent",
    "drafts must not answer public questions",
  );
const cached = await api(
  `/api/projects/${projectId}/guides/${guideId}/qa`,
  "POST",
);
assert.deepEqual([...cached.qaIds].sort(), qas.map((q) => q.id).sort());
const html = await readFile(
  path.join(root, "guides", guideId + ".html"),
  "utf8",
);
assert.ok(!/验证范围：|任务契约待复核|<h2>依据/.test(html));
const htmlFile = path.join(out, "complete-guide.html"),
  qaFile = path.join(out, "complete-guide-qa.html");
await atomic(htmlFile, html, true);
await atomic(
  qaFile,
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${documentStyle}</style><h1>配套问答草稿</h1><p>由快速上手指南自动整理，待人工审核后用于直答。</p>${qas.map((q) => `<section><h2>${escapeHtml(q.question)}</h2><p>${escapeHtml(q.answer)}</p></section>`).join("")}</html>`,
  true,
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
let originalProject;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.goto(pathToFileURL(htmlFile).href);
  const images = await page.locator("img").count();
  assert.ok(images > 0);
  assert.ok(
    await page
      .locator("img")
      .evaluateAll((imgs) =>
        imgs.every((i) => i.complete && i.naturalWidth > 0),
      ),
  );
  await page.screenshot({
    path: path.join(out, "complete-guide-preview.png"),
    fullPage: true,
  });
  const projects = await api("/api/projects");
  originalProject = projects.activeProjectId;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator("#token").fill(process.env.QA_ADMIN_TOKEN);
  await page.locator("#auth-form button").click();
  await page.locator("#admin").waitFor({ state: "visible" });
  if (originalProject !== projectId) {
    const p = projects.projects.find((p) => p.key === projectId);
    await page
      .locator("#projects .item")
      .filter({ hasText: p.name })
      .getByRole("button", { name: "切换到此项目" })
      .click();
    await page.locator("#project-name").filter({ hasText: p.name }).waitFor();
  }
  await page.locator('[data-view="documents"]').click();
  await page
    .getByText(`已整理 ${qas.length} 条问答，前往「问答审核」确认。`, {
      exact: true,
    })
    .waitFor();
  await page.locator('[data-view="qa"]').click();
  await page
    .locator("#qa-list .item")
    .filter({ hasText: qas[0].question })
    .waitFor();
  assert.equal(await page.locator("#qa-list .item").count(), projectQas.length);
  assert.equal(
    await page
      .getByRole("button", { name: "确认可用于直答", exact: true })
      .count(),
    projectQas.filter((q) => q.status !== "verified").length,
  );
  await page.screenshot({
    path: path.join(out, "qa-review-preview.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const report = {
    status: "passed",
    guideId,
    projectId,
    images,
    qaCount: qas.length,
    qaStatus: "draft",
    htmlFile,
    qaFile,
    checkedAt: new Date().toISOString(),
    checks: [
      "offline images",
      "archived proof retained",
      "QA provenance and quotas",
      "drafts excluded from public answers",
      "repeat request deduplicated",
      "admin guide and QA panels",
    ],
  };
  await atomic(path.join(out, "complete-guide-qa.json"), report);
  console.log(JSON.stringify(report));
} finally {
  if (originalProject && originalProject !== projectId)
    await api(`/api/projects/${originalProject}/activate`, "POST");
  await browser.close();
}
