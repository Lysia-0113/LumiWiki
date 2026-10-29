import { chromium, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ensure } from "./config.js";
import { atomic, projectDir, type Project } from "./store.js";
import type { ScreenshotArtifact } from "./artifacts.js";
import {
  allNodes,
  nodeText,
  rowCells,
  sanitizeSnapshot,
  selectTableWindow,
  snapshotOutline,
  windowTables,
  type SnapshotNode,
  type TableWindow,
} from "./browser-structure.js";

export interface BrowserSession {
  id: string;
  projectId: string;
  context: BrowserContext;
  page: Page;
  origin: string;
  observed: Set<string>;
  refs: Set<string>;
  seenControls: Set<string>;
  writeEpoch: number;
  busy: boolean;
}
const sessions = new Map<string, BrowserSession>();
export async function connectBrowser(
  project: Project,
  headless = process.env.BROWSER_HEADLESS === "true",
) {
  ensure(sessions.size < 10, "浏览器会话已满，请关闭已有会话", 429);
  ensure(project.url, "请先为项目配置目标网址");
  const browser = await chromium.launch({ channel: "chrome", headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    acceptDownloads: false,
  });
  const origin = new URL(project.url).origin;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).origin !== origin
    )
      return route.abort("blockedbyclient");
    return route.continue();
  });
  const page = await context.newPage();
  const id = randomUUID();
  const s: BrowserSession = {
    id,
    projectId: project.key,
    context,
    page,
    origin,
    observed: new Set(),
    refs: new Set(),
    seenControls: new Set(),
    writeEpoch: 0,
    busy: false,
  };
  page.on("popup", async (popup) => {
    await popup.close();
  });
  context.on("request", (request) => {
    if (
      new URL(request.url()).origin === origin &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      s.writeEpoch++;
  });
  context.on("close", () => {
    sessions.delete(id);
    void browser.close();
  });
  try {
    await page.goto(project.url, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    sessions.set(id, s);
    return { id, url: page.url() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
export function getBrowser(id: string, projectId: string) {
  const s = sessions.get(id);
  ensure(
    s && s.projectId === projectId && !s.page.isClosed(),
    "浏览器会话不存在或已关闭",
    410,
  );
  return s;
}
export async function closeBrowser(id: string, projectId: string) {
  await getBrowser(id, projectId).context.close();
}
export function resolveRef(s: BrowserSession, ref: string) {
  ensure(s.refs.has(ref), "控件 ref 已失效，请重新观察");
  return s.page.getByRef(ref.slice(ref.indexOf(":") + 1));
}
export async function observe(
  s: BrowserSession,
  scope?: { ref: string; depth?: number; table?: TableWindow },
) {
  const target = scope ? resolveRef(s, scope.ref) : s.page.locator("body");
  const raw = (await target.ariaSnapshotJSON({
    mode: "ai",
    boxes: true,
    depth: scope?.depth || 14,
    timeout: 10000,
  })) as Array<SnapshotNode | string>;
  // 原生 aria 快照包含密码输入值：在任何模型输出之前统一遮挡。
  const privateValues = await s.page
    .locator('input[type="password"], [data-private]')
    .evaluateAll((elements) =>
      elements
        .flatMap((el) => {
          const input = el as HTMLInputElement;
          return [
            input.value || "",
            el.hasAttribute("data-private")
              ? (el.textContent || "").trim()
              : "",
          ];
        })
        .filter(Boolean),
    );
  const redact = (value: string) =>
    privateValues.reduce(
      (text, secret) => text.split(secret).join("[已遮挡]"),
      value,
    );
  const safe = sanitizeSnapshot(raw, redact);
  for (const node of allNodes(safe))
    if (node.role && node.name)
      s.seenControls.add(JSON.stringify([node.role, node.name]));
  const outline = snapshotOutline(safe);
  const table = scope?.table
    ? allNodes(safe).find((n) =>
        ["table", "grid", "treegrid"].includes(n.role || ""),
      )
    : undefined;
  if (scope?.table)
    ensure(table, "该ref不是表格，请从tables或regions选择表格ref");
  const tableWindow = table
    ? selectTableWindow(table, scope?.table)
    : undefined;
  let focus = !scope ? outline.focus : undefined;
  if (!scope) {
    const nodes = allNodes(safe);
    for (const menu of nodes
      .filter((n) => n.role === "menu" && n.ref)
      .slice(-8)) {
      const popup = await s.page
        .getByRef(menu.ref!)
        .evaluate((el) => {
          if (el.closest('nav, aside, [role="navigation"], [role="menubar"]'))
            return false;
          let current: Element | null = el;
          while (current && current !== el.ownerDocument.body) {
            if (
              ["absolute", "fixed"].includes(getComputedStyle(current).position)
            )
              return true;
            current = current.parentElement;
          }
          return false;
        })
        .catch(() => false);
      if (popup && (!focus || nodes.indexOf(menu) > nodes.indexOf(focus)))
        focus = menu;
    }
  }
  const focused = focus ? [focus] : safe;
  const selected = windowTables(focused, scope?.table);
  let count = 0;
  let truncated = false;
  const pending: Array<{
    node: SnapshotNode;
    path: string[];
    nativeRef: string;
    row?: { ref: string; text: string };
  }> = [];
  function copy(
    nodes: Array<SnapshotNode | string>,
    ancestry: string[],
    row?: { ref: string; text: string },
  ): Array<SnapshotNode | string> {
    return nodes.flatMap<SnapshotNode | string>((item) => {
      if (++count > (scope?.table ? 5000 : 500)) {
        truncated = true;
        return [];
      }
      if (typeof item === "string") return [redact(item).slice(0, 1000)];
      const node: SnapshotNode = { ...item };
      for (const key of ["name", "text", "placeholder", "value", "url"])
        if (typeof node[key] === "string")
          node[key] = redact(node[key] as string).slice(0, 2000);
      if (node.role === "row" && node.ref)
        row = { ref: node.ref, text: nodeText(node).slice(0, 300) };
      const label = [
        node.role,
        node.name || (node.role === "row" ? row?.text : ""),
      ]
        .filter(Boolean)
        .join(": ");
      const context = label ? [...ancestry, label] : ancestry;
      if (node.ref)
        pending.push({ node, path: ancestry, nativeRef: node.ref, row });
      if (node.children) node.children = copy(node.children, context, row);
      return [node];
    });
  }
  const tree = copy(selected, []);
  const generation = randomUUID().slice(0, 8);
  const roles = new Set([
    "button",
    "textbox",
    "searchbox",
    "link",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "treeitem",
    "tab",
    "slider",
    "spinbutton",
    "table",
    "grid",
    "treegrid",
    "dialog",
    "alertdialog",
    "region",
    "navigation",
    "tablist",
    "row",
    "heading",
  ]);
  const candidates = pending.filter(
    (p) =>
      roles.has(p.node.role || "") ||
      p.node.cursor === "pointer" ||
      p.node.expanded !== undefined ||
      (p.node.role === "generic" && p.node.name),
  );
  const elements = await Promise.all(
    candidates.slice(0, 200).map(async (entry) => {
      const meta = await s.page
        .getByRef(entry.nativeRef)
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          const summary = el.tagName === "SUMMARY";
          const expanded = el.getAttribute("aria-expanded");
          const popup = el.getAttribute("aria-haspopup");
          const details = summary
            ? (el.parentElement as HTMLDetailsElement)
            : null;
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            type: input.type || "",
            disabled:
              Boolean(input.disabled) ||
              el.getAttribute("aria-disabled") === "true",
            expanded:
              expanded === null
                ? details
                  ? details.open
                  : undefined
                : expanded === "true",
            expandable:
              expanded !== null ||
              summary ||
              Boolean(popup && popup !== "false"),
            hasPopup: popup || undefined,
            controls: el.getAttribute("aria-controls") || undefined,
            required:
              Boolean(input.required) ||
              el.getAttribute("aria-required") === "true",
            readOnly: Boolean(input.readOnly),
            invalid:
              el.getAttribute("aria-invalid") === "true" ||
              ("validity" in input && !input.validity.valid),
            description: (el.getAttribute("aria-describedby") || "")
              .split(/\s+/)
              .map(
                (id) => el.ownerDocument.getElementById(id)?.textContent || "",
              )
              .join(" ")
              .trim()
              .slice(0, 500),
            placeholder: input.placeholder || undefined,
            options:
              el.tagName === "SELECT"
                ? Array.from((el as HTMLSelectElement).options)
                    .slice(0, 50)
                    .map((option) => ({
                      label: option.label,
                      value: option.value,
                      selected: option.selected,
                      disabled: option.disabled,
                    }))
                : undefined,
            inViewport:
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth,
            scroll: {
              top: el.scrollTop,
              left: el.scrollLeft,
              maxY: Math.max(0, el.scrollHeight - el.clientHeight),
              maxX: Math.max(0, el.scrollWidth - el.clientWidth),
            },
          };
        })
        .catch(() => ({
          tag: "unknown",
          type: "",
          disabled: true,
          expanded: undefined,
          expandable: false,
          hasPopup: undefined,
          controls: undefined,
          required: undefined,
          readOnly: undefined,
          invalid: undefined,
          description: "",
          placeholder: undefined,
          options: undefined,
          inViewport: false,
          scroll: { top: 0, left: 0, maxY: 0, maxX: 0 },
        }));
      Object.assign(entry.node, {
        expandable: meta.expandable,
        ...(meta.expanded !== undefined ? { expanded: meta.expanded } : {}),
        ...(meta.hasPopup ? { hasPopup: meta.hasPopup } : {}),
      });
      return {
        ref: `${generation}:${entry.nativeRef}`,
        role: entry.node.role,
        label:
          entry.node.name ||
          entry.node.text ||
          (entry.node.role === "row" ? nodeText(entry.node).slice(0, 300) : ""),
        ...meta,
        ...("description" in meta
          ? {
              description: redact(meta.description || ""),
              placeholder: redact(meta.placeholder || ""),
            }
          : {}),
        ...("options" in meta && meta.options
          ? {
              options: meta.options.map((o) => ({
                ...o,
                label: redact(o.label),
                value: redact(o.value),
              })),
            }
          : {}),
        path: entry.path,
        row: entry.row
          ? { ...entry.row, ref: `${generation}:${entry.row.ref}` }
          : undefined,
        checked: entry.node.checked,
        selected: entry.node.selected,
        box: entry.node.box,
        actions: meta.disabled
          ? []
          : meta.expandable
            ? ["click", "hover", "expand", "collapse"]
            : [
                "click",
                "hover",
                ...(["textbox", "searchbox", "combobox"].includes(
                  entry.node.role || "",
                )
                  ? ["fill"]
                  : []),
              ],
      };
    }),
  );
  const extraRefs = outline.regions.flatMap((n) => (n.ref ? [n.ref] : []));
  s.refs = new Set([
    ...pending.map((p) => `${generation}:${p.nativeRef}`),
    ...extraRefs.map((ref) => `${generation}:${ref}`),
  ]);
  for (const item of pending) item.node.ref = `${generation}:${item.nativeRef}`;
  s.observed.add(s.page.url());
  return {
    url: s.page.url(),
    title: await s.page.title(),
    scope: scope ? "element" : "page",
    viewport: s.page.viewportSize(),
    tree: scope?.table ? undefined : tree,
    elements,
    regions: outline.regions.map((n) => ({
      ref: `${generation}:${n.ref}`,
      role: n.role,
      label: n.name || "",
    })),
    tables: outline.tables.map((t) => ({
      ...t,
      ref: `${generation}:${t.ref}`,
      hint: "renderedRows只代表当前DOM中已渲染的行；用browser_table按内容定位并逐页/滚动继续探索",
    })),
    alerts: outline.alerts,
    focus: focus
      ? {
          ref: `${generation}:${focus.ref}`,
          role: focus.role,
          label: focus.name || "",
        }
      : undefined,
    table:
      table && tableWindow
        ? {
            ref: `${generation}:${table.ref}`,
            label: table.name || "",
            renderedRows: tableWindow.data.length,
            matched: tableWindow.matched,
            offset: tableWindow.offset,
            hasMore:
              tableWindow.offset + tableWindow.selected.length <
              tableWindow.matched,
            columns: tableWindow.headers.flatMap((r) =>
              rowCells(r).map(nodeText),
            ),
            rows: tableWindow.selected.map((row) => ({
              ref: `${generation}:${row.ref}`,
              index: tableWindow.data.indexOf(row),
              cells: rowCells(row).map((cell) => ({
                ref: `${generation}:${cell.ref}`,
                text: nodeText(cell).slice(0, 500),
              })),
              controls: elements.filter(
                (e) => e.row?.ref === `${generation}:${row.ref}`,
              ),
            })),
          }
        : undefined,
    truncated:
      truncated ||
      candidates.length > 200 ||
      outline.tables.some((t) => t.renderedRows > (scope?.table?.limit || 10)),
    hint: "弹窗/抽屉优先显示；regions保留页面区域入口。表格默认仅返回前10行，用browser_table按单号等唯一标识查行，不能默认点击第一个同名按钮。未渲染的分页/虚拟行尚未观察；每次快照更新ref。",
  };
}
export async function act(
  s: BrowserSession,
  input: { action: string; ref?: string; value?: string; axis?: "x" | "y" },
) {
  if (input.action === "navigate") {
    const url = new URL(input.value || "", s.page.url());
    ensure(url.origin === s.origin, "仅允许在目标网站内导航");
    await s.page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  } else if (input.action === "back")
    await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
  else if (input.action === "scroll") {
    const amount = Math.max(-1000, Math.min(1000, Number(input.value) || 600));
    if (input.ref) {
      await resolveRef(s, input.ref).evaluate(
        (el, { amount, axis }) => {
          let target: Element | null = el;
          while (target) {
            const style = getComputedStyle(target);
            const overflow = axis === "x" ? style.overflowX : style.overflowY;
            const max =
              axis === "x"
                ? target.scrollWidth - target.clientWidth
                : target.scrollHeight - target.clientHeight;
            if (max > 0 && /(auto|scroll)/.test(overflow)) {
              target.scrollBy({
                left: axis === "x" ? amount : 0,
                top: axis === "y" ? amount : 0,
                behavior: "instant",
              });
              return;
            }
            target = target.parentElement;
          }
          throw new Error(
            "该控件及祖先没有可滚动容器，请选择正确区域或不填ref滚动页面",
          );
        },
        { amount, axis: input.axis || "y" },
      );
    } else
      await s.page.mouse.wheel(
        input.axis === "x" ? amount : 0,
        input.axis === "x" ? 0 : amount,
      );
    await s.page.waitForTimeout(50);
  } else {
    ensure(input.ref, "该操作需要控件 ref");
    const target = resolveRef(s, input.ref);
    if (input.action === "hover") await target.hover({ timeout: 10000 });
    else if (input.action === "expand" || input.action === "collapse") {
      const expanded = await target.evaluate((el) =>
        el.tagName === "SUMMARY"
          ? (el.parentElement as HTMLDetailsElement).open
          : el.getAttribute("aria-expanded"),
      );
      ensure(
        expanded !== null,
        "该控件没有可验证的展开状态，请使用 hover 或 click 后重新观察",
      );
      const open = expanded === true || expanded === "true";
      if (open !== (input.action === "expand"))
        await target.click({ timeout: 10000 });
    } else if (input.action === "click") await target.click({ timeout: 10000 });
    else if (input.action === "fill")
      await target.fill(input.value || "", { timeout: 10000 });
    else if (input.action === "select")
      await target.selectOption(input.value || "", { timeout: 10000 });
    else if (input.action === "check")
      await target.setChecked(input.value !== "false", { timeout: 10000 });
    else if (input.action === "press")
      await target.press(input.value || "Enter", { timeout: 10000 });
    else throw new Error("不支持的浏览器操作");
  }
  await s.page
    .waitForLoadState("domcontentloaded", { timeout: 3000 })
    .catch(() => {});
  return observe(s);
}
export async function navigateRef(s: BrowserSession, ref: string) {
  const target = resolveRef(s, ref);
  const meta = await target.evaluate((el) => ({
    navigation: Boolean(
      el.closest('nav, [role="navigation"], [role="tablist"]'),
    ),
    interactive: el.matches('button, a, [role="button"], [role="tab"]'),
    form: Boolean(el.closest("form")),
    href: el.tagName === "A" ? (el as HTMLAnchorElement).href : "",
    download: el.hasAttribute("download"),
  }));
  ensure(
    !meta.form &&
      !meta.download &&
      meta.interactive &&
      (meta.navigation || meta.href),
    "该控件不是导航入口，业务操作需先定义任务契约",
  );
  if (meta.href)
    ensure(new URL(meta.href).origin === s.origin, "仅允许在目标网站内导航");
  await target.click({ timeout: 10000 });
  await s.page
    .waitForLoadState("domcontentloaded", { timeout: 3000 })
    .catch(() => {});
  return observe(s);
}
// Observation images do not refresh refs or count as verified guide evidence.
export async function capturePageImage(s: BrowserSession) {
  return s.page.screenshot({
    scale: "css",
    mask: [s.page.locator('input[type="password"], [data-private]')],
  });
}
export async function screenshot(
  s: BrowserSession,
  revision = 0,
  evidenceId?: string,
) {
  const id = randomUUID();
  const dir = path.join(projectDir(s.projectId), "artifacts");
  await mkdir(dir, { recursive: true });
  const snapshot = await observe(s);
  const viewport = s.page.viewportSize()!;
  const elements = (
    await Promise.all(
      snapshot.elements.map(async (element) => {
        const box = await resolveRef(s, element.ref)
          .boundingBox()
          .catch(() => null);
        if (!box) return [];
        const x = Math.max(0, box.x),
          y = Math.max(0, box.y);
        const width = Math.min(viewport.width, box.x + box.width) - x;
        const height = Math.min(viewport.height, box.y + box.height) - y;
        return width > 0 && height > 0
          ? [
              {
                ref: element.ref,
                label: element.label,
                box: { x, y, width, height },
              },
            ]
          : [];
      }),
    )
  ).flat();
  await writeFile(path.join(dir, id + ".png"), await capturePageImage(s), {
    mode: 0o600,
  });
  const result: ScreenshotArtifact = {
    id,
    kind: "screenshot",
    browserId: s.id,
    pageUrl: s.page.url(),
    ...viewport,
    revision,
    evidenceId,
    capturedAt: new Date().toISOString(),
    elements,
  };
  await atomic(path.join(dir, id + ".json"), result);
  return result;
}
export async function closeAllBrowsers() {
  await Promise.allSettled(
    [...sessions.values()].map((s) => s.context.close()),
  );
}
export async function closeProjectBrowsers(projectId: string) {
  await Promise.allSettled(
    [...sessions.values()]
      .filter((s) => s.projectId === projectId)
      .map((s) => s.context.close()),
  );
}
