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
export interface AnnotationMark {
  ref?: string;
  box?: Box;
  /** A short heading; the longer explanation belongs in description. */
  label?: string;
  description?: string;
}
interface Point {
  x: number;
  y: number;
}
interface Leader {
  from: Point;
  to: Point;
}
export interface AnnotationLegendItem {
  number: number;
  label: string;
  description?: string;
  ref?: string;
  box: Box;
  /** The full badge bounds, in original screenshot pixels. */
  badge: Box;
  leader: Leader;
}
export interface AnnotatedArtifact
  extends Omit<ScreenshotArtifact, "kind" | "elements"> {
  kind: "annotated";
  sourceId: string;
  createdAt: string;
  legend: AnnotationLegendItem[];
}

const radius = 12;
const clearance = 3;
const maxLeaderLength = 72;
const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const expand = (b: Box, padding: number): Box => ({
  x: b.x - padding,
  y: b.y - padding,
  width: b.width + padding * 2,
  height: b.height + padding * 2,
});
const intersects = (a: Box, b: Box) =>
  a.x <= right(b) && right(a) >= b.x && a.y <= bottom(b) && bottom(a) >= b.y;
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(n, high));

// Segment/rectangle intersection (including the boundary), not just bounding boxes.
function crossesBox(line: Leader, box: Box) {
  let low = 0;
  let high = 1;
  for (const [start, delta, min, max] of [
    [line.from.x, line.to.x - line.from.x, box.x, right(box)],
    [line.from.y, line.to.y - line.from.y, box.y, bottom(box)],
  ]) {
    if (delta === 0) {
      if (start < min || start > max) return false;
    } else {
      const a = (min - start) / delta;
      const b = (max - start) / delta;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low > high) return false;
    }
  }
  return true;
}

function pointDistance(p: Point, line: Leader) {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const t = clamp(
    ((p.x - line.from.x) * dx + (p.y - line.from.y) * dy) /
      (dx * dx + dy * dy || 1),
    0,
    1,
  );
  return Math.hypot(p.x - line.from.x - t * dx, p.y - line.from.y - t * dy);
}
function leadersConflict(a: Leader, b: Leader) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const crossing =
    cross(a.from, a.to, b.from) * cross(a.from, a.to, b.to) < 0 &&
    cross(b.from, b.to, a.from) * cross(b.from, b.to, a.to) < 0;
  return (
    crossing ||
    Math.min(
      pointDistance(a.from, b),
      pointDistance(a.to, b),
      pointDistance(b.from, a),
      pointDistance(b.to, a),
    ) <= clearance
  );
}

