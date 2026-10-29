import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../src/config.js";
import { createProject } from "../src/store.js";
import {
  connectBrowser,
  getBrowser,
  observe,
  act,
  navigateRef,
  closeAllBrowsers,
  capturePageImage,
} from "../src/browser.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-browser-"));
config.data = tmp;
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><nav aria-label="业务导航"><button aria-expanded="false" aria-controls="children" onclick="this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='false'?'true':'false');document.getElementById('children').hidden=this.getAttribute('aria-expanded')==='false'">账户管理</button><ul id="children" hidden><li><button>充值记录</button></li><li><button disabled>导出账单</button></li></ul></nav><details><summary>高级设置</summary><button>配置项</button></details><label>密码<input type="password" value="fixture-password"></label><button aria-haspopup="menu" aria-expanded="false" onmouseenter="this.setAttribute('aria-expanded','true');document.getElementById('menu').hidden=false">更多功能</button><div id="menu" role="menu" hidden><button role="menuitem">查看帮助</button></div>`,
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(async () => {
  await closeAllBrowsers();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});
test("浏览器快照包含真实层级和展开状态；密码遮挡，展开后子项及新ref可用", async () => {
  const p = await createProject({
    name: "层级测试",
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  });
  const connection = await connectBrowser(p, true);
  const b = getBrowser(connection.id, p.key);
  const first = await observe(b);
  assert.ok(!JSON.stringify(first).includes("fixture-password"));
  const account = first.elements.find((e) => e.label === "账户管理")!;
  assert.equal(account.expanded, false);
  assert.equal(account.expandable, true);
  assert.ok(account.path.some((p) => p.includes("业务导航")));
  assert.ok(!first.elements.some((e) => e.label === "充值记录"));
  await capturePageImage(b);
  const opened = await act(b, { action: "expand", ref: account.ref });
  assert.ok(opened.elements.some((e) => e.label === "充值记录"));
  assert.ok(opened.elements.find((e) => e.label === "导出账单")?.disabled);
  await assert.rejects(
    act(b, { action: "click", ref: account.ref }),
    /ref 已失效/,
  );
  const newAccount = opened.elements.find((e) => e.label === "账户管理")!;
  const part = await observe(b, { ref: newAccount.ref, depth: 3 });
  assert.equal(part.scope, "element");
  assert.ok(part.elements.some((e) => e.label === "账户管理"));
  const whole = await observe(b);
  const summary = whole.elements.find((e) => e.label === "高级设置")!;
  assert.equal(summary.expandable, true);
  const details = await act(b, { action: "expand", ref: summary.ref });
  assert.ok(details.elements.some((e) => e.label === "配置项"));
  const more = details.elements.find((e) => e.label === "更多功能")!;
  const hovered = await act(b, { action: "hover", ref: more.ref });
  assert.ok(hovered.elements.some((e) => e.label === "查看帮助"));
  const accountToClose = hovered.elements.find((e) => e.label === "账户管理")!;
  const collapsed = await act(b, {
    action: "collapse",
    ref: accountToClose.ref,
  });
  assert.equal(
    collapsed.elements.find((e) => e.label === "账户管理")?.expanded,
    false,
  );
  assert.ok(!collapsed.elements.some((e) => e.label === "充值记录"));
  await assert.rejects(
    navigateRef(b, collapsed.elements.find((e) => e.label === "高级设置")!.ref),
    /不是导航入口/,
  );
  const navigated = await navigateRef(
    b,
    collapsed.elements.find((e) => e.label === "账户管理")!.ref,
  );
  assert.ok(navigated.elements.some((e) => e.label === "充值记录"));
  await assert.rejects(
    act(b, { action: "navigate", value: "https://example.org" }),
    /仅允许在目标网站内导航/,
  );
});
