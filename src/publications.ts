import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config, ensure, HttpError } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";
import { documentStepImages } from "./documents.js";

export type PublicationKind = "guides" | "documents";
export interface PublishedStep {
  title: string;
  instruction: string;
  expectedResult?: string;
  imageId?: string;
  images?: Array<{ imageId: string; caption?: string }>;
}
export interface PublishedGuide {
  id: string;
  title: string;
  summary: string;
  audience?: string[];
  prerequisites?: string[];
  modules: Array<{
    title: string;
    summary: string;
    steps: PublishedStep[];
    troubleshooting?: Array<{ problem: string; solution: string }>;
    limitations?: string[];
  }>;
  limitations: string[];
  version: number;
  publishedAt: string;
}
export interface Publication {
  id: string;
  kind: PublicationKind;
  title: string;
  summary: string;
  moduleCount: number;
  status: "published" | "withdrawn";
  version: number;
  reviewedAt: string;
  publishedAt: string;
  withdrawnAt?: string;
  sourceHash: string;
}
const writes = new Map<string, Promise<unknown>>();
async function serial<T>(
  projectId: string,
  id: string,
  work: () => Promise<T>,
) {
  const key = `${config.data}:${projectId}:${id}`;
  const task = (writes.get(key) || Promise.resolve())
    .catch(() => {})
    .then(work);
  writes.set(key, task);
  try {
    return await task;
  } finally {
    if (writes.get(key) === task) writes.delete(key);
  }
}
const directory = (projectId: string) =>
  path.join(projectDir(projectId), "publications");
const metadataFile = (projectId: string, id: string) =>
  path.join(directory(projectId), id + ".json");
const versionDir = (projectId: string, id: string, version: number) =>
  path.join(directory(projectId), id, "v" + version);
const hash = (input: string | Buffer) =>
  createHash("sha256").update(input).digest("hex");
