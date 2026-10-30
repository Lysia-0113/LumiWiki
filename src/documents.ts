import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensure } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";
import type { AnnotationLegendItem } from "./artifacts.js";

export interface DocumentReference {
  kind: "page" | "doc";
  location: string;
}
export interface DocumentImage {
  imageId: string;
  caption?: string;
}
export interface DocumentTroubleshooting {
  problem: string;
  solution: string;
}
/** Optional chapter-level reader guidance. Text is not truncated by the exporter. */
export interface DocumentContent {
  audience?: string[];
  prerequisites?: string[];
  details?: string;
  outcomes?: string[];
  troubleshooting?: DocumentTroubleshooting[];
  limitations?: string[];
}
export interface DocumentStep {
  title: string;
  instruction: string;
  expectedResult?: string;
  /** Legacy single image. If both forms are present it appears first, once. */
  imageId?: string;
  images?: DocumentImage[];
}
export interface UserDocument extends DocumentContent {
  id: string;
  title: string;
  summary: string;
  presentation?: "functional_overview";
  steps: DocumentStep[];
  references: DocumentReference[];
  [key: string]: unknown;
}
/** Supplied by the artifact loader, never taken from document/tool input. */
export type DocumentLegendItem = Pick<
  AnnotationLegendItem,
  "number" | "label" | "description"
>;
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const documentStyle = `body{max-width:900px;margin:32px auto;padding:24px;font:16px/1.75 system-ui;color:#243329;overflow-wrap:anywhere}h1{font-size:30px}h2{font-size:23px}h3{font-size:20px}p,dt,dd,li{white-space:pre-wrap}img{display:block;max-width:100%;height:auto;margin:18px 0;border:1px solid #e1e7df;border-radius:8px}figure{margin:24px 0}figcaption{padding:0 8px}.annotation-legend{margin:12px 0}.annotation-legend dt{font-weight:600}.annotation-legend dd{margin:4px 0 14px 20px}section{margin:32px 0}a{color:#286451}nav,aside{padding:16px 20px;background:#f3f6ef;border-radius:10px}@media print{body{margin:0}img{break-inside:avoid}h2,h3,h4{break-after:avoid}}`;

/** Merge the legacy field and the ordered list without displaying duplicates. */
export function documentStepImages(step: DocumentStep): DocumentImage[] {
  ensure(
    step.images === undefined || Array.isArray(step.images),
    "步骤 images 必须是图片数组",
  );
  const images = new Map<string, DocumentImage>();
  if (step.imageId !== undefined)
    images.set(step.imageId, { imageId: step.imageId });
  for (const image of step.images || []) {
    ensure(image && typeof image.imageId === "string", "图片必须包含 imageId");
    ensure(
      image.caption === undefined || typeof image.caption === "string",
      "图片 caption 必须是文本",
    );
    const previous = images.get(image.imageId);
    images.set(image.imageId, {
      imageId: image.imageId,
      ...(previous?.caption !== undefined
        ? { caption: previous.caption }
        : image.caption !== undefined
          ? { caption: image.caption }
          : {}),
    });
  }
  return [...images.values()];
}

