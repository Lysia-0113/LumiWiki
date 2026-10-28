import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "../src/config.js";
import { createProject, projectDir } from "../src/store.js";
import {
  connectBrowser,
  getBrowser,
  closeAllBrowsers,
  observe,
  screenshot,
} from "../src/browser.js";
import { annotateImage } from "../src/artifacts.js";
import {
  QuickStartRun,
  verifyChecks,
  type TaskPlan,
} from "../src/quick-start.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-tasks-"));
config.data = tmp;
const example = async (name: string): Promise<TaskPlan> =>
  JSON.parse(
    await readFile(
      new URL(`../skills/quick-start/examples/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://localhost");
  const desk = u.pathname === "/helpdesk";
  const error = u.searchParams.get("mode") === "error";
  const broken = u.searchParams.get("mode") === "toast-only";
  const wrong = u.searchParams.get("mode") === "wrong-record";
  const message = desk ? "请输入标题" : "余额不足";
  const record = desk
    ? "网络故障 lumi-run-001 待处理"
    : "场地A 2030-01-01 已预约";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><main><div data-testid="balance">${error ? 0 : 100}</div><button style="width:180px;height:50px" onclick="document.querySelector('[role=alert]').textContent='${error ? message : "提交成功"}';${error || broken ? "" : `document.querySelector('[data-testid=records]').innerHTML='<article data-testid=${wrong ? "another-run" : "lumi-run-001"}>${record}</article>'`}">${desk ? "提交工单" : "预约"}</button><div role="alert" aria-label="${error ? message : "提交结果"}"></div><section data-testid="records"><span>暂无记录</span></section></main>`,
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test("契约前允许导航探路，通用点击和填写被拒绝", () => {
  const run = new QuickStartRun();
  run.reset();
  run.guard("browser_act", { action: "navigate" });
  run.guard("browser_navigate", { ref: "navigation" });
  assert.throws(() => run.guard("browser_act", { action: "click" }), /探路/);
  assert.throws(() => run.guard("browser_act", { action: "fill" }), /契约/);
});
after(async () => {
  await closeAllBrowsers();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});

for (const domain of ["gymbook", "helpdesk"])
  test(`${domain}：同一运行时验证创建与错误场景，文档需要逐场景证据`, async () => {
    const p = await createProject({
      name: domain,
      url: origin + (domain === "helpdesk" ? "/helpdesk" : "/gymbook"),
    });
    const connection = await connectBrowser(p, true);
    const b = getBrowser(connection.id, p.key);
    const plan = await example(domain);
    plan.modules = [plan.modules[0]];
    const m = plan.modules[0];
    const [success, failure] = m.scenarios;
    if (domain === "gymbook") {
      const [balance] = await verifyChecks(b.page, failure.preconditions, 0);
      assert.equal(
        balance.passed,
        false,
        "100 must not satisfy a zero balance precondition",
      );
    }
    const run = new QuickStartRun();
    run.setPlan(plan);
    assert.throws(() => run.setPlan(plan), /计划已锁定/);
    run.prepare(m.id, success.id);
    await run.begin(m.id, success.id, b.page);
    assert.throws(() => run.assertDocument(m.id), /未完成场景/);
    run.mutated();
    await b.page.getByRole("button").click();
    assert.equal((await run.verify(b.page)).status, "verified");
    const first = await screenshot(b, run.revision, run.active?.evidence?.id);
    run.capture(first.id, first.revision, first.evidenceId);
    run.prepare(m.id, failure.id);
    // The same core can prepare another account/state without invalidating sealed case evidence.
    run.mutated();
    await b.page.goto(p.url! + "?mode=error");
    await run.begin(m.id, failure.id, b.page);
    run.mutated();
    await b.page.getByRole("button").click();
    assert.equal((await run.verify(b.page)).status, "verified");
    run.capture(first.id, run.revision, first.evidenceId);
    assert.equal(
      run.active!.images.length,
      0,
      "another scenario's screenshot cannot be reused as current evidence",
    );
    const second = await screenshot(b, run.revision, run.active?.evidence?.id);
    run.capture(second.id, second.revision, second.evidenceId);
    run.assertDocument(m.id, [first.id]); // All evidence is archived; the guide selects key images.
    assert.throws(() => run.assertDocument(m.id, ["unrelated"]), /关键截图/);
    run.assertDocument(m.id, [first.id, second.id]);
    run.bindDocument(m.id, "doc-for-this-module");
    assert.throws(
      () =>
        run.assertPublish([{ moduleId: m.id, documentId: "another-document" }]),
      /未通过/,
    );
    run.assertPublish([{ moduleId: m.id, documentId: "doc-for-this-module" }]);
    assert.equal(run.report().verificationLevel, "ui-checks");
    await b.context.close();
  });

for (const mode of ["toast-only", "wrong-record"])
  test(`${mode}：成功提示或另一条记录不能满足任务契约`, async () => {
    const p = await createProject({
      name: mode,
      url: origin + "/helpdesk?mode=" + mode,
    });
    const connection = await connectBrowser(p, true);
    const b = getBrowser(connection.id, p.key);
    const plan = await example("helpdesk");
    plan.modules[0].scenarios = [plan.modules[0].scenarios[0]];
    const run = new QuickStartRun();
    run.setPlan(plan);
    await run.begin(
      plan.modules[0].id,
      plan.modules[0].scenarios[0].id,
      b.page,
    );
    run.mutated();
    await b.page.getByRole("button").click();
    assert.equal((await run.verify(b.page)).status, "active");
    assert.throws(() => run.assertDocument(plan.modules[0].id), /未完成场景/);
    await b.context.close();
  });

test("验证后继续操作会撤销证据；负向检查要求真实加载的范围；无法准备的场景可受阻", async () => {
  const p = await createProject({
    name: "freshness",
    url: origin + "/helpdesk",
  });
  const connection = await connectBrowser(p, true);
  const b = getBrowser(connection.id, p.key);
  const plan = await example("helpdesk");
  const m = plan.modules[0];
  const run = new QuickStartRun();
  run.setPlan(plan);
  await run.begin(m.id, m.scenarios[0].id, b.page);
  run.mutated();
  await b.page.getByRole("button").click();
  await run.verify(b.page);
  const image = await screenshot(b, run.revision, run.active?.evidence?.id);
  run.capture(image.id, image.revision, image.evidenceId);
  run.block(m.id, m.scenarios[1].id, "缺少空标题所需的测试状态");
  run.assertDocument(m.id, [image.id]);
  run.mutated();
  assert.throws(() => run.assertDocument(m.id, [image.id]), /未完成场景/);
  await run.verify(b.page);
  // Async UI changes can happen without a controlled browser action.
  await b.page.getByTestId("lumi-run-001").evaluate((el) => el.remove());
  await run.recheck(b.page);
  assert.equal(run.active!.status, "active");
  await b.page.setContent("<!doctype html><p>加载中</p>");
  const [result] = await verifyChecks(
    b.page,
    m.scenarios[1].preconditions.slice(1),
    0,
  );
  assert.equal(result.passed, false);
  const unsafe = structuredClone(plan);
  delete unsafe.modules[0].scenarios[0].preconditions[1].scope;
  assert.throws(() => new QuickStartRun().setPlan(unsafe), /scope/);
  await b.context.close();
});

test("画框使用截图冻结坐标、保留原图，拒绝跨浏览器、错误ref与越界坐标", async () => {
  const p = await createProject({
    name: "annotation",
    url: origin + "/helpdesk",
  });
  const connection = await connectBrowser(p, true);
  const b = getBrowser(connection.id, p.key);
  const image = await screenshot(b);
  const target = image.elements.find((e) => e.label === "提交工单")!;
  const original = await readFile(
    path.join(projectDir(p.key), "artifacts", image.id + ".png"),
  );
  await observe(b); // Old page refs expire, but a screenshot's own geometry is immutable.
  const annotated = await annotateImage(p.key, b.id, image.id, [
    { ref: target.ref, label: "提交入口" },
  ]);
  assert.equal(annotated.sourceId, image.id);
  const output = await readFile(
    path.join(projectDir(p.key), "artifacts", annotated.id + ".png"),
  );
  assert.notDeepEqual(original, output);
  assert.deepEqual(
    original,
    await readFile(
      path.join(projectDir(p.key), "artifacts", image.id + ".png"),
    ),
  );
  const pixels = await sharp(output)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < pixels.data.length; i += pixels.info.channels)
    if (
      pixels.data[i] > 190 &&
      pixels.data[i + 1] < 100 &&
      pixels.data[i + 2] < 100
    )
      red++;
  assert.ok(red > 500, "PNG should contain a visible red rectangle and badge");
  await assert.rejects(
    annotateImage(p.key, "another-browser", image.id, [{ ref: target.ref }]),
    /当前浏览器/,
  );
  await assert.rejects(
    annotateImage(p.key, b.id, image.id, [{ ref: "unknown" }]),
    /不属于这张截图/,
  );
  await assert.rejects(
    annotateImage(p.key, b.id, image.id, [
      { box: { x: -1, y: 0, width: 10, height: 10 } },
    ]),
    /超出截图/,
  );
  await b.context.close();
});
