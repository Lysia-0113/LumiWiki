import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ensure } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";
import { QuickStartRun } from "./quick-start.js";
import type { DocumentReference } from "./documents.js";
import type { GuideWorkflow, ChapterHandoff } from "./guide-workflow.js";
import type { AnnotationLegendItem } from "./artifacts.js";

export const evidenceReferenceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("page"), Type.Literal("doc")]),
    location: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const coverageSchema = Type.Array(
  Type.Object(
    {
      question: Type.String({ minLength: 1 }),
      status: Type.Union([Type.Literal("covered"), Type.Literal("limited")]),
      explanation: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);
// Stable IDs avoid requiring the model to recopy long question strings exactly.
export const coverageInputSchema = Type.Array(
  Type.Object(
    {
      questionId: Type.Optional(Type.Integer({ minimum: 1 })),
      question: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Union([Type.Literal("covered"), Type.Literal("limited")]),
      explanation: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);
export function normalizeCoverage(
  questions: string[],
  input: Static<typeof coverageInputSchema>,
): ChapterCoverage {
  const coverage = input.map((item) => {
    const question =
      item.questionId === undefined
        ? item.question
        : questions[item.questionId - 1];
    ensure(
      question &&
        (item.questionId === undefined ||
          item.question === undefined ||
          item.question === question),
      "questionId无效或与question不一致，请使用宿主给定的问题编号",
    );
    return { question, status: item.status, explanation: item.explanation };
  });
  validateCoverage(questions, coverage);
  return coverage;
}

export const annotationMarksSchema = Type.Array(
  Type.Object(
    {
      ref: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ maxLength: 80 })),
      description: Type.Optional(Type.String({ minLength: 1 })),
      box: Type.Optional(
        Type.Object({
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number(),
          height: Type.Number(),
        }),
      ),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 20 },
);
export const chapterReadySchema = Type.Object(
  {
    answers: coverageInputSchema,
    references: Type.Array(evidenceReferenceSchema, { minItems: 1 }),
    images: Type.Array(
      Type.Object(
        {
          imageId: Type.String(),
          caption: Type.Optional(Type.String()),
          marks: Type.Optional(annotationMarksSchema),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 40 },
    ),
    limitations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    handoff: Type.Optional(
      Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
        facts: Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1, maxLength: 100 }),
            value: Type.String({ minLength: 1, maxLength: 500 }),
          }),
          { maxItems: 40 },
        ),
      }),
    ),
  },
  { additionalProperties: false },
);
export type ChapterReadyInput = Static<typeof chapterReadySchema>;
export type ChapterCoverage = Static<typeof coverageSchema>;
export interface ChapterEvidence {
  id: string;
  taskId: string;
  projectId: string;
  chapterId: string;
  version: number;
  createdAt: string;
  browserId: string;
  dependencies: Array<{
    chapterId: string;
    version: number;
    documentId?: string;
  }>;
  answers: ChapterCoverage;
  references: DocumentReference[];
  images: Array<{
    imageId: string;
    caption?: string;
    legend?: Array<
      Pick<AnnotationLegendItem, "number" | "label" | "description">
    >;
  }>;
  limitations: string[];
  handoff?: ChapterHandoff;
  verification: ReturnType<QuickStartRun["report"]>;
}

export function validateCoverage(
  questions: string[],
  coverage: ChapterCoverage,
) {
  ensure(
    Value.Check(coverageSchema, coverage) &&
      coverage.every((item) => item.explanation.trim()),
    "章节事实或覆盖说明无效",
  );
  ensure(
    coverage.length === questions.length &&
      new Set(coverage.map((item) => item.question)).size === coverage.length &&
      questions.every((question) =>
        coverage.some((item) => item.question === question),
      ),
    "章节覆盖清单必须逐一回答目录中所有questions，不能漏项或伪造问题",
  );
}

// Restore host-owned, frozen evidence, never model-submitted passed flags.
export function evidenceRun(evidence: ChapterEvidence) {
  ensure(
    evidence.verification?.plan?.modules.length === 1 &&
      evidence.verification.plan.modules[0].id === evidence.chapterId,
    "冻结证据的场景归属不匹配",
  );
  const run = new QuickStartRun();
  run.setPlan(evidence.verification.plan);
  ensure(
    evidence.verification.scenarios.length === run.scenarios.length &&
      run.scenarios.every((expected) =>
        evidence.verification.scenarios.some(
          (state) =>
            state.moduleId === expected.moduleId &&
            state.scenarioId === expected.scenarioId,
        ),
      ),
    "冻结证据的场景清单无效",
  );
  run.runId = evidence.verification.runId;
  run.scenarios = structuredClone(evidence.verification.scenarios);
  run.revision = evidence.verification.revision;
  run.assertDocument(
    evidence.chapterId,
    evidence.images.map((image) => image.imageId),
  );
  return run;
}

