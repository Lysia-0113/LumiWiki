import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ensure } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";
import { renderGuideHtml } from "./guide-html.js";
import type { UserDocument } from "./documents.js";

const text = () => Type.String({ minLength: 1, maxLength: 12000 });
const key = () => Type.String({ pattern: "^[a-z0-9-]{1,64}$" });
export const chapterSchema = Type.Object(
  {
    id: key(),
    title: text(),
    goal: text(),
    scope: Type.Array(text(), { minItems: 1, maxItems: 40 }),
    questions: Type.Array(text(), { minItems: 1, maxItems: 40 }),
    prerequisites: Type.Optional(Type.Array(text(), { maxItems: 40 })),
    entryUrls: Type.Optional(Type.Array(text(), { maxItems: 20 })),
    wikiPageIds: Type.Optional(Type.Array(text(), { maxItems: 40 })),
    dependsOn: Type.Optional(Type.Array(key(), { maxItems: 63 })),
    readingPrerequisites: Type.Optional(Type.Array(key(), { maxItems: 63 })),
  },
  { additionalProperties: false },
);
export const outlineSchema = Type.Object(
  {
    title: text(),
    audience: text(),
    overview: text(),
    glossary: Type.Optional(
      Type.Array(
        Type.Object(
          { term: text(), meaning: text() },
          { additionalProperties: false },
        ),
        { maxItems: 80 },
      ),
    ),
    chapters: Type.Array(chapterSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type GuideOutline = Static<typeof outlineSchema>;
export type ChapterSpec = Static<typeof chapterSchema>;
export type ChapterStatus =
  | "pending"
  | "running"
  | "generated"
  | "blocked"
  | "failed";
export interface GuidePhaseMetrics {
  phase: "planner" | "chapter" | "writer";
  chapterId?: string;
  startedAt: string;
  elapsedMs: number;
  modelCalls: number;
  modelWaitMs: number;
  compactionMs?: number;
  compactions?: number;
  toolCalls: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
}
export interface ChapterState {
  spec: ChapterSpec;
  status: ChapterStatus;
  attempts: number;
  version: number;
  lease?: string;
  documentId?: string;
  evidenceId?: string;
  stage?: "exploring" | "writing";
  reason?: string;
  limitations: string[];
  coverageComplete?: boolean;
  handoff?: ChapterHandoff;
  lastAttempt?: {
    sessionId: string;
    toolCalls: number;
    writes: number;
    pendingAction?: string;
    verification: unknown;
  };
}
export interface ChapterHandoff {
  summary: string;
  facts: Array<{ name: string; value: string }>;
}
export interface GuideTask {
  id: string;
  guideId: string;
  projectId: string;
  question: string;
  kind: "chapter-guide";
  status:
    | "planning"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  outline?: GuideOutline;
  outlineRevision: number;
  revisions: Array<{ at: string; reason: string; chapterIds: string[] }>;
  chapters: ChapterState[];
  toolCalls: number;
  performance?: GuidePhaseMetrics[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

type Emit = (event: Record<string, unknown>) => void;
const active = new Set<string>();
const taskKey = (projectId: string, id: string) =>
  `${projectDir(projectId)}:${id}`;
export function guideTaskActive(projectId: string, id: string) {
  return active.has(taskKey(projectId, id));
}
export function acquireGuideTask(projectId: string, id: string) {
  const key = taskKey(projectId, id);
  ensure(!active.has(key), "指南任务正在执行", 409);
  active.add(key);
  return () => active.delete(key);
}

export class GuideWorkflow {
  constructor(
    readonly task: GuideTask,
    private readonly emit: Emit = () => {},
  ) {}

  static create(projectId: string, question: string, emit?: Emit) {
    const now = new Date().toISOString();
    return new GuideWorkflow(
      {
        id: randomUUID(),
        guideId: randomUUID(),
        projectId,
        question,
        kind: "chapter-guide",
        status: "planning",
        outlineRevision: 0,
        revisions: [],
        chapters: [],
        toolCalls: 0,
        createdAt: now,
        updatedAt: now,
      },
      emit,
    );
  }

  static async load(projectId: string, id: string, emit?: Emit) {
    ensure(validId(id), "指南任务ID无效");
    const task = await json<GuideTask>(
      path.join(projectDir(projectId), "runs", id + ".json"),
    );
    ensure(
      task.kind === "chapter-guide" &&
        task.projectId === projectId &&
        task.id === id,
      "指南任务不属于当前项目",
    );
    ensure(validId(task.guideId), "指南标识无效");
    return new GuideWorkflow(task, emit);
  }

  async save(announce = true) {
    this.task.updatedAt = new Date().toISOString();
    await atomic(
      path.join(
        projectDir(this.task.projectId),
        "runs",
        this.task.id + ".json",
      ),
      this.task,
    );
    if (announce)
      this.emit({ type: "guide_workflow", task: structuredClone(this.task) });
  }

  setOutline(outline: GuideOutline) {
    ensure(!this.task.outline, "目录已确定；新发现请使用目录修订工具");
    this.validateOutline(outline);
    this.task.outline = structuredClone(outline);
    this.task.chapters = outline.chapters.map((spec) => ({
      spec: structuredClone(spec),
      status: "pending",
      attempts: 0,
      version: 1,
      limitations: [],
    }));
    this.task.outlineRevision = 1;
    this.task.status = "running";
  }

  revise(
    reason: string,
    additions: ChapterSpec[],
    updates: ChapterSpec[] = [],
  ) {
    ensure(this.task.outline, "请先建立目录");
    ensure(
      reason.trim().length >= 5 && (additions.length || updates.length),
      "目录修订需要具体原因和章节",
    );
    const ids = [...additions, ...updates].map((s) => s.id);
    ensure(new Set(ids).size === ids.length, "目录修订的章节ID重复");
    for (const spec of additions)
      ensure(
        !this.task.chapters.some((c) => c.spec.id === spec.id),
        "新增章节ID已经存在",
      );
    for (const spec of updates)
      ensure(
        this.task.chapters.some(
          (c) => c.spec.id === spec.id && c.status === "pending",
        ),
        "只能修订尚未执行的章节，不能改写已执行的验收范围",
      );
    const specs = this.task.chapters
      .map((c) => updates.find((s) => s.id === c.spec.id) || c.spec)
      .concat(additions);
    const outline = { ...this.task.outline, chapters: specs };
    this.validateOutline(outline);
    this.task.outline = structuredClone(outline);
    for (const spec of updates) {
      const chapter = this.chapter(spec.id);
      chapter.spec = structuredClone(spec);
      chapter.version++;
    }
    this.task.chapters.push(
      ...additions.map(
        (spec): ChapterState => ({
          spec: structuredClone(spec),
          status: "pending",
          attempts: 0,
          version: 1,
          limitations: [],
        }),
      ),
    );
    this.task.outlineRevision++;
    this.task.revisions.push({
      at: new Date().toISOString(),
      reason,
      chapterIds: ids,
    });
  }

  private validateOutline(outline: GuideOutline) {
    ensure(Value.Check(outlineSchema, outline), "目录格式无效");
    const ids = new Set(outline.chapters.map((c) => c.id));
    ensure(ids.size === outline.chapters.length, "章节ID重复");
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      ensure(!visiting.has(id), "章节依赖不能成环");
      if (visited.has(id)) return;
      visiting.add(id);
      const chapter = outline.chapters.find((c) => c.id === id)!;
      ensure(
        new Set(chapter.questions).size === chapter.questions.length,
        "章节待解答问题不能重复",
      );
      const reading = chapter.readingPrerequisites || [];
      ensure(
        new Set(reading).size === reading.length &&
          reading.every((reference) => ids.has(reference) && reference !== id),
        "阅读前置章节不存在、重复或引用自身",
      );
      const deps = chapter.dependsOn || [];
      ensure(
        new Set(deps).size === deps.length &&
          deps.every((dep) => ids.has(dep) && dep !== id),
        "章节依赖不存在、重复或引用自身",
      );
      deps.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    ids.forEach(visit);
  }

  chapter(id: string) {
    const chapter = this.task.chapters.find((c) => c.spec.id === id);
    ensure(chapter, "章节不在当前目录中");
    return chapter;
  }

  resume(retryChapterIds?: string[]) {
    delete this.task.error;
    const retry = new Set(
      retryChapterIds ||
        this.task.chapters
          .filter(
            (c) => c.status !== "generated" || c.coverageComplete === false,
          )
          .map((c) => c.spec.id),
    );
    for (const id of retry) this.chapter(id);
    // A changed producer invalidates consumers' handoffs, not unrelated completed chapters.
    let changed = true;
    while (changed) {
      changed = false;
      for (const chapter of this.task.chapters)
        if (
          !retry.has(chapter.spec.id) &&
          (chapter.spec.dependsOn || []).some((id) => retry.has(id))
        ) {
          retry.add(chapter.spec.id);
          changed = true;
        }
    }
    for (const chapter of this.task.chapters) {
      if (retry.has(chapter.spec.id)) {
        if (chapter.documentId) {
          chapter.version++;
          chapter.evidenceId = undefined;
        }
        chapter.stage = undefined;
        chapter.status = "pending";
        chapter.lease = undefined;
        chapter.documentId = undefined;
        chapter.handoff = undefined;
        // Keep previous attempt facts so a fresh session checks real state instead of replaying writes.
      }
    }
    this.task.status = this.task.outline ? "running" : "planning";
  }

  next() {
    return this.task.chapters.find(
      (chapter) =>
        chapter.status === "pending" &&
        (chapter.spec.dependsOn || []).every(
          (id) => this.chapter(id).status === "generated",
        ),
    );
  }

  begin(id: string) {
    const chapter = this.chapter(id);
    ensure(chapter.status === "pending", "章节不是待执行状态");
    ensure(
      (chapter.spec.dependsOn || []).every(
        (dep) => this.chapter(dep).status === "generated",
      ),
      "依赖章节尚未生成",
    );
    chapter.status = "running";
    chapter.stage = chapter.evidenceId ? "writing" : "exploring";
    chapter.attempts++;
    chapter.lease = randomUUID();
    chapter.reason = undefined;
    chapter.limitations = [];
    return chapter.lease;
  }

  assertLease(id: string, lease: string) {
    const chapter = this.chapter(id);
    ensure(
      chapter.status === "running" && chapter.lease === lease,
      "章节任务已失效，拒绝旧任务写入",
    );
    return chapter;
  }

  complete(
    id: string,
    lease: string,
    documentId: string,
    handoff: ChapterHandoff,
    limitations: string[] = [],
    coverageComplete = true,
  ) {
    const chapter = this.assertLease(id, lease);
    ensure(validId(documentId), "章节文档ID无效");
    chapter.status = "generated";
    chapter.documentId = documentId;
    chapter.handoff = structuredClone(handoff);
    chapter.limitations = [...limitations];
    chapter.coverageComplete = coverageComplete;
    chapter.lease = undefined;
  }

  fail(id: string, lease: string, reason: string, blocked = false) {
    const chapter = this.assertLease(id, lease);
    chapter.status = blocked ? "blocked" : "failed";
    chapter.reason = reason;
    chapter.lease = undefined;
  }

  blockUnresolved() {
    for (const chapter of this.task.chapters.filter(
      (c) => c.status === "pending",
    )) {
      chapter.status = "blocked";
      chapter.reason = `依赖章节未完成：${(chapter.spec.dependsOn || []).filter((dep) => this.chapter(dep).status !== "generated").join("、")}`;
    }
  }

  brief(id: string) {
    ensure(this.task.outline, "缺少目录");
    const chapter = this.chapter(id);
    return {
      guide: {
        title: this.task.outline.title,
        audience: this.task.outline.audience,
        overview: this.task.outline.overview,
        glossary: this.task.outline.glossary,
      },
      chapter: chapter.spec,
      directory: this.task.chapters.map((c) => ({
        id: c.spec.id,
        title: c.spec.title,
        status: c.status,
      })),
      dependencies: (chapter.spec.dependsOn || []).map((dep) => {
        const source = this.chapter(dep);
        return {
          chapterId: dep,
          documentId: source.documentId,
          handoff: source.handoff,
        };
      }),
      previousAttempt: chapter.lastAttempt
        ? {
            writes: chapter.lastAttempt.writes,
            pendingAction: chapter.lastAttempt.pendingAction,
            reason: chapter.reason,
            instruction:
              "上一轮可能已改变业务数据。先观察并核对真实状态，不能直接重放提交；数据或授权无法确认时记录受阻。",
          }
        : undefined,
    };
  }

  async assemble() {
    ensure(this.task.outline, "没有目录，不能发布指南");
    ensure(
      !this.task.chapters.some((c) =>
        ["pending", "running"].includes(c.status),
      ),
      "还有未执行的章节，不能组装",
    );
    const root = projectDir(this.task.projectId);
    const generated = this.task.chapters.filter(
      (c) => c.status === "generated",
    );
    const limitations = this.task.chapters.flatMap((c) =>
      c.status === "generated"
        ? c.limitations.map((s) => `${c.spec.title}：${s}`)
        : [`${c.spec.title}：${c.reason || "尚未完成"}`],
    );
    if (!generated.length) {
      this.task.status = "failed";
      this.task.error ||=
        "没有通过核验并保存的章节；任务已保留，可修复前置条件后继续。";
      await this.save();
      return undefined;
    }
    const parts = await Promise.all(
      generated.map(async (chapter) => {
        ensure(
          chapter.documentId && validId(chapter.documentId),
          "章节文档ID无效",
        );
        const doc = await json<UserDocument>(
          path.join(root, "documents", chapter.documentId + ".json"),
        );
        ensure(
          doc.moduleId === chapter.spec.id &&
            doc.guideTaskId === this.task.id &&
            doc.chapterVersion === chapter.version,
          "章节文档归属或版本不匹配",
        );
        const [html, md] = await Promise.all(
          ["html", "md"].map((ext) =>
            readFile(
              path.join(root, "documents", chapter.documentId + "." + ext),
              "utf8",
            ),
          ),
        );
        return { id: chapter.spec.id, title: chapter.spec.title, html, md, presentation: doc.presentation };
      }),
    );
    const functional = parts.every((part) => part.presentation === "functional_overview");
    const visibleLimitations = functional ? [] : limitations;
    const complete =
      generated.length === this.task.chapters.length &&
      generated.every((c) => c.coverageComplete !== false);
    this.task.status = complete ? "completed" : "partial";
    const guide = {
      id: this.task.guideId,
      taskId: this.task.id,
      ...(functional ? { presentation: "functional_overview" as const } : {}),
      title: this.task.outline.title,
      audience: this.task.outline.audience,
      overview: this.task.outline.overview,
      complete,
      status: this.task.status,
      reviewStatus: "draft",
      outlineRevision: this.task.outlineRevision,
      modules: this.task.chapters.map((c) => ({
        id: c.spec.id,
        title: c.spec.title,
        documentId: c.documentId,
        reason: c.reason,
        version: c.version,
      })),
      limitations,
      verification: {
        level: "ui-checks",
        contractReview: "draft",
        chapters: this.task.chapters.map((c) => ({
          id: c.spec.id,
          status: c.status,
          documentId: c.documentId,
        })),
      },
      createdAt: this.task.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // Publish metadata last: only point readers at a bundle once both rendered formats exist.
    await atomic(
      path.join(root, "guides", guide.id + ".html"),
      renderGuideHtml(guide.title, parts, visibleLimitations, {
        overview: guide.overview,
        ...(functional ? {} : { audience: guide.audience }),
      }),
      true,
    );
    await atomic(
      path.join(root, "guides", guide.id + ".md"),
      `# ${guide.title}\n\n${guide.overview}\n\n## 目录\n\n${parts.map((p, i) => `${i + 1}. [${p.title}](#chapter-${p.id})`).join("\n")}\n\n${visibleLimitations.length ? `## 使用限制与未完成范围\n\n${visibleLimitations.map((s) => `- ${s}`).join("\n")}\n\n` : ""}${parts.map((p) => `<a id="chapter-${p.id}"></a>\n\n${p.md}`).join("\n\n---\n\n")}`,
      true,
    );
    let qaGeneration: unknown;
    try {
      const previous = await json<{
        modules?: Array<{ id: string; documentId?: string }>;
        qaGeneration?: unknown;
      }>(path.join(root, "guides", guide.id + ".json"));
      if (
        JSON.stringify(previous.modules?.map((m) => [m.id, m.documentId])) ===
        JSON.stringify(guide.modules.map((m) => [m.id, m.documentId]))
      )
        qaGeneration = previous.qaGeneration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomic(path.join(root, "guides", guide.id + ".json"), {
      ...guide,
      ...(qaGeneration ? { qaGeneration } : {}),
    });
    await this.save();
    this.emit({ type: "guide", guide });
    return guide;
  }
}
