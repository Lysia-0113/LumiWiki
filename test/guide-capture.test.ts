import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { createProject, projectDir } from "../src/store.js";
import {
  closeAllBrowsers,
  connectBrowser,
  getBrowser,
  observe,
  type BrowserSession,
} from "../src/browser.js";
import { annotateImage, type ScreenshotArtifact } from "../src/artifacts.js";
import {
  QuickStartRun,
  type Check,
  type TaskPlan,
} from "../src/quick-start.js";
import { captureCheckpoint, captureOutcome } from "../src/guide-capture.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-guide-capture-"));
config.data = tmp;
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  if (req.method === "POST") {
    res.writeHead(204).end();
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/flow") {
    res.end(`<!doctype html><main><p data-testid="stage">ready</p>
      <button onclick="document.querySelector('[data-testid=stage]').textContent='filled'">填写</button>
      <button onclick="document.querySelector('[data-testid=stage]').textContent='done'">保存</button></main>`);
    return;
  }
  if (url.pathname === "/groups") {
    const view = url.searchParams.get("view") || "first";
    res.end(`<!doctype html><main><p data-testid="${view}">${view} result</p>
      <nav><a href="/groups?view=second">下一页</a></nav></main>`);
    return;
  }
  const desk = url.pathname === "/helpdesk";
  const mode = url.searchParams.get("mode");
  const error = mode === "error";
  const message = desk ? "请输入标题" : "余额不足";
  const record = desk
    ? "网络故障 lumi-run-001 待处理"
    : "场地A 2030-01-01 已预约";
  res.end(`<!doctype html><main><div data-testid="balance">${error ? 0 : 100}</div>
    <button style="width:180px;height:50px" onclick="document.querySelector('[role=alert]').textContent='${error ? message : "提交成功"}';${error || mode === "toast-only" ? "" : `document.querySelector('[data-testid=records]').innerHTML='<article data-testid=${mode === "wrong-record" ? "another-run" : "lumi-run-001"}>${record}</article>'`}">${desk ? "提交工单" : "预约"}</button>
    <div role="alert" aria-label="${error ? message : "提交结果"}"></div>
    <section data-testid="records"><span>暂无记录</span></section></main>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(async () => {
  await closeAllBrowsers();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

async function browserFor(t: TestContext, route: string) {
  const project = await createProject({ name: t.name, url: origin + route });
  const connection = await connectBrowser(project, true);
  const browser = getBrowser(connection.id, project.key);
  t.after(() => browser.context.close());
  return browser;
}

const stageCheck = (id: string, text: string): Check => ({
  id,
  description: `状态为${text}`,
  target: { testId: "stage" },
  assertion: "text_equals",
  texts: [text],
});
function flowPlan(admin = false): TaskPlan {
  return {
    title: "本地流程",
    audience: "测试用户",
    profile: admin ? "admin" : "general",
    modules: [
      {
        id: "flow",
        title: "填写并保存",
        coverageReason: "核验和截图归档",
        scenarios: [
          {
            id: "success",
            kind: "success",
            goal: "保存后显示完成",
            setup: "打开本地流程",
            cleanup: "关闭临时浏览器",
            preconditions: [stageCheck("ready", "ready")],
            outcomes: [stageCheck("done", "done")],
            ...(admin
              ? {
                  checkpoints: [
                    {
                      id: "located",
                      title: "找到入口",
                      checks: [stageCheck("ready", "ready")],
                    },
                    {
                      id: "filled",
                      title: "表单已填写",
                      checks: [stageCheck("filled", "filled")],
                    },
                  ],
                }
              : {}),
          },
        ],
      },
    ],
  };
}
async function start(browser: BrowserSession, plan = flowPlan()) {
  const run = new QuickStartRun();
  run.reset();
  run.setPlan(plan);
  const module = plan.modules[0];
  await run.begin(module.id, module.scenarios[0].id, browser.page);
  return run;
}
async function completeFlow(browser: BrowserSession, run: QuickStartRun) {
  run.mutated();
  await browser.page.getByRole("button", { name: "保存" }).click();
}
async function artifactFiles(browser: BrowserSession) {
  return readdir(path.join(projectDir(browser.projectId), "artifacts")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
}
async function assertArchived(
  browser: BrowserSession,
  image: ScreenshotArtifact,
) {
  const dir = path.join(projectDir(browser.projectId), "artifacts");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, image.id + ".json"), "utf8")),
    image,
  );
  const png = await readFile(path.join(dir, image.id + ".png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
}

test("general结果核验成功自动归档，截图原始ref和坐标冻结", async (t) => {
  const browser = await browserFor(t, "/flow");
  const run = await start(browser);
  await completeFlow(browser, run);
  const result = await captureOutcome(browser, run);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.availableOutcomeIds, ["done"]);
  assert.deepEqual(result.remainingOutcomeIds, []);
  const image = result.screenshot!;
  assert.ok(image);
  assert.equal(image.evidenceId, result.evidence!.id);
  assert.equal(image.revision, run.revision);
  assert.equal(image.browserId, browser.id);
  assert.deepEqual(run.active!.outcomes[0].images, [image.id]);
  run.assertDocument("flow", [image.id]);
  await assertArchived(browser, image);

  const frozen = structuredClone(image.elements);
  const button = frozen.find((element) => element.label === "保存")!;
  assert.ok(button);
  await observe(browser);
  assert.equal(browser.refs.has(button.ref), false, "旧页面ref失效");
  const annotated = await annotateImage(
    browser.projectId,
    browser.id,
    image.id,
    [{ ref: button.ref, label: "保存入口" }],
  );
  assert.equal(annotated.sourceId, image.id);
  assert.deepEqual(annotated.legend[0].box, button.box);
  assert.deepEqual(image.elements, frozen);
  await assertArchived(browser, image);
});

test("admin检查点自动截图后允许下一操作，保留顺序与完整性门禁", async (t) => {
  const browser = await browserFor(t, "/flow");
  const run = await start(browser, flowPlan(true));
  await assert.rejects(captureCheckpoint(browser, run, "filled"), /顺序/);
  await assert.rejects(captureOutcome(browser, run), /检查点/);
  const raw = await run.checkpoint(browser.page, "located");
  assert.equal(raw.passed, true);
  assert.throws(() => run.mutated(), /检查点截图/);
  assert.deepEqual(await artifactFiles(browser), []);

  const first = await captureCheckpoint(browser, run, "located");
  assert.equal(first.passed, true);
  assert.equal(first.checkpointId, "located");
  assert.deepEqual(run.active!.checkpoints[0].images, [first.screenshot!.id]);
  run.mutated();
  await browser.page.getByRole("button", { name: "填写" }).click();
  const second = await captureCheckpoint(browser, run, "filled");
  assert.equal(second.passed, true);
  assert.deepEqual(run.active!.checkpoints[1].images, [second.screenshot!.id]);
  await assert.rejects(captureCheckpoint(browser, run, "located"), /历史证据/);
  await completeFlow(browser, run);
  const result = await captureOutcome(browser, run);
  assert.equal(result.status, "verified");
  run.assertDocument("flow", [
    first.screenshot!.id,
    second.screenshot!.id,
    result.screenshot!.id,
  ]);
  for (const image of [
    first.screenshot!,
    second.screenshot!,
    result.screenshot!,
  ])
    await assertArchived(browser, image);
  const unsafe = flowPlan(true);
  unsafe.modules[0].scenarios[0].checkpoints = [];
  assert.throws(() => new QuickStartRun().setPlan(unsafe), /至少需要2个/);
});

test("结果与检查点核验失败均不截图、不解除证据门禁", async (t) => {
  const browser = await browserFor(t, "/flow");
  const run = await start(browser);
  const result = await captureOutcome(browser, run);
  assert.equal(result.status, "active");
  assert.equal(result.screenshot, undefined);
  assert.equal(result.evidence, undefined);
  assert.equal(result.checks[0].passed, false);
  assert.deepEqual(run.active!.images, []);
  assert.throws(() => run.assertDocument("flow"), /未完成场景/);

  const admin = await start(browser, flowPlan(true));
  await captureCheckpoint(browser, admin, "located");
  const before = await artifactFiles(browser);
  const failed = await captureCheckpoint(browser, admin, "filled");
  assert.equal(failed.passed, false);
  assert.equal(failed.screenshot, undefined);
  assert.deepEqual(admin.active!.checkpoints[1].images, []);
  assert.deepEqual(await artifactFiles(browser), before);
  await assert.rejects(captureOutcome(browser, admin), /检查点/);
});

test("跨页结果分组各自产生归档图，导航保留已验证组但写请求撤销全部结果", async (t) => {
  const browser = await browserFor(t, "/groups");
  const visible = (id: string): Check => ({
    id,
    description: id,
    target: { testId: id },
    assertion: "visible",
  });
  const plan = flowPlan();
  plan.modules[0].scenarios[0].preconditions = [visible("first")];
  plan.modules[0].scenarios[0].outcomes = [visible("first"), visible("second")];
  const run = await start(browser, plan);
  const first = await captureOutcome(browser, run, ["first"]);
  assert.equal(first.status, "active");
  assert.deepEqual(first.remainingOutcomeIds, ["second"]);
  assert.ok(first.screenshot);
  run.mutated(true);
  await browser.page.getByRole("link", { name: "下一页" }).click();
  const second = await captureOutcome(browser, run, ["second"]);
  assert.equal(second.status, "verified");
  assert.deepEqual(second.remainingOutcomeIds, []);
  assert.ok(second.screenshot);
  assert.notEqual(first.screenshot.id, second.screenshot.id);
  assert.notEqual(first.evidence!.id, second.evidence!.id);
  assert.notEqual(first.screenshot.pageUrl, second.screenshot.pageUrl);
  assert.deepEqual(run.active!.images, [
    first.screenshot.id,
    second.screenshot.id,
  ]);
  run.assertDocument("flow", [first.screenshot.id, second.screenshot.id]);
  await assertArchived(browser, first.screenshot);
  await assertArchived(browser, second.screenshot);
  await browser.page.evaluate(async () => {
    await fetch("/write", { method: "POST" });
  });
  run.syncWriteEpoch(browser.writeEpoch);
  assert.equal(browser.writeEpoch, 1);
  assert.equal(run.active!.status, "active");
  assert.deepEqual(run.active!.outcomes, []);
  assert.throws(
    () => run.assertDocument("flow", [first.screenshot!.id]),
    /未完成场景/,
  );
});

for (const domain of ["gymbook", "helpdesk"]) {
  test(`${domain}原样例成功和错误场景使用组合核验，无需独立截图`, async (t) => {
    const browser = await browserFor(t, "/" + domain);
    const plan: TaskPlan = JSON.parse(
      await readFile(
        new URL(
          `../skills/quick-start/examples/${domain}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    plan.modules = [plan.modules[0]];
    const module = plan.modules[0];
    const run = await start(browser, plan);
    run.mutated();
    await browser.page.getByRole("button").click();
    const first = await captureOutcome(browser, run);
    assert.equal(first.status, "verified");
    assert.ok(first.screenshot);
    run.prepare(module.id, module.scenarios[1].id);
    run.mutated();
    await browser.page.goto(origin + "/" + domain + "?mode=error");
    await run.begin(module.id, module.scenarios[1].id, browser.page);
    run.mutated();
    await browser.page.getByRole("button").click();
    const second = await captureOutcome(browser, run);
    assert.equal(second.status, "verified");
    assert.ok(second.screenshot);
    run.capture(first.screenshot.id, run.revision, first.screenshot.evidenceId);
    assert.deepEqual(
      run.active!.images,
      [second.screenshot.id],
      "不能用另一场景的图片冒充当前结果",
    );
    run.assertDocument(module.id, [first.screenshot.id, second.screenshot.id]);
    assert.throws(
      () => run.assertDocument(module.id, ["unrelated"]),
      /关键截图/,
    );
  });
}