export function chapterCanFreeze(run: QuickStartRun, chapterId: string) {
  const images = run.scenarios
    .filter((state) => state.status === "verified")
    .flatMap((state) => [
      ...state.checkpoints.flatMap((checkpoint) => checkpoint.images),
      ...state.outcomes.flatMap((proof) => proof.images),
    ]);
  try {
    run.assertDocument(chapterId, images);
    return Boolean(run.enabled && run.plan);
  } catch {
    return false;
  }
}

export async function saveChapterEvidence(
  workflow: GuideWorkflow,
  chapterId: string,
  lease: string,
  input: Omit<
    ChapterEvidence,
    | "id"
    | "taskId"
    | "projectId"
    | "chapterId"
    | "version"
    | "createdAt"
    | "dependencies"
  >,
) {
  const chapter = workflow.assertLease(chapterId, lease);
  validateCoverage(chapter.spec.questions, input.answers);
  const evidence: ChapterEvidence = {
    ...structuredClone(input),
    id: randomUUID(),
    taskId: workflow.task.id,
    projectId: workflow.task.projectId,
    chapterId,
    version: chapter.version,
    createdAt: new Date().toISOString(),
    dependencies: (chapter.spec.dependsOn || []).map((id) => {
      const source = workflow.chapter(id);
      return {
        chapterId: id,
        version: source.version,
        documentId: source.documentId,
      };
    }),
  };
  evidenceRun(evidence);
  await atomic(
    path.join(
      projectDir(evidence.projectId),
      "chapter-evidence",
      evidence.id + ".json",
    ),
    evidence,
  );
  workflow.assertLease(chapterId, lease);
  chapter.evidenceId = evidence.id;
  chapter.stage = "writing";
  await workflow.save();
  return evidence;
}

export async function loadChapterEvidence(
  workflow: GuideWorkflow,
  chapterId: string,
): Promise<ChapterEvidence | undefined> {
  const chapter = workflow.chapter(chapterId);
  if (!chapter.evidenceId) return undefined;
  ensure(validId(chapter.evidenceId), "章节证据ID无效");
  const evidence = await json<ChapterEvidence>(
    path.join(
      projectDir(workflow.task.projectId),
      "chapter-evidence",
      chapter.evidenceId + ".json",
    ),
  );
  ensure(
    evidence.id === chapter.evidenceId &&
      evidence.taskId === workflow.task.id &&
      evidence.projectId === workflow.task.projectId &&
      evidence.chapterId === chapterId,
    "章节证据归属无效",
  );
  if (
    evidence.version !== chapter.version ||
    evidence.dependencies.some((dependency) => {
      const current = workflow.chapter(dependency.chapterId);
      return (
        current.version !== dependency.version ||
        current.documentId !== dependency.documentId ||
        current.status !== "generated"
      );
    })
  ) {
    chapter.evidenceId = undefined;
    return undefined;
  }
  validateCoverage(chapter.spec.questions, evidence.answers);
  evidenceRun(evidence);
  return evidence;
}

export function writingBrief(
  workflow: GuideWorkflow,
  evidence: ChapterEvidence,
) {
  const chapter = workflow.chapter(evidence.chapterId);
  return {
    phase: "writer",
    presentation: "functional_overview",
    guide: {
      title: workflow.task.outline!.title,
      overview: workflow.task.outline!.overview,
      glossary: workflow.task.outline!.glossary,
    },
    chapter: {
      id: chapter.spec.id,
      title: chapter.spec.title,
      purpose: chapter.spec.goal,
      questions: chapter.spec.questions,
    },
    answers: evidence.answers.map((answer, index) => ({ questionId: index + 1, ...answer })),
    references: evidence.references,
    images: evidence.images,
    writingGoal: "解释页面整体作用、各区域用途、展示内容和字段含义。按功能分节，不按点击顺序。未知项只在coverage中如实保留，不输出验收过程或边界声明。",
  };
}
