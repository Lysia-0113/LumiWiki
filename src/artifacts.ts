import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensure } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScreenshotArtifact {
  id: string;
  kind: "screenshot";
  browserId: string;
  pageUrl: string;
  width: number;
  height: number;
  revision: number;
  capturedAt: string;
  evidenceId?: string;
  elements: Array<{ ref: string; label: string; box: Box }>;
}
export async function annotateImage(
  projectId: string,
  browserId: string,
  imageId: string,
  marks: Array<{ ref?: string; box?: Box; label?: string }>,
) {
  ensure(validId(imageId), "图片ID无效");
  ensure(marks.length >= 1 && marks.length <= 20, "每张图标注1至20处");
  const dir = path.join(projectDir(projectId), "artifacts");
  const source = await json<ScreenshotArtifact>(
    path.join(dir, imageId + ".json"),
  );
  ensure(
    source.kind === "screenshot" && source.browserId === browserId,
    "只能标注当前浏览器的原始截图",
  );
  const legend = marks.map((m, i) => {
    ensure(Boolean(m.ref) !== Boolean(m.box), "每处标注必须指定 ref 或 box");
    const element = m.ref
      ? source.elements.find((e) => e.ref === m.ref)
      : undefined;
    ensure(!m.ref || element, "ref 不属于这张截图，请使用截图返回的 ref");
    const b = m.box || element!.box;
    ensure(
      [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.width > 0 &&
        b.height > 0 &&
        b.x + b.width <= source.width &&
        b.y + b.height <= source.height,
      "标注坐标超出截图范围",
    );
    ensure(!m.label || m.label.length <= 80, "标注说明过长");
    return {
      number: i + 1,
      label: m.label || element?.label || `步骤 ${i + 1}`,
      ref: m.ref,
      box: b,
    };
  });
  // The SVG contains only validated numbers. User labels stay in the legend.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}">${legend
    .map((m) => {
      const { x, y, width, height } = m.box;
      const badgeX = Math.min(source.width - 14, Math.max(14, x + 12));
      const badgeY = Math.min(source.height - 14, Math.max(14, y + 12));
      return `<rect x="${x + 1.5}" y="${y + 1.5}" width="${Math.max(0, width - 3)}" height="${Math.max(0, height - 3)}" rx="3" fill="none" stroke="#e53935" stroke-width="3"/><circle cx="${badgeX}" cy="${badgeY}" r="12" fill="#e53935"/><text x="${badgeX}" y="${badgeY + 4}" text-anchor="middle" font-size="14" font-family="Arial" fill="white">${m.number}</text>`;
    })
    .join("")}</svg>`;
  const raw = await readFile(path.join(dir, imageId + ".png"));
  const image = await sharp(raw)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  const id = randomUUID();
  await writeFile(path.join(dir, id + ".png"), image, { mode: 0o600 });
  const result = {
    id,
    kind: "annotated",
    sourceId: imageId,
    browserId,
    pageUrl: source.pageUrl,
    revision: source.revision,
    evidenceId: source.evidenceId,
    width: source.width,
    height: source.height,
    capturedAt: source.capturedAt,
    createdAt: new Date().toISOString(),
    legend,
  };
  await atomic(path.join(dir, id + ".json"), result);
  return result;
}
