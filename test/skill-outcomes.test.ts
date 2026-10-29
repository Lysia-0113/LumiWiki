import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { createProject } from "../src/store.js";
import {
  closeAllBrowsers,
  connectBrowser,
  getBrowser,
  screenshot,
  type BrowserSession,
} from "../src/browser.js";
import { QuickStartRun, type TaskPlan } from "../src/quick-start.js";

// Run in a new node --test process. All persistence, HTTP and browser sessions
// belong to this fixture; no application server, model or existing browser is used.
const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-skill-outcomes-"));
config.data = tmp;
const server = http.createServer((req, res) => {
  const toastOnly = req.url === "/toast-only";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><main>
    <h1>工单</h1><label>标题<input aria-label="标题"></label>
    <button onclick="document.querySelector('[role=alert]').textContent='提交成功';
      ${toastOnly ? "" : "document.querySelector('[data-testid=records]').innerHTML='<article data-testid=guide-ticket>guide-ticket 网络故障 待处理</article>'"}">提交工单</button>
    <div role="alert"></div><section data-testid="records">暂无记录</section>
  </main>`);
});
after(async () => {
  await closeAllBrowsers();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

function preparationPlan(): TaskPlan {
  return {
    title: "工单上手指南",
    audience: "首次使用的工单提交人；当前仅授权查询与填写准备",
    modules: [
      {
        id: "ticket",
        title: "找到入口并填写工单",
        coverageReason:
          "只核验入口和填写准备，不凑四类场景；未实际提交，业务结果未验证",
        scenarios: [
          {
            id: "prepare-ticket",
            kind: "success",
            goal: "找到工单入口并填妥标题，不代表提交成功",
            setup: "本地夹具的空工单页面",
            cleanup: "未实际提交，不产生业务记录",
            preconditions: [
              {
                id: "entry",
                description: "工单入口可见",
                target: { role: "heading", name: "工单" },
                assertion: "visible",
              },
            ],
            outcomes: [
              {
                id: "title-ready",
                description: "标题已填写，业务提交未验证",
                target: { label: "标题" },
                assertion: "value_equals",
                texts: ["网络故障"],
              },
            ],
          },
        ],
      },
    ],
  };
}
function submissionPlan(): TaskPlan {
  const plan = preparationPlan();
  plan.audience = "本地测试账号；仅授权在独立夹具提交";
  const module = plan.modules[0];
  module.coverageReason = "核验一条核心成功路径，不需要额外场景";
  const scenario = module.scenarios[0];
  scenario.id = "submit-ticket";
  scenario.goal = "提交工单并查看同一记录的标题与状态";
  scenario.cleanup = "关闭并删除临时夹具，不操作业务系统";
  scenario.outcomes = [
    {
      id: "same-ticket",
      description: "同一工单的唯一标识、标题与状态正确",
      target: { testId: "guide-ticket" },
      assertion: "text_equals",
      texts: ["guide-ticket 网络故障 待处理"],
    },
  ];
  return plan;
}
async function openFixture(route = "/") {
  const project = await createProject({
    name: "skill-outcomes",
    url: origin + route,
  });
  const connection = await connectBrowser(project, true);
  return getBrowser(connection.id, project.key);
}
async function capture(run: QuickStartRun, browser: BrowserSession) {
  const image = await screenshot(
    browser,
    run.revision,
    run.captureEvidenceId(),
  );
  run.capture(image.id, image.revision, image.evidenceId);
  return image.id;
}

test("省略 profile 与显式 general 都可规划无机械检查点的一条核心路径", () => {
  for (const profile of [undefined, "general"] as const) {
    const plan = submissionPlan();
    if (profile) plan.profile = profile;
    const run = new QuickStartRun();
    const report = run.setPlan(plan);
    assert.equal(report.plan?.profile, "general");
    assert.equal(report.scenarios[0].checkpoints.length, 0);
    assert.equal(report.plan?.modules[0].scenarios.length, 1);
    assert.equal(plan.profile, profile, "宿主保存默认值，不改写调用者的计划");
  }
});

test("显式 admin 保留成功至少2个、其他分支至少1个检查点的门禁", () => {
  for (const kind of ["success", "empty", "error", "permission"] as const) {
    const plan = preparationPlan();
    plan.profile = "admin";
    const scenario = plan.modules[0].scenarios[0];
    scenario.kind = kind;
    assert.throws(() => new QuickStartRun().setPlan(plan), /admin深度验收/);
    scenario.checkpoints = [
      { id: "located", title: "确认入口", checks: scenario.preconditions },
    ];
    if (kind === "success") {
      assert.throws(() => new QuickStartRun().setPlan(plan), /至少需要2个/);
      scenario.checkpoints.push({
        id: "filled",
        title: "核对关键字段",
        checks: scenario.outcomes,
      });
    }
    assert.equal(new QuickStartRun().setPlan(plan).plan?.profile, "admin");
  }
});

test("默认 general 可安全核验填写准备，阻止未提交结果冒充完成并尽早保存模块", async () => {
  const browser = await openFixture();
  try {
    const plan = preparationPlan();
    const submission = submissionPlan().modules[0].scenarios[0];
    plan.modules[0].scenarios.push(submission);
    plan.modules.push({ ...preparationPlan().modules[0], id: "next-task" });
    const run = new QuickStartRun();
    run.setPlan(plan);
    await run.begin("ticket", "prepare-ticket", browser.page);
    run.mutated();
    await browser.page.getByLabel("标题", { exact: true }).fill("网络故障");
    assert.equal((await run.verify(browser.page)).status, "verified");
    const imageId = await capture(run, browser);
    run.prepare("ticket", "submit-ticket");
    await run.begin("ticket", "submit-ticket", browser.page);
    assert.equal((await run.verify(browser.page)).status, "active");
    assert.throws(() => run.assertDocument("ticket", [imageId]), /未完成场景/);
    run.block(
      "ticket",
      "submit-ticket",
      "未获提交授权；未实际提交，业务结果未验证",
    );
    assert.equal(await browser.page.getByTestId("guide-ticket").count(), 0);
    assert.equal(await browser.page.getByRole("alert").innerText(), "");
    assert.equal(run.scenarios[0].status, "verified");
    assert.equal(run.scenarios[1].status, "blocked");
    assert.match(run.scenarios[1].reason!, /业务结果未验证/);
    assert.deepEqual(
      run.readyModules().map((m) => m.moduleId),
      ["ticket"],
    );
    assert.throws(
      () => run.guard("browser_navigate", { ref: "next" }),
      /先用 document_write 保存/,
    );
    run.assertDocument("ticket", [imageId]);
    run.bindDocument("ticket", "usable-preparation-guide");
    assert.equal(run.documents.get("ticket"), "usable-preparation-guide");
    assert.equal(run.scenarios[2].status, "pending", "不等后续模块完成才保存");
    assert.deepEqual(run.readyModules(), []);
    run.guard("browser_navigate", { ref: "next" });
  } finally {
    await browser.context.close();
  }
});

for (const toastOnly of [false, true])
  test(`默认 general 的实际结果与截图门禁不因省略检查点放宽（toastOnly=${toastOnly}）`, async () => {
    const browser = await openFixture(toastOnly ? "/toast-only" : "/");
    try {
      const run = new QuickStartRun();
      run.setPlan(submissionPlan());
      await run.begin("ticket", "submit-ticket", browser.page);
      run.mutated();
      await browser.page.getByRole("button", { name: "提交工单" }).click();
      assert.equal(
        await browser.page.getByRole("alert").innerText(),
        "提交成功",
      );
      const result = await run.verify(browser.page);
      if (toastOnly) {
        assert.equal(result.status, "active");
        assert.equal(result.evidence, undefined);
        assert.throws(() => run.assertDocument("ticket"), /未完成场景/);
      } else {
        assert.equal(result.status, "verified");
        assert.throws(() => run.assertDocument("ticket"), /归档验证后截图/);
        run.capture("forged-image", run.revision, "another-evidence");
        assert.deepEqual(run.active!.images, []);
        const imageId = await capture(run, browser);
        assert.throws(
          () => run.assertDocument("ticket", ["unrelated-image"]),
          /关键截图/,
        );
        run.assertDocument("ticket", [imageId]);
        run.bindDocument("ticket", "usable-ticket-guide");
        run.assertPublish([
          { moduleId: "ticket", documentId: "usable-ticket-guide" },
        ]);
        assert.equal(run.report().verificationLevel, "ui-checks");
      }
    } finally {
      await browser.context.close();
    }
  });

test("general 仍强制执行已规划的关键检查点和截图", async () => {
  const browser = await openFixture();
  try {
    const plan = preparationPlan();
    const scenario = plan.modules[0].scenarios[0];
    scenario.checkpoints = [
      { id: "located", title: "确认入口", checks: scenario.preconditions },
    ];
    const run = new QuickStartRun();
    run.setPlan(plan);
    await run.begin("ticket", "prepare-ticket", browser.page);
    await assert.rejects(run.verify(browser.page), /中间检查点未完成/);
    assert.equal((await run.checkpoint(browser.page, "located")).passed, true);
    assert.throws(() => run.mutated(), /先保存当前检查点截图/);
    await capture(run, browser);
    run.mutated();
    await browser.page.getByLabel("标题", { exact: true }).fill("网络故障");
    assert.equal((await run.verify(browser.page)).status, "verified");
    const imageId = await capture(run, browser);
    run.assertDocument("ticket", [imageId]);
  } finally {
    await browser.context.close();
  }
});

test("general 不移除负向范围与防猜控件门禁", () => {
  const missingScope = preparationPlan();
  missingScope.modules[0].scenarios[0].outcomes = [
    {
      id: "missing",
      description: "记录不存在",
      target: { testId: "guide-ticket" },
      assertion: "count",
      count: 0,
    },
  ];
  assert.throws(() => new QuickStartRun().setPlan(missingScope), /scope/);
  const guessed = preparationPlan();
  guessed.modules[0].scenarios[0].outcomes[0].target = {
    role: "textbox",
    name: "未观察字段",
  };
  assert.throws(
    () => new QuickStartRun().setPlan(guessed, new Set()),
    /不能猜测表单控件类型/,
  );
});

test("Skill、按需参考与设计文档的交付、未验证表述及默认值和宿主一致", async () => {
  const files = [
    "skills/quick-start/SKILL.md",
    "skills/quick-start/references/workflow.md",
    "skills/quick-start/references/admin.md",
    "docs/quick-start-design.md",
    "docs/complex-admin-principles.md",
  ];
  const texts = await Promise.all(
    files.map((file) =>
      readFile(new URL(`../${file}`, import.meta.url), "utf8"),
    ),
  );
  const hostDefault = new QuickStartRun().setPlan(preparationPlan()).plan!
    .profile;
  for (const [index, text] of texts.entries()) {
    assert.ok(text.includes(`profile=${hostDefault}`), files[index]);
    assert.match(text, /未实际提交，业务结果未验证/, files[index]);
    assert.match(text, /图文指南|图文模块|图文说明/, files[index]);
    assert.match(text, /按需/, files[index]);
    assert.doesNotMatch(
      text,
      /默认(?:使用\s*)?\s*`?profile=admin|后台默认 profile=admin/,
      files[index],
    );
  }
  const skill = texts[0];
  assert.match(skill, /唯一主要交付/);
  assert.match(skill, /受众[\s\S]*3至5个用户目标[\s\S]*最小必要页面证据/);
  assert.match(skill, /工具次数、检查点数量[\s\S]*不是指南质量标准/);
  assert.match(skill, /可不设中间 checkpoints/);
  assert.match(skill, /profile=admin[\s\S]*严格检查/);
  assert.match(skill, /立即[\s\S]*保存完整可用模块/);
  assert.match(skill, /不能提交 `passed:true`/);
  assert.match(skill, /不为生成指南冒险修改业务数据/);
  assert.match(skill, /不重复创建或提交/);
  assert.match(skill, /提交成功提示不能证明业务结果/);
  assert.match(skill, /宿主 QA 准入策略决定/);
  assert.doesNotMatch(
    skill,
    /先用 `quick_start_reference|后台任务再读 `admin`|经人工审核才|人工确认 verified 后才/,
  );
  assert.ok(
    skill.split("\n").length < 45,
    "入口保持简短，执行参数留给 references",
  );
});
