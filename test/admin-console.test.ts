import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../src/config.js";
import { createProject } from "../src/store.js";
import {
  act,
  closeAllBrowsers,
  connectBrowser,
  getBrowser,
  navigateRef,
  observe,
  screenshot,
  type BrowserSession,
} from "../src/browser.js";
import {
  QuickStartRun,
  verifyChecks,
  type Check,
  type TaskPlan,
} from "../src/quick-start.js";
import { startAdminConsole } from "./fixtures/admin-console.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-admin-"));
config.data = tmp;
after(async () => {
  await closeAllBrowsers();
  await rm(tmp, { recursive: true, force: true });
});
type Observation = Awaited<ReturnType<typeof observe>>;
function ref(snapshot: Observation, label: string, role?: string) {
  const items = snapshot.elements.filter(
    (e) => e.label === label && (!role || e.role === role),
  );
  assert.equal(
    items.length,
    1,
    `expected unique ${role || "control"}: ${label}`,
  );
  return items[0].ref;
}
const adminExample: TaskPlan = JSON.parse(
  await readFile(
    new URL(
      "../skills/quick-start/examples/admin-procurement.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function adminPlan(): TaskPlan {
  return structuredClone(adminExample);
}
test("后台契约拒绝猜测未观察的控件类型，字段标签可跨原生控件验证", () => {
  const seen = new Set([JSON.stringify(["textbox", "采购单号"])]);
  new QuickStartRun().setPlan(adminPlan(), seen);
  const guessed = adminPlan();
  const choice = guessed.modules[0].scenarios[0].checkpoints![1].checks[1];
  choice.target = { role: "radio", name: "通过" };
  choice.assertion = "checked";
  delete choice.texts;
  assert.throws(
    () => new QuickStartRun().setPlan(guessed, seen),
    /不能猜测表单控件类型/,
  );
  const blocked = new QuickStartRun();
  blocked.setPlan(adminPlan());
  blocked.block("approval", "approve-one", "无法准备所需测试状态");
  assert.throws(
    () => blocked.guard("browser_act", { action: "click" }),
    /停止业务操作/,
  );
  blocked.guard("quick_start_status", {});
});
async function openList(b: BrowserSession) {
  let s = await observe(b);
  s = await act(b, { action: "expand", ref: ref(s, "业务管理") });
  s = await act(b, { action: "expand", ref: ref(s, "采购管理") });
  await navigateRef(b, ref(s, "采购单"));
  assert.ok(
    (
      await verifyChecks(b.page, [
        {
          id: "list",
          description: "列表加载完成",
          target: { text: "加载完成" },
          assertion: "visible",
        },
      ])
    ).every((c) => c.passed),
  );
  return observe(b);
}
async function search(b: BrowserSession, query: string) {
  let s = await observe(b);
  s = await act(b, {
    action: "fill",
    ref: ref(s, "采购单号", "textbox"),
    value: query,
  });
  await act(b, { action: "click", ref: ref(s, "查询") });
  await b.page.getByText("加载完成", { exact: true }).waitFor();
  return observe(b);
}
async function saveProof(run: QuickStartRun, b: BrowserSession) {
  await run.recheck(b.page);
  const image = await screenshot(b, run.revision, run.captureEvidenceId());
  run.capture(image.id, image.revision, image.evidenceId);
  return image.id;
}

test("复杂后台完整审批：三级菜单、分页/筛选、同行按钮、抽屉、联动表单、确认及刷新核验", async () => {
  const app = await startAdminConsole();
  try {
    const p = await createProject({ name: "采购后台", url: app.url });
    const connection = await connectBrowser(p, true);
    const b = getBrowser(connection.id, p.key);
    let s = await openList(b);
    const tableRef = s.tables.find((t) => t.label === "采购单列表")!.ref;
    let window = await observe(b, {
      ref: tableRef,
      table: { contains: "PO-012" },
    });
    assert.equal(
      window.table!.matched,
      0,
      "not on current page; cannot claim absent globally",
    );
    s = await observe(b);
    await act(b, { action: "click", ref: ref(s, "下一页") });
    s = await observe(b);
    await act(b, { action: "click", ref: ref(s, "下一页") });
    await b.page.getByRole("cell", { name: "PO-012", exact: true }).waitFor();
    s = await observe(b);
    window = await observe(b, {
      ref: s.tables[0].ref,
      table: { contains: "PO-012" },
    });
    assert.equal(window.table!.rows.length, 1);
    assert.ok(
      window.table!.rows[0].controls.some(
        (c) => c.label === "审批" && c.row?.text.includes("PO-012"),
      ),
    );
    await search(b, "PO-012");
    const run = new QuickStartRun();
    const plan = adminPlan();
    plan.modules[0].scenarios[0].outcomes.push({
      id: "audit",
      description: "另一个页面的同一单号日志",
      target: { role: "table", name: "审批日志" },
      assertion: "row_fields",
      rowKey: { column: "单号", value: "PO-012" },
      fields: [
        { column: "结果", value: "已通过" },
        { column: "意见", value: "验收通过" },
      ],
    });
    run.setPlan(plan);
    run.syncWriteEpoch(b.writeEpoch);
    await run.begin("approval", "approve-one", b.page);
    await assert.rejects(run.checkpoint(b.page, "form-ready"), /顺序/);
    assert.equal((await run.checkpoint(b.page, "located")).passed, true);
    assert.throws(() => run.mutated(), /先保存/);
    const first = await saveProof(run, b);
    s = await observe(b);
    window = await observe(b, {
      ref: s.tables[0].ref,
      table: { contains: "PO-012" },
    });
    run.mutated();
    s = await act(b, {
      action: "click",
      ref: window.table!.rows[0].controls.find((c) => c.label === "审批")!.ref,
    });
    assert.ok(
      (
        await verifyChecks(b.page, [
          {
            id: "drawer",
            description: "等待异步抽屉",
            target: { role: "dialog", name: "审批采购单 PO-012" },
            assertion: "visible",
          },
        ])
      ).every((c) => c.passed),
    );
    s = await observe(b);
    assert.equal(s.focus?.label, "审批采购单 PO-012");
    assert.equal(
      s.elements.find((e) => e.label === "申请单号")?.readOnly,
      true,
    );
    const scroll = s.regions.find((r) => r.label === "采购明细滚动区")!;
    s = await act(b, { action: "scroll", ref: scroll.ref, value: "600" });
    const lines = s.tables.find((t) => t.label === "采购明细")!;
    window = await observe(b, {
      ref: lines.ref,
      table: { contains: "LINE-031" },
    });
    assert.equal(window.table!.matched, 1);
    assert.equal(window.table!.renderedRows, 10);
    s = await observe(b);
    s = await act(b, { action: "click", ref: ref(s, "审批意见", "tab") });
    assert.ok(
      s.elements
        .find((e) => e.label === "审批结果")
        ?.options?.some((o) => o.value === "transfer"),
    );
    run.mutated();
    s = await act(b, {
      action: "select",
      ref: ref(s, "审批结果"),
      value: "transfer",
    });
    assert.ok(s.elements.some((e) => e.label === "复核员"));
    assert.equal(
      (
        await verifyChecks(
          b.page,
          [
            {
              id: "choice",
              description: "按可见选项标签核对",
              target: { label: "审批结果" },
              assertion: "selected_label_equals",
              texts: ["通过"],
            },
          ],
          0,
        )
      )[0].passed,
      false,
    );
    run.mutated();
    s = await act(b, {
      action: "select",
      ref: ref(s, "审批结果"),
      value: "approve",
    });
    assert.ok(!s.elements.some((e) => e.label === "复核员"));
    assert.equal(
      (
        await verifyChecks(
          b.page,
          [
            {
              id: "choice",
              description: "选中通过而非仅包含此选项",
              target: { label: "审批结果" },
              assertion: "selected_label_equals",
              texts: ["通过"],
            },
          ],
          0,
        )
      )[0].passed,
      true,
    );
    run.mutated();
    s = await act(b, {
      action: "fill",
      ref: ref(s, "审批意见", "textbox"),
      value: "验收通过",
    });
    await assert.rejects(run.verify(b.page), /中间检查点/);
    const filled = await run.checkpoint(b.page, "form-ready");
    assert.equal(filled.passed, true, JSON.stringify(filled.evidence.checks));
    const second = await saveProof(run, b);
    s = await observe(b);
    run.mutated();
    s = await act(b, { action: "click", ref: ref(s, "提交审批") });
    assert.equal(s.focus?.role, "alertdialog");
    run.mutated();
    await act(b, { action: "click", ref: ref(s, "确认提交") });
    await b.page.getByRole("cell", { name: "已通过", exact: true }).waitFor();
    run.mutated();
    await act(b, { action: "navigate", value: app.url });
    await openList(b);
    await search(b, "PO-012");
    run.syncWriteEpoch(b.writeEpoch);
    assert.equal(
      (await run.verify(b.page, ["approved", "query"])).status,
      "active",
    );
    assert.throws(() => run.mutated(true), /先保存当前已验证/);
    const final = await saveProof(run, b);
    s = await observe(b);
    run.mutated(true);
    await navigateRef(b, ref(s, "审批日志"));
    assert.ok(
      (
        await verifyChecks(b.page, [
          {
            id: "audit-page",
            description: "日志页加载",
            target: { role: "heading", name: "审批日志" },
            assertion: "visible",
          },
        ])
      ).every((c) => c.passed),
    );
    run.syncWriteEpoch(b.writeEpoch);
    assert.equal((await run.verify(b.page, ["audit"])).status, "verified");
    assert.throws(
      () => run.assertDocument("approval", [first, second, final]),
      /跨页面结果/,
    );
    const auditImage = await saveProof(run, b);
    run.assertDocument("approval", [final]); // Presentation may omit archived intermediate screenshots.
    run.assertDocument("approval", [first, second, final, auditImage]);
    run.captureDerived(
      "annotated-first",
      first,
      run.scenarios[0].checkpoints[0].evidence!.id,
    );
    run.assertDocument("approval", [
      "annotated-first",
      second,
      final,
      auditImage,
    ]);
    run.captureDerived(
      "invalid-derived",
      "not-a-captured-proof",
      run.scenarios[0].checkpoints[0].evidence!.id,
    );
    assert.throws(
      () => run.assertDocument("approval", ["invalid-derived", second, final]),
      /关键截图/,
    );
    assert.equal(app.events.length, 1);
    assert.equal(app.events[0].orderId, "PO-012");
    assert.equal(b.writeEpoch, 1, "浏览器只记录到一次同站写请求");
    assert.ok(
      app.orders
        .filter((o) => o.id !== "PO-012")
        .every((o) => o.status === "待审批"),
    );
    run.syncWriteEpoch(b.writeEpoch + 1);
    assert.equal(run.active!.status, "active", "新的写请求使跨页结果全部失效");
    await b.context.close();
  } finally {
    await app.close();
  }
});

test("后台错误、空态和权限：未填意见不提交；过滤空态保留范围；只读角色说明禁用原因", async () => {
  const app = await startAdminConsole();
  try {
    const p = await createProject({ name: "后台异常", url: app.url });
    let connection = await connectBrowser(p, true);
    let b = getBrowser(connection.id, p.key);
    await openList(b);
    let s = await search(b, "PO-012");
    let window = await observe(b, {
      ref: s.tables[0].ref,
      table: { contains: "PO-012" },
    });
    s = await act(b, {
      action: "click",
      ref: window.table!.rows[0].controls.find((c) => c.label === "审批")!.ref,
    });
    assert.ok(
      (
        await verifyChecks(b.page, [
          {
            id: "drawer",
            description: "等待异步抽屉",
            target: { role: "dialog", name: "审批采购单 PO-012" },
            assertion: "visible",
          },
        ])
      ).every((c) => c.passed),
    );
    s = await observe(b);
    s = await act(b, { action: "click", ref: ref(s, "审批意见", "tab") });
    s = await act(b, {
      action: "select",
      ref: ref(s, "审批结果"),
      value: "approve",
    });
    s = await act(b, { action: "click", ref: ref(s, "提交审批") });
    assert.ok(s.alerts.some((a) => a.text.includes("至少2字")));
    assert.equal(
      s.elements.find((e) => e.role === "textbox" && e.label === "审批意见")
        ?.invalid,
      true,
    );
    assert.equal(app.events.length, 0);
    assert.equal(app.orders.find((o) => o.id === "PO-012")!.status, "待审批");
    s = await act(b, { action: "click", ref: ref(s, "关闭抽屉") });
    s = await search(b, "不存在-000");
    assert.equal(s.tables[0].renderedRows, 0);
    assert.ok(
      (
        await verifyChecks(b.page, [
          {
            id: "empty",
            description: "限定筛选范围的空列表",
            scope: { role: "region", name: "采购单结果" },
            target: { css: "tbody tr" },
            assertion: "count",
            count: 0,
          },
          {
            id: "query",
            description: "空态属于当前查询",
            target: { role: "textbox", name: "采购单号" },
            assertion: "value_equals",
            texts: ["不存在-000"],
          },
        ])
      ).every((c) => c.passed),
    );
    await b.context.close();
    const viewer = await createProject({
      name: "只读后台",
      url: app.url + "?role=viewer",
    });
    connection = await connectBrowser(viewer, true);
    b = getBrowser(connection.id, viewer.key);
    await openList(b);
    s = await search(b, "PO-012");
    window = await observe(b, {
      ref: s.tables[0].ref,
      table: { contains: "PO-012" },
    });
    const approval = window.table!.rows[0].controls.find(
      (c) => c.label === "审批",
    )!;
    assert.equal(approval.disabled, true);
    assert.ok(approval.description?.includes("仅采购审核员"));
    assert.ok(
      (
        await verifyChecks(b.page, [
          {
            id: "disabled",
            description: "只读角色无法审批",
            target: { role: "button", name: "审批" },
            assertion: "disabled",
          },
        ])
      ).every((c) => c.passed),
    );
    await b.context.close();
  } finally {
    await app.close();
  }
});

test("大表格后的portal弹窗不会丢失，当前行窗口可定位深处同名操作", async () => {
  const app = await startAdminConsole();
  try {
    const p = await createProject({ name: "大页面", url: app.url });
    const connection = await connectBrowser(p, true);
    const b = getBrowser(connection.id, p.key);
    await b.page.setContent(
      '<table aria-label="密集订单"><thead><tr><th>编号</th><th>操作</th></tr></thead><tbody>' +
        Array.from(
          { length: 300 },
          (_, i) =>
            "<tr><td>BIG-" + i + "</td><td><button>编辑</button></td></tr>",
        ).join("") +
        '</tbody></table><section role="dialog" aria-label="编辑选中订单" style="position:fixed;inset:30px auto auto 30px;background:white"><label>订单备注<input required></label><button>保存选中订单</button></section>',
    );
    const s = await observe(b);
    assert.equal(s.focus?.label, "编辑选中订单");
    assert.ok(s.elements.some((e) => e.label === "保存选中订单"));
    const table = s.tables.find((t) => t.label === "密集订单")!;
    assert.equal(table.renderedRows, 300);
    const window = await observe(b, {
      ref: table.ref,
      table: { contains: "BIG-299" },
    });
    assert.equal(window.table!.rows.length, 1);
    assert.ok(
      window
        .table!.rows[0].controls.find((c) => c.label === "编辑")
        ?.row?.text.includes("BIG-299"),
    );
    await b.page.locator('[role="dialog"]').evaluate((el) => el.remove());
    await b.page.evaluate(() => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "当前行操作");
      menu.style.cssText = "position:fixed;top:30px;left:30px;background:white";
      menu.innerHTML = '<button role="menuitem">查看采购详情</button>';
      document.body.append(menu);
    });
    const menu = await observe(b);
    assert.equal(menu.focus?.role, "menu");
    assert.ok(menu.elements.some((e) => e.label === "查看采购详情"));
    await b.page.setContent(
      '<span>采购审核员</span><table aria-label="字段核验"><thead><tr><th>单号</th><th>状态</th></tr></thead><tbody><tr><td>X</td><td>未通过</td></tr><tr><td>Y</td><td>已通过</td></tr></tbody></table>',
    );
    const record: Check = {
      id: "record",
      description: "不能混用另一行或部分状态文字",
      target: { role: "table", name: "字段核验" },
      assertion: "row_fields",
      rowKey: { column: "单号", value: "X" },
      fields: [{ column: "状态", value: "已通过" }],
    };
    assert.equal((await verifyChecks(b.page, [record], 0))[0].passed, false);
    record.rowKey!.value = "Y";
    assert.equal((await verifyChecks(b.page, [record], 0))[0].passed, true);
    assert.equal(
      (
        await verifyChecks(
          b.page,
          [
            {
              id: "text",
              description: "generic节点按可见文字核对",
              target: { role: "generic", name: "采购审核员" },
              assertion: "visible",
            },
          ],
          0,
        )
      )[0].passed,
      true,
    );
    await b.context.close();
  } finally {
    await app.close();
  }
});
