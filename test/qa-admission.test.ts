import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { atomic, createProject, json, projectDir } from "../src/store.js";
import { deleteWiki, importWiki, type WikiFile } from "../src/knowledge.js";
import { admitQa, type QaAdmissionResult } from "../src/qa-admission.js";
import type { QaAnswerResult, QaEvidence } from "../src/qa-result.js";
import { listQa, matchQa, publicQa, saveQa, updateQaState } from "../src/qa.js";

const previousData = config.data;
const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-qa-admission-"));
config.data = tmp;
const network = mock.method(globalThis, "fetch", async () => {
  throw new Error("QA admission must not access a model, browser, or network");
});
after(async () => {
  const calls = network.mock.callCount();
  network.mock.restore();
  config.data = previousData;
  await rm(tmp, { recursive: true, force: true });
  assert.equal(calls, 0, "all admission tests must remain offline");
});

const question = "如何搜索笔记？";
const answer = "点击 Search，输入关键词后搜索。";
const doc = (file: WikiFile): Extract<QaEvidence, { kind: "doc" }> => ({
  kind: "doc",
  location: file.pages[0].id,
  fileId: file.id,
  sha256: file.sha256,
});
const page = (): Extract<QaEvidence, { kind: "page" }> => ({
  kind: "page",
  location: "https://fixture.invalid/notes",
  browserId: randomUUID(),
  observedAt: new Date().toISOString(),
});
function result(
  evidence: QaEvidence[],
  patch: Partial<QaAnswerResult> = {},
): QaAnswerResult {
  return { outcome: "answered", answer, scope: "general", evidence, ...patch };
}
async function fixture() {
  const project = await createProject({ name: "admission fixture" });
  const file = await importWiki(
    project,
    "notes.md",
    "# 搜索笔记\n点击 Search，输入关键词后搜索。",
  );
  return { project, file };
}
type Attempt = {
  runId: string;
  question: string;
  result: QaAnswerResult | null;
  decision: QaAdmissionResult["decision"];
  reason: string;
  qaId?: string;
  createdAt: string;
};
function attemptFile(projectId: string, runId: string) {
  return path.join(projectDir(projectId), "qa-attempts", runId + ".json");
}
async function audit(
  projectId: string,
  runId: string,
  admission: QaAdmissionResult,
) {
  const attempt = await json<Attempt>(attemptFile(projectId, runId));
  assert.equal(attempt.runId, runId);
  assert.equal(attempt.decision, admission.decision);
  assert.equal(attempt.reason, admission.reason);
  assert.ok(Number.isFinite(Date.parse(attempt.createdAt)));
  return attempt;
}

test("无结构化结果、澄清、资料不足、动态适用范围和无证据均只记录尝试，不入QA", async () => {
  const { project, file } = await fixture();
  const cases: Array<[QaAnswerResult | undefined, string]> = [
    [undefined, "no_result"],
    [
      result([doc(file)], { outcome: "needs_clarification" }),
      "needs_clarification",
    ],
    [
      result([doc(file)], { outcome: "insufficient_evidence" }),
      "insufficient_evidence",
    ],
    [result([doc(file)], { scope: "context_specific" }), "context_specific"],
    [result([]), "no_evidence"],
    [result([doc(file)], { answer: " " }), "invalid_result"],
  ];
  for (const [input, reason] of cases) {
    const runId = randomUUID();
    const admission = await admitQa(project.key, question, input, runId);
    assert.deepEqual(admission, { decision: "skipped", reason });
    const attempt = await audit(project.key, runId, admission);
    assert.equal(attempt.question, question);
    assert.deepEqual(attempt.result, input ?? null);
    assert.equal(attempt.qaId, undefined);
  }
  assert.deepEqual(await listQa(project.key), []);
});

test("纯当前Wiki证据入库为默认可用未核验QA，并保存完整provenance及内部判定记录", async () => {
  const { project, file } = await fixture();
  const runId = randomUUID();
  const input = result([doc(file)]);
  const admission = await admitQa(project.key, question, input, runId);
  assert.equal(admission.decision, "admitted");
  const [qa] = await listQa(project.key);
  assert.deepEqual(JSON.parse(JSON.stringify(admission.qa)), qa);
  assert.equal(qa.enabled, true);
  assert.equal(qa.status, "draft");
  assert.equal(qa.origin, "public");
  assert.deepEqual(qa.provenance, { runId, evidence: input.evidence });
  assert.equal((await matchQa(project.key, question)).qa?.id, qa.id);
  assert.equal("provenance" in publicQa(qa), false);
  const attempt = await audit(project.key, runId, admission);
  assert.deepEqual(attempt.result, input);
  assert.equal(attempt.qaId, qa.id);
});