function badgeCandidates(box: Box, width: number, height: number) {
  if (width < radius * 2 + clearance * 2 || height < radius * 2 + clearance * 2)
    return [];
  const candidates: Array<{ badge: Box; leader: Leader; distance: number }> =
    [];
  const seen = new Set<string>();
  const add = (x: number, y: number) => {
    x = clamp(x, radius + clearance, width - radius - clearance);
    y = clamp(y, radius + clearance, height - radius - clearance);
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    const badge = {
      x: x - radius,
      y: y - radius,
      width: radius * 2,
      height: radius * 2,
    };
    if (intersects(badge, expand(box, clearance))) return;
    const from = {
      x: clamp(x, box.x, right(box)),
      y: clamp(y, box.y, bottom(box)),
    };
    const distance = Math.hypot(x - from.x, y - from.y);
    const length = distance - radius;
    if (length > maxLeaderLength) return;
    candidates.push({
      badge,
      leader: {
        from,
        to: {
          x: x + ((from.x - x) * radius) / distance,
          y: y + ((from.y - y) * radius) / distance,
        },
      },
      distance,
    });
  };
  // Edge-aligned, midpoint, then evenly spaced positions. Clamping also handles
  // targets at screenshot edges. Stable ordering makes repeat annotations identical.
  const positions = (start: number, end: number) => {
    const values = [
      start + radius,
      end - radius,
      (start + end) / 2,
      start,
      end,
    ];
    for (let n = start + radius * 3; n < end; n += radius * 2 + clearance * 2)
      values.push(n);
    return values;
  };
  for (let gap = clearance * 2; gap <= maxLeaderLength; gap += radius) {
    for (const x of positions(box.x, right(box))) {
      add(x, box.y - radius - gap);
      add(x, bottom(box) + radius + gap);
    }
    for (const y of positions(box.y, bottom(box))) {
      add(box.x - radius - gap, y);
      add(right(box) + radius + gap, y);
    }
    for (const x of [box.x - radius - gap, right(box) + radius + gap])
      for (const y of [box.y - radius - gap, bottom(box) + radius + gap])
        add(x, y);
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

function layoutBadges(boxes: Box[], width: number, height: number) {
  for (let i = 0; i < boxes.length; i++)
    for (let j = 0; j < i; j++)
      ensure(
        !intersects(boxes[i], boxes[j]),
        `标注 ${j + 1} 与 ${i + 1} 的目标相交或嵌套（含边界接触）；请拆图分别解释，或改用不相交的精确 ref/box`,
      );

  const choices = boxes.map((box, i) =>
    badgeCandidates(box, width, height).filter(
      (candidate) =>
        boxes.every(
          (target) => !intersects(candidate.badge, expand(target, clearance)),
        ) &&
        boxes.every(
          (target, j) =>
            j === i || !crossesBox(candidate.leader, expand(target, clearance)),
        ),
    ),
  );
  // Place the most constrained target first. Backtrack rather than silently drop
  // marks when neighbouring targets compete for the same badge position.
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => choices[a].length - choices[b].length || a - b);
  type Placement = (typeof choices)[number][number];
  const placed = new Map<number, Placement>();
  let attempts = 0;
  const place = (depth: number): boolean => {
    if (depth === order.length) return true;
    const index = order[depth];
    for (const candidate of choices[index]) {
      if (++attempts > 100_000) return false;
      if (
        [...placed.values()].some(
          (other) =>
            intersects(candidate.badge, expand(other.badge, clearance)) ||
            crossesBox(candidate.leader, expand(other.badge, clearance)) ||
            crossesBox(other.leader, expand(candidate.badge, clearance)) ||
            leadersConflict(candidate.leader, other.leader),
        )
      )
        continue;
      placed.set(index, candidate);
      if (place(depth + 1)) return true;
      placed.delete(index);
    }
    return false;
  };
  ensure(
    place(0),
    `无法为全部标注安排不遮挡目标、框或编号的外置编号及短引线${attempts > 100_000 ? "（布局搜索达到上限）" : ""}；请拆图、减少同图解释点，或使用更精确的目标 box/ref 后重试`,
  );
  return boxes.map((_, i) => {
    const { badge, leader } = placed.get(i)!;
    return { badge, leader };
  });
}

export async function annotateImage(
  projectId: string,
  browserId: string,
  imageId: string,
  marks: AnnotationMark[],
): Promise<AnnotatedArtifact> {
  ensure(typeof imageId === "string" && validId(imageId), "图片ID无效");
  ensure(
    Array.isArray(marks) && marks.length >= 1 && marks.length <= 20,
    "每张图标注1至20处",
  );
  const dir = path.join(projectDir(projectId), "artifacts");
  const source = await json<ScreenshotArtifact>(
    path.join(dir, imageId + ".json"),
  );
  ensure(
    source.id === imageId &&
      source.kind === "screenshot" &&
      source.browserId === browserId,
    "只能标注当前浏览器的原始截图",
  );
  ensure(
    Number.isSafeInteger(source.width) &&
      source.width > 0 &&
      Number.isSafeInteger(source.height) &&
      source.height > 0 &&
      Array.isArray(source.elements),
    "原始截图元数据无效，请重新截图",
  );
  const targets = marks.map((m, i) => {
    ensure(m && typeof m === "object", `标注 ${i + 1} 无效`);
    ensure(
      (m.ref !== undefined) !== (m.box !== undefined),
      "每处标注必须指定 ref 或 box",
    );
    ensure(
      m.ref === undefined || (typeof m.ref === "string" && m.ref.length > 0),
      "ref 无效",
    );
    const element = m.ref
      ? source.elements.find((e) => e.ref === m.ref)
      : undefined;
    ensure(!m.ref || element, "ref 不属于这张截图，请使用截图返回的 ref");
    const b = m.box || element?.box;
    ensure(
      b &&
        [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.width > 0 &&
        b.height > 0 &&
        right(b) <= source.width &&
        bottom(b) <= source.height,
      "标注坐标超出截图范围",
    );
    ensure(
      m.label === undefined ||
        (typeof m.label === "string" && m.label.length <= 80),
      "标注说明过长或不是文本（label 最多80字，长说明请用 description）",
    );
    ensure(
      m.description === undefined || typeof m.description === "string",
      "标注 description 必须是文本",
    );
    return {
      number: i + 1,
      label: m.label || element?.label || `步骤 ${i + 1}`,
      ...(m.description !== undefined ? { description: m.description } : {}),
      ...(m.ref ? { ref: m.ref } : {}),
      box: { ...b },
    };
  });
  const placements = layoutBadges(
    targets.map((m) => m.box),
    source.width,
    source.height,
  );
  const legend = targets.map((m, i) => ({ ...m, ...placements[i] }));
  // Only validated coordinates and generated numbers enter the SVG. Explanations
  // remain structured data, rendered (and escaped) by the document exporter.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}">${legend
    .map((m) => {
      const { x, y, width, height } = m.box;
      const stroke = Math.min(3, width / 2, height / 2);
      const cx = m.badge.x + radius,
        cy = m.badge.y + radius;
      return `<rect x="${x + stroke / 2}" y="${y + stroke / 2}" width="${width - stroke}" height="${height - stroke}" rx="${Math.min(3, width / 4, height / 4)}" fill="none" stroke="#e53935" stroke-width="${stroke}"/><line x1="${m.leader.from.x}" y1="${m.leader.from.y}" x2="${m.leader.to.x}" y2="${m.leader.to.y}" stroke="#e53935" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="${radius}" fill="#e53935"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="14" font-family="Arial" fill="white">${m.number}</text>`;
    })
    .join("")}</svg>`;
  const raw = await readFile(path.join(dir, imageId + ".png"));
  const metadata = await sharp(raw).metadata();
  ensure(
    metadata.width === source.width && metadata.height === source.height,
    "原始截图尺寸与冻结坐标不一致，请重新截图",
  );
  const image = await sharp(raw)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  const id = randomUUID();
  await writeFile(path.join(dir, id + ".png"), image, { mode: 0o600 });
  const result: AnnotatedArtifact = {
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
