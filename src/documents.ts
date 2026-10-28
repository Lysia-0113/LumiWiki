import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomic, projectDir } from "./store.js";

export interface DocumentReference {
  kind: "page" | "doc";
  location: string;
}
export interface DocumentStep {
  title: string;
  instruction: string;
  expectedResult?: string;
  imageId?: string;
}
export interface UserDocument {
  id: string;
  title: string;
  summary: string;
  steps: DocumentStep[];
  references: DocumentReference[];
  [key: string]: unknown;
}
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const documentStyle = `body{max-width:900px;margin:32px auto;padding:24px;font:16px/1.75 system-ui;color:#243329}h1{font-size:30px}h2{font-size:23px}h3{font-size:20px}p{white-space:pre-wrap}img{display:block;max-width:100%;height:auto;margin:18px 0 28px;border:1px solid #e1e7df;border-radius:8px}section{margin:32px 0}a{color:#286451}nav,aside{padding:16px 20px;background:#f3f6ef;border-radius:10px}@media print{body{margin:0}img{break-inside:avoid}h2,h3{break-after:avoid}}`;

// Audit details and citations remain in JSON. The exported guide shows the task.
export function renderDocument(doc: UserDocument, images: Map<string, string>) {
  const body =
    `<h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.summary)}</p>` +
    doc.steps
      .map(
        (s, i) =>
          `<section><h2>${i + 1}. ${escapeHtml(s.title)}</h2><p>${escapeHtml(s.instruction)}</p>${s.imageId ? `<img alt="${escapeHtml(s.title)}" src="${images.get(s.imageId)}">` : ""}</section>`,
      )
      .join("");
  return {
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(doc.title)}</title><style>${documentStyle}</style><main>${body}</main></html>`,
    md:
      `# ${doc.title}\n\n${doc.summary}\n\n` +
      doc.steps
        .map(
          (s, i) =>
            `## ${i + 1}. ${s.title}\n\n${s.instruction}\n${s.imageId ? `\n![${s.title}](${images.get(s.imageId)})\n` : ""}`,
        )
        .join("\n"),
  };
}
export async function writeDocument(projectId: string, doc: UserDocument) {
  const root = projectDir(projectId);
  const images = new Map<string, string>();
  for (const s of doc.steps)
    if (s.imageId && !images.has(s.imageId))
      images.set(
        s.imageId,
        `data:image/png;base64,${(await readFile(path.join(root, "artifacts", s.imageId + ".png"))).toString("base64")}`,
      );
  const rendered = renderDocument(doc, images);
  await atomic(path.join(root, "documents", doc.id + ".json"), doc);
  await atomic(path.join(root, "documents", doc.id + ".md"), rendered.md, true);
  await atomic(
    path.join(root, "documents", doc.id + ".html"),
    rendered.html,
    true,
  );
}