test("页面或混合证据只能产生停用候选，不可公开匹配", async () => {
  for (const mixed of [false, true]) {
    const { project, file } = await fixture();
    const runId = randomUUID();
    const evidence = mixed ? [doc(file), page()] : [page()];
    const admission = await admitQa(
      project.key,
      question,
      result(evidence),
      runId,
    );
    assert.equal(admission.decision, "candidate");
    const [qa] = await listQa(project.key);
    assert.equal(qa.enabled, false);
    assert.equal(qa.status, "draft");
    assert.equal(qa.origin, "public");
    assert.deepEqual(qa.provenance, { runId, evidence });
    assert.deepEqual(
      (await listQa(project.key)).filter((q) => q.enabled),
      [],
    );
    assert.equal((await matchQa(project.key, question)).decision, "agent");
    assert.equal((await audit(project.key, runId, admission)).qaId, qa.id);
  }
});

test("跨项目、伪造fileId/pageId、错误hash和已删除/替换Wiki证据全部拒绝", async () => {
  const { project, file } = await fixture();
  const foreign = await fixture();
  const valid = doc(file);
  assert.equal(valid.kind, "doc");
  const invalid: QaEvidence[] = [
    doc(foreign.file),
    { ...valid, fileId: randomUUID() },
    { ...valid, location: foreign.file.pages[0].id },
    { ...valid, sha256: "0".repeat(64) },
  ];
  for (const evidence of invalid) {
    const runId = randomUUID();
    const admission = await admitQa(
      project.key,
      question,
      result([evidence]),
      runId,
    );
    assert.deepEqual(admission, {
      decision: "skipped",
      reason: "stale_evidence",
    });
    await audit(project.key, runId, admission);
  }
  // A bad doc reference must reject even an otherwise valid page candidate.
  const mixed = await admitQa(
    project.key,
    question,
    result([page(), invalid[0]]),
    randomUUID(),
  );
  assert.equal(mixed.reason, "stale_evidence");
  await importWiki(project, file.name, "# 搜索笔记\n替换后的新内容。");
  const replaced = await admitQa(
    project.key,
    question,
    result([valid]),
    randomUUID(),
  );
  assert.equal(replaced.reason, "stale_evidence");
  const fresh = await importWiki(project, "deleted.md", "# 待删除\n内容。");
  await deleteWiki(project.key, fresh.id);
  const deleted = await admitQa(
    project.key,
    question,
    result([doc(fresh)]),
    randomUUID(),
  );
  assert.equal(deleted.reason, "stale_evidence");
  assert.deepEqual(await listQa(project.key), []);
});

test("即使fileId仍相同，当前元数据中的hash或pageId变化也使旧证据失效", async () => {
  const { project, file } = await fixture();
  const metadata = path.join(
    projectDir(project.key),
    "wiki",
    file.id + ".json",
  );
  for (const changed of [
    { ...file, sha256: "f".repeat(64) },
    {
      ...file,
      pages: file.pages.map((p) => ({ ...p, id: p.id + "-changed" })),
    },
  ]) {
    await atomic(metadata, changed);
    const admission = await admitQa(
      project.key,
      question,
      result([doc(file)]),
      randomUUID(),
    );
    assert.deepEqual(admission, {
      decision: "skipped",
      reason: "stale_evidence",
    });
  }
  assert.deepEqual(await listQa(project.key), []);
});

test("页面证据严格校验HTTP/S URL、UUID和有效观察时间", async () => {
  const { project } = await fixture();
  const valid = page();
  assert.equal(valid.kind, "page");
  const invalid = [
    { ...valid, location: "file:///tmp/private" },
    { ...valid, location: "javascript:alert(1)" },
    { ...valid, location: "not a URL" },
    { ...valid, browserId: "../browser" },
    { ...valid, browserId: "-".repeat(36) },
    { ...valid, observedAt: "not a time" },
    { ...valid, observedAt: "1" },
    { ...valid, observedAt: "2025-02-30T10:00:00Z" },
    { ...valid, observedAt: "2026-10-29T24:00:00Z" },
  ];
  for (const evidence of invalid) {
    const runId = randomUUID();
    const admission = await admitQa(
      project.key,
      question,
      result([evidence]),
      runId,
    );
    assert.deepEqual(admission, {
      decision: "skipped",
      reason: "invalid_page_evidence",
    });
    await audit(project.key, runId, admission);
  }
  assert.deepEqual(await listQa(project.key), []);
});

