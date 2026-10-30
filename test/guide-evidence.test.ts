import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { atomic, createProject, projectDir } from "../src/store.js";
import { GuideWorkflow } from "../src/guide-workflow.js";
import { QuickStartRun, type TaskPlan } from "../src/quick-start.js";
import {
  chapterCanFreeze,
  evidenceRun,
  loadChapterEvidence,
  saveChapterEvidence,
  validateCoverage,
  normalizeCoverage,
  writingBrief,
} from "../src/guide-evidence.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-guide-evidence-"));
config.data = tmp;
after(() => rm(tmp, { recursive: true, force: true }));
const question = "如何查询余额？";
const answers = [
  {
    question,
    status: "limited" as const,
    explanation: "只确认查询入口，其他权限未核实。",
  },
];
const check = {
  id: "balance",
  description: "余额可见",
  target: { text: "余额100元" },
  assertion: "visible" as const,
};
const plan: TaskPlan = {
  title: "查询余额",
  audience: "账户用户",
  profile: "general",
  modules: [
    {
      id: "balance",
      title: "查询余额",
      coverageReason: "只读账户查询",
      scenarios: [
        {
          id: "read",
          kind: "success",
          goal: "查询当前账户余额",
          setup: "已有测试账户",
          cleanup: "无需清理",
          preconditions: [check],
          outcomes: [check],
        },
      ],
    },
  ],
};
function verifiedRun() {
  const run = new QuickStartRun();
  run.reset();
  run.setPlan(structuredClone(plan));
  const state = run.scenarios[0];
  const proof = {
    id: randomUUID(),
    revision: run.revision,
    pageUrl: "http://fixture.local/",
    checkedAt: new Date().toISOString(),
    checks: [
      {
        id: check.id,
        description: check.description,
        actual: "余额100元",
        passed: true,
      },
    ],
  };
  state.status = "verified";
  state.evidence = proof;
  state.outcomes = [{ ids: [check.id], evidence: proof, images: [] }];
  run.active = state;
  return run;
}
async function fixture() {
  const project = await createProject({ name: "冻结证据" });
  const flow = GuideWorkflow.create(project.key, "生成指南");
  const spec = (id: string) => ({
    id,
    title: id,
    goal: `完成${id}任务`,
    scope: ["查询"],
    questions: [question],
  });
  flow.setOutline({
    title: "账户指南",
    audience: "账户用户",
    overview: "查询账户信息。",
    chapters: [
      spec("producer"),
      { ...spec("balance"), dependsOn: ["producer"] },
      spec("unrelated"),
    ],
  });
  flow.complete("producer", flow.begin("producer"), randomUUID(), {
    summary: "已准备账户",
    facts: [],
  });
  const lease = flow.begin("balance"),
    run = verifiedRun(),
    imageId = randomUUID();
  run.capture(imageId, run.revision, run.active!.evidence!.id);
  const input = {
    browserId: randomUUID(),
    answers: structuredClone(answers),
    references: [{ kind: "page" as const, location: "http://fixture.local/" }],
    images: [{ imageId, caption: "余额位置" }],
    limitations: ["其他权限未核实"],
    verification: run.report(),
  };
  const evidence = await saveChapterEvidence(flow, "balance", lease, input);
  const file = path.join(
    projectDir(project.key),
    "chapter-evidence",
    evidence.id + ".json",
  );
  return { flow, lease, input, evidence, file };
}

test("稳定问题编号映射回原问题，不要求模型逐字重抄长句", () => {
  const input = [{ questionId: 1, status: "limited" as const, explanation: answers[0].explanation }];
  assert.deepEqual(normalizeCoverage([question], input), answers);
  assert.deepEqual(normalizeCoverage([question], answers), answers);
  for (const bad of [[{ ...input[0], questionId: 2 }], [...input, ...input], [{ ...input[0], question: "另一个问题" }]])
    assert.throws(() => normalizeCoverage([question], bad));
});

