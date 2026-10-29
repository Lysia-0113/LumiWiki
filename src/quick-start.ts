import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Locator, Page } from "playwright";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { ensure } from "./config.js";
import {
  allNodes,
  rowCells,
  tableRows,
  nodeText,
  type Snapshot,
} from "./browser-structure.js";

const text = () => Type.String({ minLength: 1, maxLength: 1000 });
const key = () => Type.String({ pattern: "^[a-z0-9-]{1,64}$" });
export const locatorSchema = Type.Union([
  Type.Object({ role: text(), name: text() }, { additionalProperties: false }),
  Type.Object({ text: text() }, { additionalProperties: false }),
  Type.Object({ label: text() }, { additionalProperties: false }),
  Type.Object({ testId: text() }, { additionalProperties: false }),
  Type.Object({ css: text() }, { additionalProperties: false }),
]);
export const checkSchema = Type.Object(
  {
    id: key(),
    description: text(),
    scope: Type.Optional(locatorSchema),
    target: locatorSchema,
    assertion: Type.Union([
      Type.Literal("visible"),
      Type.Literal("hidden"),
      Type.Literal("enabled"),
      Type.Literal("disabled"),
      Type.Literal("checked"),
      Type.Literal("unchecked"),
      Type.Literal("text_contains"),
      Type.Literal("text_equals"),
      Type.Literal("value_equals"),
      Type.Literal("selected_label_equals"),
      Type.Literal("row_fields"),
      Type.Literal("count"),
    ]),
    texts: Type.Optional(Type.Array(text(), { minItems: 1, maxItems: 10 })),
    count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    rowKey: Type.Optional(
      Type.Object(
        { column: text(), value: text() },
        { additionalProperties: false },
      ),
    ),
    fields: Type.Optional(
      Type.Array(
        Type.Object(
          { column: text(), value: text() },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 12 },
      ),
    ),
  },
  { additionalProperties: false },
);
export const planSchema = Type.Object(
  {
    title: text(),
    audience: text(),
    profile: Type.Optional(
      Type.Union([Type.Literal("admin"), Type.Literal("general")]),
    ),
    modules: Type.Array(
      Type.Object(
        {
          id: key(),
          title: text(),
          coverageReason: text(),
          scenarios: Type.Array(
            Type.Object(
              {
                id: key(),
                kind: Type.Union([
                  Type.Literal("success"),
                  Type.Literal("empty"),
                  Type.Literal("error"),
                  Type.Literal("permission"),
                ]),
                goal: text(),
                setup: text(),
                cleanup: text(),
                checkpoints: Type.Optional(
                  Type.Array(
                    Type.Object(
                      {
                        id: key(),
                        title: text(),
                        checks: Type.Array(checkSchema, {
                          minItems: 1,
                          maxItems: 8,
                        }),
                      },
                      { additionalProperties: false },
                    ),
                    { maxItems: 6 },
                  ),
                ),
                preconditions: Type.Array(checkSchema, {
                  minItems: 1,
                  maxItems: 12,
                }),
                outcomes: Type.Array(checkSchema, {
                  minItems: 1,
                  maxItems: 12,
                }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 4 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export type TaskPlan = Static<typeof planSchema>;
export type Check = Static<typeof checkSchema>;
type Target = Static<typeof locatorSchema>;
export interface CheckResult {
  id: string;
  passed: boolean;
  description: string;
  actual: string;
}
interface Evidence {
  id: string;
  revision: number;
  pageUrl: string;
  checkedAt: string;
  checks: CheckResult[];
}
interface ScenarioState {
  moduleId: string;
  scenarioId: string;
  status: "pending" | "active" | "verified" | "blocked";
  preconditions?: CheckResult[];
  evidence?: Evidence;
  outcomes: Array<{ ids: string[]; evidence: Evidence; images: string[] }>;
  checkpoints: Array<{
    id: string;
    title: string;
    evidence?: Evidence;
    images: string[];
  }>;
  reason?: string;
  images: string[];
}

function locate(root: Page | Locator, target: Target): Locator {
  if (
    "role" in target &&
    ["generic", "paragraph", "text", "strong", "emphasis"].includes(target.role)
  )
    return root.getByText(target.name, { exact: true });
  if ("role" in target)
    return root.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      name: target.name,
      exact: true,
    });
  if ("text" in target) return root.getByText(target.text, { exact: true });
  if ("label" in target) {
    let field = root
      .getByLabel(target.label, { exact: true })
      .and(
        root.locator(
          'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="spinbutton"], [role="switch"], [role="radiogroup"], [role="listbox"], [role="group"], fieldset',
        ),
      );
    for (const role of [
      "textbox",
      "combobox",
      "checkbox",
      "radio",
      "spinbutton",
      "switch",
      "radiogroup",
      "listbox",
      "group",
    ] as const)
      field = field.or(
        root.getByRole(role, { name: target.label, exact: true }),
      );
    return field;
  }
  if ("testId" in target) return root.getByTestId(target.testId);
  return root.locator(target.css);
}

// Only DOM reads, never model-provided JS or arbitrary HTTP/database access.
export async function verifyChecks(
  page: Page,
  checks: Check[],
  timeout = 2500,
): Promise<CheckResult[]> {
  const deadline = Date.now() + timeout;
  let results: CheckResult[];
  do {
    results = await Promise.all(
      checks.map(async (check) => {
        try {
          let root: Page | Locator = page;
          if (check.scope) {
            const scope = locate(page, check.scope);
            if ((await scope.count()) !== 1 || !(await scope.isVisible()))
              return {
                id: check.id,
                description: check.description,
                passed: false,
                actual: "验证范围不存在、不唯一或不可见",
              };
            root = scope;
          }
          const target = locate(root, check.target);
          const count = await target.count();
          let passed = false;
          let actual = `matched=${count}`;
          if (check.assertion === "count")
            passed =
              count === check.count &&
              (count === 0 ||
                (
                  await Promise.all(
                    Array.from({ length: count }, (_, i) =>
                      target.nth(i).isVisible(),
                    ),
                  )
                ).every(Boolean));
          else if (check.assertion === "hidden")
            passed =
              count === 0 ||
              (
                await Promise.all(
                  Array.from({ length: count }, (_, i) =>
                    target.nth(i).isVisible(),
                  ),
                )
              ).every((x) => !x);
          else if (count === 1 && (await target.isVisible())) {
            if (check.assertion === "row_fields") {
              const raw = (await target.ariaSnapshotJSON({
                mode: "ai",
                depth: 15,
                timeout: 1000,
              })) as Snapshot;
              const table = allNodes(raw).find((n) =>
                ["table", "grid", "treegrid"].includes(n.role || ""),
              );
              if (table && check.rowKey && check.fields?.length) {
                const rows = tableRows(table);
                const head = rows.find((row) =>
                  rowCells(row).some((c) => c.role === "columnheader"),
                );
                const columns = head
                  ? rowCells(head).map((c) => nodeText(c).trim())
                  : [];
                const index = (name: string) =>
                  columns.filter((c) => c === name).length === 1
                    ? columns.indexOf(name)
                    : -1;
                const key = index(check.rowKey.column);
                const matches =
                  key >= 0
                    ? rows.filter(
                        (row) =>
                          !rowCells(row).some(
                            (c) => c.role === "columnheader",
                          ) &&
                          nodeText(rowCells(row)[key] || "").trim() ===
                            check.rowKey!.value,
                      )
                    : [];
                passed =
                  matches.length === 1 &&
                  check.fields.every(
                    (f) =>
                      index(f.column) >= 0 &&
                      nodeText(
                        rowCells(matches[0])[index(f.column)] || "",
                      ).trim() === f.value,
                  );
                actual += `; rowKeyMatches=${matches.length}; fieldsMatched=${passed}`;
              }
            } else if (check.assertion === "visible") passed = true;
            else if (check.assertion === "enabled")
              passed = await target.isEnabled();
            else if (check.assertion === "disabled")
              passed = !(await target.isEnabled());
            else if (check.assertion === "checked")
              passed = await target.isChecked();
            else if (check.assertion === "unchecked")
              passed = !(await target.isChecked());
            else if (check.assertion === "value_equals")
              passed =
                (await target.inputValue({ timeout: 500 })) ===
                check.texts?.[0];
            else if (check.assertion === "selected_label_equals") {
              const labels = await target.evaluate((el) => {
                if (el.tagName === "SELECT")
                  return Array.from(
                    (el as HTMLSelectElement).selectedOptions,
                  ).map((option) => option.label.trim());
                const label = (node: Element) =>
                  (
                    node.getAttribute("aria-label") ||
                    node
                      .getAttribute("aria-labelledby")
                      ?.split(/\s+/)
                      .map(
                        (id) =>
                          node.ownerDocument.getElementById(id)?.textContent ||
                          "",
                      )
                      .join(" ") ||
                    ((node as HTMLInputElement).labels &&
                      Array.from((node as HTMLInputElement).labels!)
                        .map((l) => l.textContent || "")
                        .join(" ")) ||
                    node.textContent ||
                    ""
                  ).trim();
                const selected = Array.from(
                  el.querySelectorAll(
                    'input[type="radio"]:checked, input[type="checkbox"]:checked, [role="radio"][aria-checked="true"], [role="option"][aria-selected="true"]',
                  ),
                );
                if (selected.length) return selected.map(label);
                if (
                  (el as HTMLInputElement).checked ||
                  el.getAttribute("aria-checked") === "true"
                )
                  return [label(el)];
                if (el.getAttribute("role") === "combobox")
                  return [
                    (
                      (el as HTMLInputElement).value ||
                      el.textContent ||
                      ""
                    ).trim(),
                  ];
                return [];
              });
              passed =
                labels.length === check.texts?.length &&
                [...labels]
                  .sort()
                  .every((label, i) => label === [...check.texts!].sort()[i]);
            } else {
              // Return only the match result, never raw account values/passwords.
              const content = await target.innerText({ timeout: 500 });
              passed =
                check.assertion === "text_equals"
                  ? content.trim() === check.texts?.[0]
                  : Boolean(check.texts?.every((t) => content.includes(t)));
              actual += `; requiredTextMatched=${passed}`;
            }
          }
          return {
            id: check.id,
            description: check.description,
            passed,
            actual,
          };
        } catch {
          return {
            id: check.id,
            description: check.description,
            passed: false,
            actual: "控件检查失败",
          };
        }
      }),
    );
    if (results.every((r) => r.passed) || Date.now() >= deadline)
      return results;
    await new Promise((r) => setTimeout(r, 100));
  } while (true);
}

export class QuickStartRun {
  enabled = false;
  runId = randomUUID();
  plan?: TaskPlan;
  scenarios: ScenarioState[] = [];
  active?: ScenarioState;
  documents = new Map<string, string>();
  published = false;
  revision = 0;
  continuations = 0;
  audit: Array<{ at: string; event: string; tool?: string; error?: boolean }> =
    [];

  reset() {
    this.enabled = true;
    this.runId = randomUUID();
    this.plan = undefined;
    this.scenarios = [];
    this.active = undefined;
    this.documents.clear();
    this.published = false;
    this.revision = 0;
    this.continuations = 0;
    this.writeEpoch = undefined;
    this.audit = [];
  }
  restore(snapshot: ReturnType<QuickStartRun["report"]>) {
    ensure(
      !snapshot.plan || Value.Check(planSchema, snapshot.plan),
      "保存的任务契约无效",
    );
    this.reset();
    this.runId = snapshot.runId;
    this.plan = structuredClone(snapshot.plan);
    this.scenarios = structuredClone(snapshot.scenarios);
    this.documents = new Map(Object.entries(snapshot.documents));
    this.published = snapshot.published;
    this.revision = snapshot.revision;
    // The old browser's refs and write epoch are never reused after reconnecting.
    this.active = snapshot.active
      ? this.scenarios.find(
          (s) =>
            s.moduleId === snapshot.active!.moduleId &&
            s.scenarioId === snapshot.active!.scenarioId,
        )
      : undefined;
  }
  resume() {
    this.continuations = 0;
    for (const scenario of this.scenarios) {
      if (
        scenario.status === "blocked" &&
        !this.documents.has(scenario.moduleId)
      ) {
        scenario.status = "pending";
        delete scenario.reason;
      }
    }
  }
  readyModules() {
    return (this.plan?.modules || []).flatMap((module) => {
      if (this.documents.has(module.id)) return [];
      const cases = this.scenarios.filter((s) => s.moduleId === module.id);
      const imageIds = [
        ...new Set(
          cases
            .filter((s) => s.status === "verified")
            .flatMap((s) => [
              ...s.checkpoints.flatMap((c) => c.images.slice(-1)),
              ...s.images.slice(-1),
            ]),
        ),
      ].slice(0, 4);
      try {
        this.assertDocument(module.id, imageIds);
        return [{ moduleId: module.id, title: module.title, imageIds }];
      } catch {
        return [];
      }
    });
  }
  setPlan(plan: TaskPlan, seenControls?: ReadonlySet<string>) {
    ensure(Value.Check(planSchema, plan), "任务契约格式无效");
    if (seenControls)
      for (const module of plan.modules)
        for (const scenario of module.scenarios)
          for (const check of [
            ...scenario.preconditions,
            ...scenario.outcomes,
            ...(scenario.checkpoints || []).flatMap(
              (checkpoint) => checkpoint.checks,
            ),
          ]) {
            if ("role" in check.target && check.target.role === "row")
              ensure(
                seenControls.has(
                  JSON.stringify([check.target.role, check.target.name]),
                ),
                "整行文本组合未实际观察，不能猜测未来行的完整名称；请用row_fields按表格唯一键和列名核对业务字段",
              );
            if (
              "role" in check.target &&
              [
                "radio",
                "checkbox",
                "combobox",
                "textbox",
                "spinbutton",
                "switch",
              ].includes(check.target.role)
            )
              ensure(
                seenControls.has(
                  JSON.stringify([check.target.role, check.target.name]),
                ),
                `尚未观察到${check.target.role}控件“${check.target.name}”，不能猜测表单控件类型。未知表单优先使用{label:业务字段名}和value_equals或selected_label_equals；选择项用可见标签比较。`,
              );
          }
    ensure(
      !this.plan,
      "计划已锁定，不能在执行后降低验收条件；请发起新的快速上手任务",
    );
    ensure(
      new Set(plan.modules.map((m) => m.id)).size === plan.modules.length,
      "模块ID重复",
    );
    for (const m of plan.modules) {
      ensure(
        new Set(m.scenarios.map((s) => s.id)).size === m.scenarios.length,
        "场景ID重复",
      );
      for (const s of m.scenarios) {
        ensure(
          new Set((s.checkpoints || []).map((c) => c.id)).size ===
            (s.checkpoints || []).length,
          "检查点ID重复",
        );
        if ((plan.profile || "admin") === "admin")
          ensure(
            (s.checkpoints?.length || 0) >= (s.kind === "success" ? 2 : 1),
            "后台任务成功场景至少需要2个中间检查点，其他场景至少1个；简单只读任务可显式使用general",
          );
        for (const checks of [
          s.preconditions,
          s.outcomes,
          ...(s.checkpoints || []).map((c) => c.checks),
        ]) {
          ensure(
            new Set(checks.map((c) => c.id)).size === checks.length,
            "检查ID重复",
          );
          for (const c of checks) {
            if (c.assertion === "row_fields") {
              ensure(
                c.rowKey && c.fields?.length,
                "row_fields需要rowKey和fields",
              );
              ensure(
                new Set(c.fields.map((f) => f.column)).size === c.fields.length,
                "字段列重复",
              );
            }
            ensure(
              ![
                "text_contains",
                "text_equals",
                "value_equals",
                "selected_label_equals",
              ].includes(c.assertion) || c.texts?.length,
              "文本检查需要 texts",
            );
            ensure(
              !["text_equals", "value_equals"].includes(c.assertion) ||
                c.texts?.length === 1,
              "精确文本检查需要一个texts值",
            );
            ensure(
              c.assertion !== "count" || c.count !== undefined,
              "数量检查需要 count",
            );
            ensure(
              (c.assertion !== "hidden" &&
                !(c.assertion === "count" && c.count === 0)) ||
                c.scope,
              "不存在/零数量检查必须指定可见且唯一的 scope，避免页面未加载造成假通过",
            );
          }
        }
      }
    }
    this.enabled = true;
    this.plan = structuredClone({ ...plan, profile: plan.profile || "admin" });
    this.scenarios = plan.modules.flatMap((m) =>
      m.scenarios.map((s) => ({
        moduleId: m.id,
        scenarioId: s.id,
        status: "pending" as const,
        checkpoints: (s.checkpoints || []).map((c) => ({
          id: c.id,
          title: c.title,
          images: [],
        })),
        images: [],
        outcomes: [],
      })),
    );
    return this.report();
  }
  private find(moduleId: string, scenarioId: string) {
    const module = this.plan?.modules.find((m) => m.id === moduleId);
    const spec = module?.scenarios.find((s) => s.id === scenarioId);
    const state = this.scenarios.find(
      (s) => s.moduleId === moduleId && s.scenarioId === scenarioId,
    );
    ensure(spec && state, "场景不在任务契约中");
    ensure(!this.documents.has(moduleId), "模块文档已封存");
    return { spec, state };
  }
  prepare(moduleId: string, scenarioId: string) {
    this.find(moduleId, scenarioId);
    ensure(
      !this.active || ["verified", "blocked"].includes(this.active.status),
      "先完成或标记当前场景受阻",
    );
    if (this.active?.status === "verified")
      ensure(
        this.active.outcomes.every((p) => p.images.length),
        "切换场景前先保存每组结果的验证后截图",
      );
    this.active = undefined;
    return {
      moduleId,
      scenarioId,
      instruction:
        "准备该场景的前置状态，然后 quick_start_begin；数据无法准备时用 quick_start_block",
    };
  }
  async begin(moduleId: string, scenarioId: string, page: Page) {
    const { spec, state } = this.find(moduleId, scenarioId);
    ensure(
      !this.active ||
        this.active === state ||
        ["verified", "blocked"].includes(this.active.status),
      "先完成或标记当前场景受阻",
    );
    const checks = await verifyChecks(page, spec.preconditions);
    state.preconditions = checks;
    ensure(
      checks.every((c) => c.passed),
      "前置状态检查失败，请准备测试状态或标记受阻：" + JSON.stringify(checks),
    );
    state.status = "active";
    state.evidence = undefined;
    state.reason = undefined;
    state.images = [];
    state.outcomes = [];
    state.checkpoints = (spec.checkpoints || []).map((c) => ({
      id: c.id,
      title: c.title,
      images: [],
    }));
    this.active = state;
    return this.report();
  }
  private writeEpoch?: number;
  syncWriteEpoch(epoch: number) {
    if (
      this.writeEpoch !== undefined &&
      this.writeEpoch !== epoch &&
      this.active
    ) {
      this.active.outcomes = [];
      this.active.images = [];
      this.active.evidence = undefined;
      if (this.active.status === "verified") this.active.status = "active";
    }
    this.writeEpoch = epoch;
  }
  private refreshOutcomes(state: ScenarioState) {
    const { spec } = this.find(state.moduleId, state.scenarioId);
    const covered = new Set(state.outcomes.flatMap((p) => p.ids));
    state.status = spec.outcomes.every((c) => covered.has(c.id))
      ? "verified"
      : "active";
    state.images = [...new Set(state.outcomes.flatMap((p) => p.images))];
  }
  mutated(preserveOutcomes = false) {
    const latest = this.active?.checkpoints
      .filter((c) => c.evidence?.checks.every((x) => x.passed))
      .at(-1);
    if (latest?.evidence?.revision === this.revision)
      ensure(latest.images.length, "操作下一步前请先保存当前检查点截图");
    const current = this.active?.outcomes.find(
      (p) => p.evidence.id === this.active?.evidence?.id,
    );
    if (current?.evidence.revision === this.revision)
      ensure(
        current.images.length,
        "切换页面或继续操作前，先保存当前已验证结果的截图",
      );
    this.revision++;
    if (this.active && !this.documents.has(this.active.moduleId)) {
      this.active.evidence = undefined;
      if (!preserveOutcomes) this.active.outcomes = [];
      this.refreshOutcomes(this.active);
    }
  }
  async verify(page: Page, outcomeIds?: string[]) {
    const state = this.active;
    ensure(state && state.status !== "blocked", "请先开始场景");
    const { spec } = this.find(state.moduleId, state.scenarioId);
    ensure(
      state.checkpoints.every(
        (c) => c.evidence?.checks.every((x) => x.passed) && c.images.length,
      ),
      "中间检查点未完成或缺少截图，请按顺序完成quick_start_checkpoint",
    );
    const ids = outcomeIds || spec.outcomes.map((c) => c.id);
    ensure(
      ids.length &&
        new Set(ids).size === ids.length &&
        ids.every((id) => spec.outcomes.some((c) => c.id === id)),
      "结果条件ID无效或重复",
    );
    const checks = await verifyChecks(
      page,
      spec.outcomes.filter((c) => ids.includes(c.id)),
    );
    if (checks.every((c) => c.passed)) {
      for (const proof of state.outcomes)
        proof.ids = proof.ids.filter((id) => !ids.includes(id));
      state.outcomes = state.outcomes.filter((p) => p.ids.length);
      const evidence: Evidence = {
        id: randomUUID(),
        revision: this.revision,
        pageUrl: page.url(),
        checkedAt: new Date().toISOString(),
        checks,
      };
      state.outcomes.push({ ids, evidence, images: [] });
      state.evidence = evidence;
    } else if (state.evidence?.revision === this.revision) {
      const failed = new Set(checks.filter((c) => !c.passed).map((c) => c.id));
      const current = state.outcomes.find(
        (p) => p.evidence.id === state.evidence!.id,
      );
      if (current) {
        current.ids = current.ids.filter((id) => !failed.has(id));
        current.evidence.checks = current.evidence.checks.filter((c) =>
          current.ids.includes(c.id),
        );
      }
      state.outcomes = state.outcomes.filter((p) => p.ids.length);
      state.evidence = undefined;
    }
    this.refreshOutcomes(state);
    const covered = new Set(state.outcomes.flatMap((p) => p.ids));
    return {
      status: state.status,
      checks,
      evidence: state.evidence,
      remainingOutcomeIds: spec.outcomes
        .filter((c) => !covered.has(c.id))
        .map((c) => c.id),
      availableOutcomeIds: checks.filter((c) => c.passed).map((c) => c.id),
      hint: "跨页面结果可用outcomeIds分组验证；每组通过后先截图，再导航至下一组。未通过条件不计入已验证；同站写请求会撤销当前场景的结果证据。",
    };
  }
  async checkpoint(page: Page, checkpointId: string) {
    const state = this.active;
    ensure(
      state?.status === "active",
      "请先开始场景，中间检查点须在最终验证前执行",
    );
    const { spec } = this.find(state.moduleId, state.scenarioId);
    const index = state.checkpoints.findIndex((c) => c.id === checkpointId);
    ensure(index >= 0, "检查点不在任务契约中");
    ensure(
      state.checkpoints
        .slice(0, index)
        .every(
          (c) => c.evidence?.checks.every((x) => x.passed) && c.images.length,
        ),
      "请按顺序完成前置检查点并截图",
    );
    ensure(
      !state.checkpoints
        .slice(index + 1)
        .some((c) => c.evidence?.checks.every((x) => x.passed)),
      "后续检查点已执行，不能改写历史证据",
    );
    const checks = await verifyChecks(page, spec.checkpoints![index].checks);
    const checkpoint = state.checkpoints[index];
    checkpoint.images = [];
    checkpoint.evidence = {
      id: randomUUID(),
      revision: this.revision,
      pageUrl: page.url(),
      checkedAt: new Date().toISOString(),
      checks,
    };
    return {
      checkpointId,
      passed: checks.every((c) => c.passed),
      evidence: checkpoint.evidence,
    };
  }
  captureEvidenceId() {
    const state = this.active;
    if (
      state?.evidence?.revision === this.revision &&
      state.outcomes.some((p) => p.evidence.id === state.evidence!.id)
    )
      return state.evidence.id;
    const checkpoint = state?.checkpoints
      .filter((c) => c.evidence?.checks.every((x) => x.passed))
      .at(-1);
    return checkpoint?.evidence?.revision === this.revision
      ? checkpoint.evidence.id
      : undefined;
  }
  async recheck(page: Page) {
    const state = this.active;
    if (!state || state.status === "blocked") return;
    const { spec } = this.find(state.moduleId, state.scenarioId);
    const current = state.outcomes.find(
      (p) =>
        p.evidence.id === state.evidence?.id &&
        p.evidence.revision === this.revision,
    );
    if (current) {
      const checks = await verifyChecks(
        page,
        spec.outcomes.filter((c) => current.ids.includes(c.id)),
      );
      if (!checks.every((c) => c.passed)) {
        state.outcomes = state.outcomes.filter((p) => p !== current);
        state.evidence = undefined;
        this.refreshOutcomes(state);
      }
      return;
    }
    const checkpoint = state.checkpoints
      .filter((c) => c.evidence?.checks.every((x) => x.passed))
      .at(-1);
    if (checkpoint?.evidence?.revision === this.revision) {
      const checks = await verifyChecks(
        page,
        spec.checkpoints!.find((c) => c.id === checkpoint.id)!.checks,
      );
      if (!checks.every((c) => c.passed)) {
        checkpoint.evidence.checks = checks;
        checkpoint.images = [];
      }
    }
  }
  block(moduleId: string, scenarioId: string, reason: string) {
    ensure(reason.trim().length >= 5, "请给出具体受阻原因");
    const { state } = this.find(moduleId, scenarioId);
    state.status = "blocked";
    state.outcomes = [];
    state.reason = reason;
    state.evidence = undefined;
    state.images = [];
    if (this.active === state) this.active = undefined;
    return this.report();
  }
  capture(imageId: string, revision: number, evidenceId?: string) {
    if (revision !== this.revision || !evidenceId) return;
    const state = this.active;
    if (!state) return;
    const checkpoint = state.checkpoints.find(
      (c) =>
        c.evidence?.id === evidenceId &&
        c.evidence.revision === revision &&
        c.evidence.checks.every((x) => x.passed),
    );
    if (checkpoint) checkpoint.images.push(imageId);
    const proof = state.outcomes.find(
      (p) => p.evidence.id === evidenceId && p.evidence.revision === revision,
    );
    if (proof) {
      proof.images.push(imageId);
      this.refreshOutcomes(state);
    }
  }
  captureDerived(imageId: string, sourceId: string, evidenceId?: string) {
    if (!evidenceId) return;
    for (const state of this.scenarios) {
      if (this.documents.has(state.moduleId)) continue;
      let changed = false;
      for (const proof of state.outcomes)
        if (
          proof.evidence.id === evidenceId &&
          proof.images.includes(sourceId)
        ) {
          proof.images.push(imageId);
          changed = true;
        }
      for (const checkpoint of state.checkpoints)
        if (
          checkpoint.evidence?.id === evidenceId &&
          checkpoint.images.includes(sourceId)
        )
          checkpoint.images.push(imageId);
      if (changed && state.status !== "blocked") this.refreshOutcomes(state);
    }
  }
  assertDocument(moduleId?: string, imageIds: string[] = []) {
    if (!this.enabled) return;
    ensure(
      moduleId && this.plan?.modules.some((m) => m.id === moduleId),
      "快速上手文档必须绑定 moduleId",
    );
    ensure(!this.documents.has(moduleId), "该模块已有文档");
    const cases = this.scenarios.filter((s) => s.moduleId === moduleId);
    ensure(
      cases.every((s) => ["verified", "blocked"].includes(s.status)),
      "模块还有未完成场景",
    );
    const verified = cases.filter((s) => s.status === "verified");
    ensure(verified.length, "该模块没有通过检查的场景，请在发布时说明跳过原因");
    const evidenceImages = new Set<string>();
    for (const s of verified) {
      for (const checkpoint of s.checkpoints) {
        ensure(
          checkpoint.evidence && checkpoint.images.length,
          "缺少归档的中间检查点截图",
        );
        checkpoint.images.forEach((id) => evidenceImages.add(id));
      }
      ensure(s.images.length, "每个通过检查的场景须归档验证后截图");
      for (const proof of s.outcomes) {
        ensure(proof.images.length, "每组跨页面结果必须归档自己的验证后截图");
        proof.images.forEach((id) => evidenceImages.add(id));
      }
    }
    ensure(
      imageIds.length && imageIds.every((id) => evidenceImages.has(id)),
      "模块文档须选用本模块核验后的关键截图",
    );
  }
  bindDocument(moduleId: string | undefined, documentId: string) {
    if (this.enabled && moduleId) {
      this.documents.set(moduleId, documentId);
      if (this.active?.moduleId === moduleId) this.active = undefined;
    }
  }
  assertPublish(
    modules: Array<{ moduleId: string; documentId?: string; reason?: string }>,
  ) {
    ensure(this.plan, "请先生成任务契约");
    ensure(
      modules.length === this.plan.modules.length &&
        new Set(modules.map((m) => m.moduleId)).size === modules.length,
      "模块覆盖不完整或重复",
    );
    for (const m of this.plan.modules) {
      const item = modules.find((x) => x.moduleId === m.id);
      ensure(
        item && Boolean(item.documentId) !== Boolean(item.reason?.trim()),
        "模块需要文档或具体跳过原因",
      );
      if (item.documentId)
        ensure(
          this.documents.get(m.id) === item.documentId,
          "模块文档未通过场景门禁或跨模块使用",
        );
      else ensure(item.reason!.trim().length >= 5, "跳过原因过短");
    }
  }
  guard(tool: string, input: Record<string, unknown>) {
    if (!this.enabled) return;
    if (
      [
        "browser_act",
        "browser_navigate",
        "quick_start_prepare",
        "quick_start_begin",
      ].includes(tool)
    ) {
      const ready = this.readyModules();
      ensure(
        !ready.length,
        `模块已完成，请先用 document_write 保存后再继续：${JSON.stringify(ready)}`,
      );
    }
    if (
      this.scenarios.length &&
      this.scenarios.every((s) => s.status === "blocked")
    )
      ensure(
        ![
          "browser_act",
          "browser_navigate",
          "browser_login",
          "quick_start_plan",
          "quick_start_prepare",
          "quick_start_begin",
        ].includes(tool),
        "所有场景已受阻，停止业务操作；请汇总具体原因或发起新的快速上手任务",
      );
    if (
      tool === "browser_act" &&
      !["navigate", "back", "scroll", "hover", "expand", "collapse"].includes(
        String(input.action),
      )
    )
      ensure(
        this.plan,
        "请先用 browser_navigate 探路，再锁定任务契约；提交或填写需在契约后执行",
      );
    if (tool === "browser_login") ensure(this.plan, "请先定义任务契约");
    if (tool === "document_write")
      this.assertDocument(
        input.moduleId as string | undefined,
        ((input.steps || []) as Array<{ imageId?: string }>).flatMap((s) =>
          s.imageId ? [s.imageId] : [],
        ),
      );
    if (tool === "quick_start_publish")
      this.assertPublish(
        input.modules as Array<{
          moduleId: string;
          documentId?: string;
          reason?: string;
        }>,
      );
  }
  report() {
    return {
      runId: this.runId,
      plan: this.plan,
      scenarios: this.scenarios,
      documents: Object.fromEntries(this.documents),
      published: this.published,
      verificationLevel: "ui-checks",
      contractReview: "draft",
      revision: this.revision,
      continuations: this.continuations,
      active: this.active
        ? { moduleId: this.active.moduleId, scenarioId: this.active.scenarioId }
        : undefined,
      readyModules: this.readyModules(),
    };
  }
}

export function quickStartHooks(
  run: QuickStartRun,
  save: () => Promise<void>,
  emit: (event: Record<string, unknown>) => void,
  canContinue: () => boolean = () => true,
  lifecycle?: {
    beforeTool: (name: string, input: Record<string, unknown>) => Promise<void>;
    afterTool: (
      name: string,
      input: Record<string, unknown>,
      error: boolean,
    ) => Promise<void>;
    shouldPause: () => boolean;
    blockedTool?: (name: string, input: Record<string, unknown>) => void;
  },
): ExtensionFactory {
  return (pi) => {
    const progress = () =>
      JSON.stringify({
        modules: run.plan?.modules.map((m) => m.id),
        documents: [...run.documents],
        scenarios: run.scenarios.map((s) => ({
          module: s.moduleId,
          id: s.scenarioId,
          status: s.status,
          checkpoints: s.checkpoints.map((c) =>
            Boolean(
              c.evidence?.checks.every((x) => x.passed) && c.images.length,
            ),
          ),
          outcomes: s.outcomes.map((o) => o.ids),
        })),
      });
    let previousProgress = "";
    let idleSettles = 0;
    pi.on("before_agent_start", () => {
      previousProgress = progress();
      idleSettles = 0;
      return run.enabled
        ? {
            message: {
              customType: "quick-start-state",
              content: JSON.stringify(run.report()),
              display: false,
            },
          }
        : undefined;
    });
    pi.on("tool_call", async (event) => {
      try {
        run.guard(event.toolName, event.input);
        if (run.enabled)
          await lifecycle?.beforeTool(event.toolName, event.input);
      } catch (error) {
        if (run.enabled) {
          lifecycle?.blockedTool?.(event.toolName, event.input);
          await save();
        }
        return {
          block: true,
          reason: (error as Error).message,
          terminate:
            Boolean(lifecycle?.shouldPause()) ||
            (run.scenarios.length > 0 &&
              run.scenarios.every((s) => s.status === "blocked")),
        };
      }
    });
    pi.on("tool_result", async (event) => {
      if (!run.enabled) return;
      run.audit.push({
        at: new Date().toISOString(),
        event: "tool_result",
        tool: event.toolName,
        error: event.isError,
      });
      await lifecycle?.afterTool(event.toolName, event.input, event.isError);
      await save();
      if (run.readyModules().length) {
        const ready = JSON.stringify(run.readyModules());
        // Keep JSON tool results parseable, including screenshots consumed by clients.
        const content = event.content.map((item) => {
          if (item.type !== "text") return item;
          try {
            const value = JSON.parse(item.text);
            if (value && !Array.isArray(value) && typeof value === "object")
              return {
                ...item,
                text: JSON.stringify({
                  ...value,
                  nextAction: `立即用 document_write 保存已完成模块，使用其归档图片：${ready}`,
                }),
              };
          } catch {
            /* Plain-text references keep their original representation. */
          }
          return item;
        });
        return { content };
      }
    });
    pi.on("agent_before_settle", async (event) => {
      if (!run.enabled) return;
      const currentProgress = progress();
      idleSettles = currentProgress === previousProgress ? idleSettles + 1 : 0;
      previousProgress = currentProgress;
      const allBlocked =
        run.scenarios.length > 0 &&
        run.scenarios.every((s) => s.status === "blocked");
      if (
        event.outcome === "completed" &&
        !run.published &&
        !allBlocked &&
        idleSettles <= 2 &&
        canContinue()
      ) {
        run.continuations++;
        await save();
        return {
          continue: true,
          entries: [
            {
              type: "custom_message" as const,
              customType: "quick-start-resume",
              display: false,
              content: `任务还没有生成指南，继续当前用户已授权任务：根据quick_start_status处理剩余步骤，保留原计划和已保存文档，不重复业务提交。尚未规划时先锁定契约；每完成一个模块立即保存文档，最后汇总。遇到真实阻碍用block记录，不编造通过。持续没有新增核验或文档时暂停并说明原因。`,
            },
          ],
        };
      }
      await save();
      emit({ type: "workflow", workflow: run.report() });
    });
  };
}