test("并发相同意图的新问题仅入库一条，所有重复返回原QA并保留首次provenance", async () => {
  const { project, file } = await fixture();
  const input = result([doc(file)]);
  const runs = Array.from({ length: 12 }, () => randomUUID());
  const admissions = await Promise.all(
    runs.map((runId, i) =>
      admitQa(project.key, i % 2 ? " 如何 搜索笔记? " : question, input, runId),
    ),
  );
  assert.equal(admissions.filter((a) => a.decision === "admitted").length, 1);
  assert.equal(
    admissions.filter((a) => a.decision === "duplicate").length,
    runs.length - 1,
  );
  const [qa] = await listQa(project.key);
  assert.equal((await listQa(project.key)).length, 1);
  assert.ok(admissions.every((a) => a.qa?.id === qa.id));
  const winningRun =
    runs[admissions.findIndex((a) => a.decision === "admitted")];
  assert.equal(qa.provenance?.runId, winningRun);
  for (const [i, runId] of runs.entries()) {
    assert.equal((await audit(project.key, runId, admissions[i])).qaId, qa.id);
    assert.deepEqual(admissions[i].qa?.provenance, qa.provenance);
  }
});

test("别名/NFKC归一化命中且答案相同则duplicate，不触碰已核验停用条目的状态/来源/证据", async () => {
  const { project, file } = await fixture();
  const provenance = { runId: randomUUID(), evidence: [doc(file)] };
  const original = await saveQa(
    project.key,
    {
      question: "原始问题",
      answer,
      aliases: ["ＡＢＣ 搜索？"],
      status: "verified",
      enabled: false,
    },
    undefined,
    "public",
    provenance,
  );
  const qaFile = path.join(
    projectDir(project.key),
    "qa",
    original.id + ".json",
  );
  const before = await readFile(qaFile, "utf8");
  const runId = randomUUID();
  const admission = await admitQa(
    project.key,
    "abc搜索!",
    result([page()]),
    runId,
  );
  assert.equal(admission.decision, "duplicate");
  assert.deepEqual(admission.qa, JSON.parse(before));
  assert.equal(await readFile(qaFile, "utf8"), before);
  assert.equal((await audit(project.key, runId, admission)).qaId, original.id);
  assert.equal((await listQa(project.key)).length, 1);
});

test("同意图不同答案记录conflict，不新增或覆盖已核验/停用QA", async () => {
  const { project, file } = await fixture();
  const provenance = { runId: randomUUID(), evidence: [doc(file)] };
  const original = await saveQa(
    project.key,
    {
      question,
      answer,
      aliases: ["搜索旧笔记？"],
      status: "verified",
      enabled: false,
    },
    undefined,
    "public",
    provenance,
  );
  const qaFile = path.join(
    projectDir(project.key),
    "qa",
    original.id + ".json",
  );
  const before = await readFile(qaFile, "utf8");
  const runId = randomUUID();
  const admission = await admitQa(
    project.key,
    "搜索旧笔记!",
    result([doc(file)], {
      answer: "另一个答案，不应覆盖管理员的决定。",
    }),
    runId,
  );
  assert.deepEqual(admission, {
    decision: "conflict",
    reason: "conflicting_answer",
  });
  assert.equal((await audit(project.key, runId, admission)).qaId, original.id);
  assert.equal(await readFile(qaFile, "utf8"), before);
  assert.deepEqual(await listQa(project.key), [JSON.parse(before)]);
});

test("并发不同答案只有一个入库，其他答案冲突而非覆盖", async () => {
  const { project, file } = await fixture();
  const answers = ["使用 Search。", "使用 Calendar。", "使用筛选。"];
  const admissions = await Promise.all(
    answers.map((text) =>
      admitQa(
        project.key,
        question,
        result([doc(file)], { answer: text }),
        randomUUID(),
      ),
    ),
  );
  assert.equal(admissions.filter((a) => a.decision === "admitted").length, 1);
  assert.equal(admissions.filter((a) => a.decision === "conflict").length, 2);
  const all = await listQa(project.key);
  assert.equal(all.length, 1);
  assert.equal(
    all[0].answer,
    admissions.find((a) => a.decision === "admitted")?.qa?.answer,
  );
});