test("覆盖必须逐一匹配原questions；仅真实核验并归档截图后才能冻结", () => {
  validateCoverage([question], answers);
  for (const coverage of [
    [],
    [...answers, ...answers],
    [{ ...answers[0], question: "伪造问题" }],
    [{ ...answers[0], explanation: " " }],
  ])
    assert.throws(() => validateCoverage([question], coverage));
  const run = verifiedRun();
  assert.equal(
    chapterCanFreeze(run, "balance"),
    false,
    "核验通过但未归档截图仍不能handoff",
  );
  const imageId = randomUUID();
  run.capture(imageId, run.revision, run.active!.evidence!.id);
  assert.equal(
    chapterCanFreeze(run, "balance"),
    true,
    "自动截图归档后立即具备冻结条件",
  );
  assert.equal(chapterCanFreeze(run, "another-chapter"), false);
});

test("证据深拷贝冻结且绑定章节租约；writer只收到功能事实、选图及来源", async () => {
  const { flow, lease, input, evidence } = await fixture();
  assert.equal(flow.chapter("balance").stage, "writing");
  assert.equal(flow.chapter("balance").evidenceId, evidence.id);
  input.answers[0].explanation = "后续探索历史不得污染冻结内容";
  assert.equal(evidence.answers[0].explanation, answers[0].explanation);
  const restored = await loadChapterEvidence(flow, "balance");
  assert.deepEqual(restored, evidence);
  const brief = writingBrief(flow, evidence);
  assert.deepEqual(brief.answers, answers.map((answer, index) => ({ questionId: index + 1, ...answer })));
  assert.deepEqual(brief.images, evidence.images);
  assert.deepEqual(brief.references, evidence.references);
  assert.equal(brief.presentation, "functional_overview");
  assert.match(brief.writingGoal, /功能|区域|字段/);
  assert.ok(!JSON.stringify(brief).includes("unrelated"));
  for (const field of [
    "directory",
    "dependencies",
    "previousAttempt",
    "verification",
    "messages",
    "wiki",
  ])
    assert.ok(!(field in brief), field);
  const run = evidenceRun(evidence);
  run.scenarios[0].images.push("writer-local-change");
  assert.ok(
    !evidence.verification.scenarios[0].images.includes("writer-local-change"),
  );
  flow.fail("balance", lease, "写作中断");
  await assert.rejects(
    saveChapterEvidence(flow, "balance", lease, input),
    /失效/,
  );
  flow.resume();
  assert.equal(flow.chapter("balance").evidenceId, evidence.id);
  assert.equal(flow.chapter("balance").version, evidence.version);
  flow.begin("balance");
  assert.equal(flow.chapter("balance").stage, "writing");
  assert.deepEqual(await loadChapterEvidence(flow, "balance"), evidence);
});

test("冻结证据拒绝跨项目、任务和章节归属，也拒绝场景清单或选图伪造", async () => {
  const { flow, evidence, file } = await fixture();
  for (const field of ["id", "projectId", "taskId", "chapterId"] as const) {
    await atomic(file, { ...evidence, [field]: randomUUID() });
    await assert.rejects(loadChapterEvidence(flow, "balance"), /归属/);
  }
  await atomic(file, evidence);
  assert.deepEqual(await loadChapterEvidence(flow, "balance"), evidence);
  const wrongModule = structuredClone(evidence);
  wrongModule.verification.plan!.modules[0].id = "other";
  assert.throws(() => evidenceRun(wrongModule), /归属/);
  const wrongScenario = structuredClone(evidence);
  wrongScenario.verification.scenarios[0].scenarioId = "other";
  assert.throws(() => evidenceRun(wrongScenario), /场景清单/);
  const wrongImage = structuredClone(evidence);
  wrongImage.images[0].imageId = randomUUID();
  assert.throws(() => evidenceRun(wrongImage), /关键截图/);
});

test("章节版本及依赖版本、文档或生成状态改变即废弃缓存，不复用旧writer事实", async () => {
  const { flow, evidence } = await fixture();
  flow.chapter("balance").version++;
  assert.equal(await loadChapterEvidence(flow, "balance"), undefined);
  assert.equal(flow.chapter("balance").evidenceId, undefined);
  flow.chapter("balance").version = evidence.version;
  const source = flow.chapter("producer");
  const original = structuredClone(source);
  for (const change of [
    { version: source.version + 1 },
    { documentId: randomUUID() },
    { status: "pending" as const },
  ]) {
    Object.assign(source, original, change);
    flow.chapter("balance").evidenceId = evidence.id;
    assert.equal(await loadChapterEvidence(flow, "balance"), undefined);
    assert.equal(flow.chapter("balance").evidenceId, undefined);
  }
});