function text(value: unknown, label: string, optional = false) {
  ensure(
    typeof value === "string" && (optional || value.trim().length > 0),
    `${label}不完整，不能发布`,
    409,
  );
  return value;
}
async function record(
  projectId: string,
  id: string,
): Promise<Publication | null> {
  ensure(validId(id), "指南不存在", 404);
  try {
    return await json<Publication>(metadataFile(projectId, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function publicationInfo(publication: Publication) {
  const { sourceHash: _hash, ...info } = publication;
  return info;
}
export async function listPublications(projectId: string) {
  let files: string[];
  try {
    files = await readdir(directory(projectId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = await Promise.all(
    files
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => json<Publication>(path.join(directory(projectId), name))),
  );
  return rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
export async function publishGuide(
  projectId: string,
  kind: PublicationKind,
  id: string,
  reviewed: boolean,
) {
  ensure(reviewed === true, "请先确认已审核指南内容和截图", 400);
  ensure(kind === "guides" || kind === "documents", "产物类型无效");
  ensure(validId(id), "产物标识无效");
  return serial(projectId, id, async () => {
    const previous = await record(projectId, id);
    ensure(!previous || previous.kind === kind, "产物标识冲突", 409);
    const root = projectDir(projectId);
    let source: any;
    try {
      source = await json(path.join(root, kind, id + ".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new HttpError(404, "产物不存在");
      throw error;
    }
    const title = text(source.title, "标题");
    const limitations: string[] = (source.limitations || []).map(
      (value: unknown) => text(value, "限制说明"),
    );
    const documents: Array<{ title: string; doc: any }> = [];
    if (kind === "documents") documents.push({ title, doc: source });
    else {
      ensure(Array.isArray(source.modules), "指南模块不完整", 409);
      for (const module of source.modules) {
        if (!module.documentId) {
          limitations.push(
            `${text(module.title, "模块标题")}：${text(module.reason, "未完成模块的说明")}`,
          );
          continue;
        }
        ensure(validId(module.documentId), "模块文档标识无效", 409);
        const doc: any = await json(
          path.join(root, "documents", module.documentId + ".json"),
        );
        ensure(doc.moduleId === module.id, "指南模块与文档不匹配", 409);
        documents.push({ title: text(module.title, "模块标题"), doc });
      }
    }
    ensure(documents.length > 0, "没有可供用户阅读的模块，不能发布", 409);
    const images = new Map<string, Buffer>();
    const modules: PublishedGuide["modules"] = [];
    for (const { title: moduleTitle, doc } of documents) {
      ensure(
        Array.isArray(doc.steps) && doc.steps.length > 0,
        "操作步骤不完整",
        409,
      );
      const steps: PublishedStep[] = [];
      for (const step of doc.steps) {
        const item: PublishedStep = {
          title: text(step.title, "步骤标题"),
          instruction: text(step.instruction, "操作说明"),
        };
        if (step.expectedResult)
          item.expectedResult = text(step.expectedResult, "预期结果", true);
        const selected = documentStepImages(step);
        for (const image of selected) {
          ensure(validId(image.imageId), "截图标识无效", 409);
          if (!images.has(image.imageId)) {
            let bytes: Buffer;
            try {
              bytes = await readFile(
                path.join(root, "artifacts", image.imageId + ".png"),
              );
            } catch {
              throw new HttpError(409, "指南截图缺失，修复后才能发布");
            }
            ensure(
              bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
              "截图不是有效的 PNG 图片",
              409,
            );
            images.set(image.imageId, bytes);
          }
        }
        if (selected.length) {
          item.imageId = selected[0].imageId;
          item.images = selected.map(({ imageId, caption }) => ({
            imageId,
            ...(caption ? { caption } : {}),
          }));
        }
        steps.push(item);
      }
      modules.push({
        title: moduleTitle,
        summary: text(doc.summary || "", "模块说明", true),
        steps,
        ...(Array.isArray(doc.troubleshooting) && doc.troubleshooting.length
          ? {
              troubleshooting: doc.troubleshooting.map((item: any) => ({
                problem: text(item.problem, "故障问题", true),
                solution: text(item.solution, "处理办法", true),
              })),
            }
          : {}),
        ...(Array.isArray(doc.limitations) && doc.limitations.length
          ? { limitations: doc.limitations }
          : {}),
      });
    }
    const content = {
      id,
      title,
      ...(Array.isArray(source.audience) && source.audience.length
        ? { audience: source.audience }
        : {}),
      ...(Array.isArray(source.prerequisites) && source.prerequisites.length
        ? { prerequisites: source.prerequisites }
        : {}),
      summary: text(source.summary || source.overview || "", "指南说明", true),
      modules,
      limitations,
    };
    const sourceHash = hash(
      JSON.stringify({
        content,
        images: [...images].map(([imageId, bytes]) => [imageId, hash(bytes)]),
      }),
    );
    if (previous?.status === "published" && previous.sourceHash === sourceHash)
      return publicationInfo(previous);
    const version = (previous?.version || 0) + 1;
    const now = new Date().toISOString();
    const target = versionDir(projectId, id, version);
    await mkdir(target, { recursive: true });
    for (const [imageId, bytes] of images)
      await writeFile(path.join(target, imageId + ".png"), bytes, {
        mode: 0o600,
      });
    // Publish the manifest last. A failed update leaves the prior reviewed version readable.
    await atomic(path.join(target, "snapshot.json"), {
      ...content,
      version,
      publishedAt: now,
    });
    const publication: Publication = {
      id,
      kind,
      title,
      summary: content.summary,
      moduleCount: modules.length,
      status: "published",
      version,
      reviewedAt: now,
      publishedAt: now,
      sourceHash,
    };
    await atomic(metadataFile(projectId, id), publication);
    return publicationInfo(publication);
  });
}
export async function withdrawGuide(projectId: string, id: string) {
  return serial(projectId, id, async () => {
    const publication = await record(projectId, id);
    ensure(publication, "已发布指南不存在", 404);
    publication.status = "withdrawn";
    publication.withdrawnAt = new Date().toISOString();
    await atomic(metadataFile(projectId, id), publication);
    return publicationInfo(publication);
  });
}
async function publishedRecord(projectId: string, id: string) {
  const publication = await record(projectId, id);
  ensure(publication?.status === "published", "指南未发布或已撤回", 404);
  return publication;
}
export async function publicGuides(projectId: string) {
  return (await listPublications(projectId))
    .filter((item) => item.status === "published")
    .map(({ id, title, summary, version, publishedAt, moduleCount }) => ({
      id,
      title,
      summary,
      version,
      publishedAt,
      moduleCount,
    }));
}
export async function publicGuide(
  projectId: string,
  id: string,
): Promise<PublishedGuide> {
  const publication = await publishedRecord(projectId, id);
  return json(
    path.join(versionDir(projectId, id, publication.version), "snapshot.json"),
  );
}
export async function publicGuideImage(
  projectId: string,
  id: string,
  imageId: string,
  version?: number,
) {
  const publication = await publishedRecord(projectId, id);
  ensure(validId(imageId), "图片不存在", 404);
  const revision = version ?? publication.version;
  ensure(
    Number.isSafeInteger(revision) &&
      revision >= 1 &&
      revision <= publication.version,
    "图片版本不存在",
    404,
  );
  const snapshot = await json<PublishedGuide>(
    path.join(versionDir(projectId, id, revision), "snapshot.json"),
  );
  ensure(
    snapshot.modules.some((module) =>
      module.steps.some(
        (step) =>
          step.imageId === imageId ||
          step.images?.some((image) => image.imageId === imageId),
      ),
    ),
    "图片不属于这份公开指南",
    404,
  );
  return readFile(
    path.join(versionDir(projectId, id, revision), imageId + ".png"),
  );
}