// Plain text, not model-authored HTML/Markdown. Preserve all paragraphs but prevent
// embedded HTML and Markdown image/link syntax from turning into active content.
const markdownText = (text: string) =>
  escapeHtml(text.replace(/[\\`*_[\]{}()#+.!|>-]/g, "\\$&"));

function validateLegend(legend: readonly DocumentLegendItem[]) {
  ensure(
    Array.isArray(legend) && legend.length > 0,
    "编号图片缺少结构化 legend，请重新标注原图",
  );
  const numbers = new Set<number>();
  for (const item of legend) {
    ensure(
      item &&
        Number.isSafeInteger(item.number) &&
        item.number > 0 &&
        !numbers.has(item.number) &&
        typeof item.label === "string" &&
        (item.description === undefined ||
          typeof item.description === "string"),
      "图片 legend 无效：编号必须是唯一正整数，说明必须是文本；请重新标注原图",
    );
    numbers.add(item.number);
  }
}

// Audit details and citations remain in JSON. Reader-facing guidance and expected
// results are exported in full; no fixed step, paragraph or screenshot count.
export function renderDocument(
  doc: UserDocument,
  images: ReadonlyMap<string, string>,
  legends: ReadonlyMap<string, readonly DocumentLegendItem[]> = new Map(),
) {
  const functional = doc.presentation === "functional_overview";
  const html: string[] = [
    `<h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.summary)}</p>`,
  ];
  const md: string[] = [
    `# ${markdownText(doc.title)}\n\n${markdownText(doc.summary)}`,
  ];
  const list = (title: string, values?: string[]) => {
    if (!values?.length) return;
    html.push(
      `<section><h2>${title}</h2><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul></section>`,
    );
    md.push(
      `## ${title}\n\n${values.map((value) => `- ${markdownText(value).replace(/\n/g, "\n  ")}`).join("\n")}`,
    );
  };
  if (!functional) {
    list("适用读者", doc.audience);
    list("开始前准备", doc.prerequisites);
  }
  if (doc.details) {
    html.push(
      functional ? `<p>${escapeHtml(doc.details)}</p>` : `<section><h2>详细说明</h2><p>${escapeHtml(doc.details)}</p></section>`,
    );
    md.push(`${functional ? "" : "## 详细说明\n\n"}${markdownText(doc.details)}`);
  }
  doc.steps.forEach((step, i) => {
    const prefix = functional ? "" : `${i + 1}. `;
    html.push(
      `<section><h2>${prefix}${escapeHtml(step.title)}</h2><p>${escapeHtml(step.instruction)}</p>`,
    );
    md.push(
      `## ${prefix}${markdownText(step.title)}\n\n${markdownText(step.instruction)}`,
    );
    if (!functional && step.expectedResult) {
      html.push(
        `<p class="expected-result"><strong>预期结果：</strong>${escapeHtml(step.expectedResult)}</p>`,
      );
      md.push(`**预期结果：** ${markdownText(step.expectedResult)}`);
    }
    for (const image of documentStepImages(step)) {
      const src = images.get(image.imageId);
      ensure(
        typeof src === "string" && src.length > 0,
        `图片 ${image.imageId} 缺少内容，不能导出不完整的文档`,
      );
      const legend = legends.get(image.imageId);
      if (legend !== undefined) validateLegend(legend);
      html.push(
        `<figure><img alt="${escapeHtml(image.caption || step.title)}" src="${escapeHtml(src)}">`,
      );
      md.push(
        `![${markdownText(image.caption || step.title)}](<${src.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}>)`,
      );
      if (image.caption || legend) {
        html.push("<figcaption>");
        if (image.caption) {
          html.push(`<p>${escapeHtml(image.caption)}</p>`);
          md.push(markdownText(image.caption));
        }
        if (legend) {
          html.push(
            `<dl class="annotation-legend" aria-label="截图编号说明">${legend.map((item) => `<div><dt>${item.number}. ${escapeHtml(item.label)}</dt>${item.description ? `<dd>${escapeHtml(item.description)}</dd>` : ""}</div>`).join("")}</dl>`,
          );
          md.push(
            `**截图编号说明**\n\n${legend.map((item) => `${item.number}. ${markdownText(item.label)}${item.description ? `\n\n   ${markdownText(item.description).replace(/\n/g, "\n   ")}` : ""}`).join("\n\n")}`,
          );
        }
        html.push("</figcaption>");
      }
      html.push("</figure>");
    }
    html.push("</section>");
  });
  if (!functional) list("完成后你将获得", doc.outcomes);
  if (!functional && doc.troubleshooting?.length) {
    html.push(
      `<section><h2>常见问题与处理</h2><dl>${doc.troubleshooting.map((item) => `<div><dt>${escapeHtml(item.problem)}</dt><dd>${escapeHtml(item.solution)}</dd></div>`).join("")}</dl></section>`,
    );
    md.push(
      `## 常见问题与处理\n\n${doc.troubleshooting.map((item) => `### ${markdownText(item.problem)}\n\n${markdownText(item.solution)}`).join("\n\n")}`,
    );
  }
  if (!functional) list("适用范围与限制", doc.limitations);
  return {
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(doc.title)}</title><style>${documentStyle}</style><main>${html.join("")}</main></html>`,
    md: md.join("\n\n") + "\n",
  };
}

export async function writeDocument(projectId: string, doc: UserDocument) {
  ensure(typeof doc.id === "string" && validId(doc.id), "文档ID无效");
  const root = projectDir(projectId);
  const selected = doc.steps.flatMap(documentStepImages);
  // Validate the complete list before touching the filesystem, including IDs in
  // the new multi-image form. An image ID can never be a path or URL.
  for (const image of selected)
    ensure(
      typeof image.imageId === "string" && validId(image.imageId),
      "图片ID无效",
    );
  const images = new Map<string, string>();
  const legends = new Map<string, readonly DocumentLegendItem[]>();
  for (const { imageId } of selected) {
    if (images.has(imageId)) continue;
    const file = path.join(root, "artifacts", imageId);
    const artifact = await json<{
      id: string;
      kind: string;
      sourceId?: string;
      legend?: DocumentLegendItem[];
    }>(file + ".json");
    ensure(
      artifact.id === imageId &&
        ["screenshot", "annotated"].includes(artifact.kind),
      "只能引用已保存的截图或标注图片",
    );
    if (artifact.kind === "annotated") {
      ensure(
        typeof artifact.sourceId === "string" && validId(artifact.sourceId),
        "标注图片的原图ID无效",
      );
      ensure(
        artifact.legend !== undefined,
        "编号图片缺少结构化 legend，请重新标注原图",
      );
      validateLegend(artifact.legend);
      legends.set(imageId, artifact.legend);
    }
    images.set(
      imageId,
      `data:image/png;base64,${(await readFile(file + ".png")).toString("base64")}`,
    );
  }
  const rendered = renderDocument(doc, images, legends);
  const figureLegends = Object.fromEntries(
    [...legends].map(([imageId, items]) => [
      imageId,
      items.map(({ number, label, description }) => ({
        number,
        label,
        ...(description ? { description } : {}),
      })),
    ]),
  );
  await atomic(path.join(root, "documents", doc.id + ".md"), rendered.md, true);
  await atomic(
    path.join(root, "documents", doc.id + ".html"),
    rendered.html,
    true,
  );
  // Metadata is the commit marker; derived text lets initial QA read the same
  // explanations as users without loading image bytes or model-authored legends.
  await atomic(path.join(root, "documents", doc.id + ".json"), {
    ...doc,
    figureLegends,
  });
}
