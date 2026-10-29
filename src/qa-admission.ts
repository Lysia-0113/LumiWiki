import path from "node:path";
import { ensure } from "./config.js";
import { listWiki } from "./knowledge.js";
import { listQa, normalize, saveQa, type Qa } from "./qa.js";
import type { QaAnswerResult, QaEvidence } from "./qa-result.js";
import { atomic, projectDir } from "./store.js";

export type QaAdmissionResult = {
  decision: "admitted" | "candidate" | "duplicate" | "skipped" | "conflict";
  reason: string;
  qa?: Qa;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const admissions = new Map<string, Promise<unknown>>();

// Include the data root in the key: isolated stores must not share a queue.
async function serialized<T>(root: string, operation: () => Promise<T>) {
  const pending = admissions.get(root) || Promise.resolve();
  const task = pending.catch(() => {}).then(operation);
  admissions.set(root, task);
  try {
    return await task;
  } finally {
    if (admissions.get(root) === task) admissions.delete(root);
  }
}

function validObservedAt(value: string) {
  if (typeof value !== "string") return false;
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= days[m - 1] &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    (!offsetHour || (Number(offsetHour) < 24 && Number(offsetMinute) < 60))
  );
}

function validPage(evidence: Extract<QaEvidence, { kind: "page" }>) {
  if (
    typeof evidence.location !== "string" ||
    typeof evidence.browserId !== "string" ||
    !uuid.test(evidence.browserId) ||
    !validObservedAt(evidence.observedAt)
  )
    return false;
  try {
    return ["http:", "https:"].includes(new URL(evidence.location).protocol);
  } catch {
    return false;
  }
}

export async function admitQa(
  projectId: string,
  question: string,
  result: QaAnswerResult | undefined,
  runId: string,
  signal?: AbortSignal,
): Promise<QaAdmissionResult> {
  signal?.throwIfAborted();
  ensure(typeof runId === "string" && uuid.test(runId), "运行ID无效");
  ensure(
    typeof question === "string" && question.trim() && question.length <= 16000,
    "问答内容无效",
  );
  const root = path.resolve(projectDir(projectId));
  return serialized(root, async () => {
    signal?.throwIfAborted();
    async function record(
      admission: QaAdmissionResult,
      qaId = admission.qa?.id,
    ) {
      await atomic(path.join(root, "qa-attempts", runId + ".json"), {
        runId,
        question,
        result: result ?? null,
        decision: admission.decision,
        reason: admission.reason,
        qaId,
        createdAt: new Date().toISOString(),
      });
      return admission;
    }
    function decide(admission: QaAdmissionResult, qaId = admission.qa?.id) {
      signal?.throwIfAborted();
      return record(admission, qaId);
    }
    const skip = (reason: string) => decide({ decision: "skipped", reason });
    if (!result) return skip("no_result");
    if (
      result.outcome === "needs_clarification" ||
      result.outcome === "insufficient_evidence"
    )
      return skip(result.outcome);
    if (result.outcome !== "answered") return skip("invalid_result");
    if (result.scope !== "general") return skip("context_specific");
    if (
      typeof result.answer !== "string" ||
      !result.answer.trim() ||
      result.answer.length >= 30000
    )
      return skip("invalid_result");
    if (!Array.isArray(result.evidence) || !result.evidence.length)
      return skip("no_evidence");

    const files = await listWiki(projectId);
    let hasPage = false;
    for (const evidence of result.evidence) {
      if (!evidence || typeof evidence !== "object")
        return skip("invalid_evidence");
      if (evidence.kind === "doc") {
        const file = files.find((file) => file.id === evidence.fileId);
        if (
          !file ||
          file.sha256 !== evidence.sha256 ||
          !file.pages.some((page) => page.id === evidence.location)
        )
          return skip("stale_evidence");
      } else if (evidence.kind === "page") {
        if (!validPage(evidence)) return skip("invalid_page_evidence");
        hasPage = true;
      } else {
        return skip("invalid_evidence");
      }
    }

    const query = normalize(question);
    const existing = (await listQa(projectId)).filter((qa) =>
      [qa.question, ...qa.aliases].some((text) => normalize(text) === query),
    );
    const conflict = existing.find(
      (qa) => qa.answer.trim() !== result.answer.trim(),
    );
    if (conflict)
      return decide(
        { decision: "conflict", reason: "conflicting_answer" },
        conflict.id,
      );
    if (existing.length)
      return decide({
        decision: "duplicate",
        reason: "duplicate",
        qa: existing[0],
      });

    // Check at the commit boundary; once saving starts, always finish its audit.
    signal?.throwIfAborted();
    const qa = await saveQa(
      projectId,
      { question, answer: result.answer, status: "draft", enabled: !hasPage },
      undefined,
      "public",
      { runId, evidence: result.evidence },
    );
    return record({
      decision: hasPage ? "candidate" : "admitted",
      reason: hasPage ? "page_evidence" : "wiki_evidence",
      qa,
    });
  });
}