for (const mode of ["toast-only", "wrong-record"]) {
  test(`${mode}仍不能满足原样例，不会产生截图`, async (t) => {
    const browser = await browserFor(t, "/helpdesk?mode=" + mode);
    const plan: TaskPlan = JSON.parse(
      await readFile(
        new URL(
          "../skills/quick-start/examples/helpdesk.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    plan.modules[0].scenarios = [plan.modules[0].scenarios[0]];
    const run = await start(browser, plan);
    run.mutated();
    await browser.page.getByRole("button").click();
    const result = await captureOutcome(browser, run);
    assert.equal(result.status, "active");
    assert.equal(result.screenshot, undefined);
    assert.deepEqual(await artifactFiles(browser), []);
    assert.throws(() => run.assertDocument(plan.modules[0].id), /未完成场景/);
  });
}

test("核验完成后、截图之前的异步UI变化由recheck拒绝，不产生截图", async (t) => {
  const browser = await browserFor(t, "/flow");
  const run = await start(browser);
  await completeFlow(browser, run);
  const verify = run.verify.bind(run);
  run.verify = async (...args) => {
    const result = await verify(...args);
    await browser.page.getByTestId("stage").evaluate((el) => {
      el.textContent = "changed";
    });
    return result;
  };
  await assert.rejects(captureOutcome(browser, run), /证据已变化/);
  assert.deepEqual(await artifactFiles(browser), []);
  assert.equal(run.active!.status, "active");
  assert.deepEqual(run.active!.images, []);
});

for (const admin of [false, true]) {
  test(`${admin ? "检查点" : "结果"}核验期间发生真实同站写请求时拒绝截图归档`, async (t) => {
    const browser = await browserFor(t, "/flow");
    const run = await start(browser, flowPlan(admin));
    const write = async () => {
      await browser.page.evaluate(async () => {
        await fetch("/write", { method: "POST" });
      });
    };
    if (admin) {
      const checkpoint = run.checkpoint.bind(run);
      run.checkpoint = async (...args) => {
        const result = await checkpoint(...args);
        await write();
        return result;
      };
      await assert.rejects(
        captureCheckpoint(browser, run, "located"),
        /证据已变化/,
      );
      assert.deepEqual(run.active!.checkpoints[0].images, []);
      assert.throws(() => run.mutated(), /检查点截图/);
    } else {
      await completeFlow(browser, run);
      const verify = run.verify.bind(run);
      run.verify = async (...args) => {
        const result = await verify(...args);
        await write();
        return result;
      };
      await assert.rejects(captureOutcome(browser, run), /证据已变化/);
      assert.equal(run.active!.status, "active");
      assert.deepEqual(run.active!.outcomes, []);
    }
    assert.equal(browser.writeEpoch, 1);
    assert.deepEqual(await artifactFiles(browser), []);
  });
}

for (const change of ["write", "ui"]) {
  test(`截图期间${change}变化不能归档过期图或返回伪成功`, async (t) => {
    const browser = await browserFor(t, "/flow");
    const run = await start(browser);
    await completeFlow(browser, run);
    const screenshot = browser.page.screenshot.bind(browser.page);
    browser.page.screenshot = async (options) => {
      const png = await screenshot(options);
      if (change === "write") {
        await browser.page.evaluate(async () => {
          await fetch("/write", { method: "POST" });
        });
      } else {
        await browser.page.getByTestId("stage").evaluate((el) => {
          el.textContent = "changed";
        });
      }
      return png;
    };
    await assert.rejects(captureOutcome(browser, run), /证据已变化/);
    assert.equal(run.active!.status, "active");
    assert.deepEqual(run.active!.images, []);
    assert.deepEqual(run.active!.outcomes, []);
    assert.throws(() => run.assertDocument("flow"), /未完成场景/);
  });
}