test("已取消和排队中取消都抛出原取消原因，不写QA也不记录普通判定", async () => {
  const { project, file } = await fixture();
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  controller.abort(reason);
  const runId = randomUUID();
  await assert.rejects(
    admitQa(
      project.key,
      question,
      result([doc(file)]),
      runId,
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.deepEqual(await listQa(project.key), []);
  await assert.rejects(readFile(attemptFile(project.key, runId)), {
    code: "ENOENT",
  });

  const pending = new AbortController();
  const queuedRunId = randomUUID();
  const canceled = admitQa(
    project.key,
    question,
    result([doc(file)]),
    queuedRunId,
    pending.signal,
  );
  pending.abort(reason);
  await assert.rejects(canceled, (error) => error === reason);
  assert.deepEqual(await listQa(project.key), []);
  await assert.rejects(readFile(attemptFile(project.key, queuedRunId)), {
    code: "ENOENT",
  });
  // Rejected admissions must not poison the project's queue.
  assert.equal(
    (await admitQa(project.key, question, result([doc(file)]), randomUUID()))
      .decision,
    "admitted",
  );
});

test("开始检查后、落库前发生取消仍然抛出，不将取消降级为skipped", async () => {
  const { project, file } = await fixture();
  const controller = new AbortController();
  const reason = new Error("canceled before write");
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  const check = mock.method(controller.signal, "throwIfAborted", () => {
    if (++checks === 3) controller.abort(reason);
    original();
  });
  const runId = randomUUID();
  try {
    await assert.rejects(
      admitQa(
        project.key,
        question,
        result([doc(file)]),
        runId,
        controller.signal,
      ),
      (error) => error === reason,
    );
  } finally {
    check.mock.restore();
  }
  assert.deepEqual(await listQa(project.key), []);
  await assert.rejects(readFile(attemptFile(project.key, runId)), {
    code: "ENOENT",
  });
});

test("无效runId包括路径穿越必须在任何写入前拒绝", async () => {
  const { project, file } = await fixture();
  for (const runId of [
    "../escaped",
    "",
    "-".repeat(36),
    "a".repeat(36),
    randomUUID() + "/../x",
  ]) {
    await assert.rejects(
      admitQa(project.key, question, result([doc(file)]), runId),
      /运行ID无效/,
    );
  }
  assert.deepEqual(await listQa(project.key), []);
  const entries = await readdir(projectDir(project.key));
  assert.equal(entries.includes("qa-attempts"), false);
});

test("状态修改与内容不变保存保留provenance，question/answer/aliases变更清除旧证据", async () => {
  const { project, file } = await fixture();
  const provenance = { runId: randomUUID(), evidence: [doc(file)] };
  const source = {
    guideId: randomUUID(),
    moduleId: "search",
    documentId: randomUUID(),
    references: [],
  };
  const original = await saveQa(
    project.key,
    { question, answer, aliases: ["怎么搜索？"] },
    source,
    "public",
    provenance,
  );
  const verified = await updateQaState(project.key, original.id, {
    status: "verified",
    enabled: false,
  });
  assert.deepEqual(verified.provenance, provenance);
  const unchanged = await saveQa(project.key, {
    ...verified,
    question: " " + question + " ",
  });
  assert.deepEqual(unchanged.provenance, provenance);
  assert.equal(unchanged.enabled, false);
  assert.deepEqual(unchanged.source, source);
  assert.equal(unchanged.origin, "public");
  for (const patch of [
    { question: "另一个问题" },
    { answer: "人工编辑后的答案" },
    { aliases: ["不同别名"] },
  ]) {
    const seeded = await saveQa(
      project.key,
      { question, answer, aliases: ["原别名"] },
      undefined,
      "public",
      provenance,
    );
    // An untrusted HTTP-shaped input cannot inject provenance via its body.
    const input = {
      ...seeded,
      ...patch,
      provenance: { runId: randomUUID(), evidence: [page()] },
    };
    const edited = await saveQa(project.key, input);
    assert.equal(edited.provenance, undefined);
    const persisted = (await listQa(project.key)).find(
      (q) => q.id === seeded.id,
    )!;
    assert.equal(persisted.provenance, undefined);
  }
  const replacement = { runId: randomUUID(), evidence: [page()] };
  const refreshed = await saveQa(
    project.key,
    { ...original, answer: "有新证据的内容" },
    undefined,
    undefined,
    replacement,
  );
  assert.deepEqual(refreshed.provenance, replacement);
  assert.deepEqual(refreshed.source, source);
  assert.equal(refreshed.origin, "public");
  const forged = { question: "伪造问题", answer, provenance };
  assert.equal((await saveQa(project.key, forged)).provenance, undefined);
});
