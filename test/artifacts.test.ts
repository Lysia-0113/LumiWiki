import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "../src/config.js";
import { atomic, projectDir } from "../src/store.js";
import {
  annotateImage,
  type Box,
  type ScreenshotArtifact,
} from "../src/artifacts.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-artifacts-"));
const previousData = config.data;
config.data = tmp;
after(async () => {
  config.data = previousData;
  await rm(tmp, { recursive: true, force: true });
});

async function fixture(width = 300, height = 220) {
  const projectId = randomUUID();
  const id = randomUUID();
  const browserId = randomUUID();
  const dir = path.join(projectDir(projectId), "artifacts");
  await mkdir(dir, { recursive: true });
  const source: ScreenshotArtifact = {
    id,
    kind: "screenshot",
    browserId,
    pageUrl: "https://example.test/frozen",
    width,
    height,
    revision: 7,
    evidenceId: "saved-evidence",
    capturedAt: "2026-01-02T00:00:00Z",
    elements: [
      {
        ref: "frozen-ref",
        label: "保存",
        box: { x: 80, y: 80, width: 70, height: 35 },
      },
    ],
  };
  const png = await sharp({
    create: { width, height, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(dir, id + ".png"), png);
  await atomic(path.join(dir, id + ".json"), source);
  return { projectId, browserId, id, dir, png, source };
}
const overlaps = (a: Box, b: Box) =>
  a.x <= b.x + b.width &&
  a.x + a.width >= b.x &&
  a.y <= b.y + b.height &&
  a.y + a.height >= b.y;

function checkLayout(result: Awaited<ReturnType<typeof annotateImage>>) {
  for (const mark of result.legend) {
    const badge = mark.badge;
    assert.ok(badge.x >= 0 && badge.y >= 0);
    assert.ok(badge.x + badge.width <= result.width);
    assert.ok(badge.y + badge.height <= result.height);
    for (const target of result.legend)
      assert.equal(overlaps(badge, target.box), false);
    for (const other of result.legend)
      if (mark !== other) assert.equal(overlaps(badge, other.badge), false);
    const length = Math.hypot(
      mark.leader.to.x - mark.leader.from.x,
      mark.leader.to.y - mark.leader.from.y,
    );
    assert.ok(length > 0 && length <= 72);
  }
}

test("标注只用冻结截图 ref，保留原 PNG/JSON 和证据，长解释保存在结构化图例", async () => {
  const f = await fixture();
  const originalJson = await readFile(path.join(f.dir, f.id + ".json"));
  const description = "详细解释与注意事项。\n".repeat(160);
  const result = await annotateImage(f.projectId, f.browserId, f.id, [
    { ref: "frozen-ref", label: "提交 <script> & 保存", description },
  ]);
  assert.equal(result.sourceId, f.id);
  assert.equal(result.kind, "annotated");
  assert.equal(result.revision, 7);
  assert.equal(result.evidenceId, "saved-evidence");
  assert.equal(result.capturedAt, f.source.capturedAt);
  assert.equal(result.pageUrl, f.source.pageUrl);
  assert.deepEqual(result.legend[0].box, f.source.elements[0].box);
  assert.equal(result.legend[0].description, description);
  assert.equal(result.legend[0].number, 1);
  assert.deepEqual(await readFile(path.join(f.dir, f.id + ".png")), f.png);
  assert.deepEqual(
    await readFile(path.join(f.dir, f.id + ".json")),
    originalJson,
  );
  const output = await readFile(path.join(f.dir, result.id + ".png"));
  assert.notDeepEqual(output, f.png);
  const { data, info } = await sharp(output)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // The centre of the target remains untouched; the number is not painted over it.
  const centre = (97 * info.width + 115) * info.channels;
  assert.deepEqual([...data.subarray(centre, centre + 3)], [255, 255, 255]);
  assert.ok(
    data.some(
      (value, i) => i % info.channels === 0 && value > 190 && data[i + 1] < 100,
    ),
  );
  checkLayout(result);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.dir, result.id + ".json"), "utf8"))
      .legend,
    result.legend,
  );
});

test("拒绝相交、嵌套、重复和接触的目标，错误指导拆图或精确目标，不静默丢标注", async () => {
  const f = await fixture();
  const first = { x: 60, y: 60, width: 100, height: 80 };
  for (const second of [
    { x: 120, y: 100, width: 70, height: 40 },
    { x: 80, y: 80, width: 20, height: 20 },
    first,
    { x: 160, y: 60, width: 20, height: 20 },
  ]) {
    await assert.rejects(
      annotateImage(f.projectId, f.browserId, f.id, [
        { box: first },
        { box: second },
      ]),
      /标注 1 与 2.*相交或嵌套.*拆图.*精确/,
    );
  }
  assert.deepEqual(
    (await readdir(f.dir)).sort(),
    [f.id + ".json", f.id + ".png"].sort(),
  );
});

test("截图四边的编号完整外置、不遮任何目标和其他编号，布局确定且编号顺序稳定", async () => {
  const f = await fixture(240, 180);
  const marks = [
    { box: { x: 0, y: 0, width: 50, height: 35 } },
    { box: { x: 190, y: 0, width: 50, height: 35 } },
    { box: { x: 0, y: 145, width: 50, height: 35 } },
    { box: { x: 190, y: 145, width: 50, height: 35 } },
  ];
  const a = await annotateImage(f.projectId, f.browserId, f.id, marks);
  const b = await annotateImage(f.projectId, f.browserId, f.id, marks);
  checkLayout(a);
  assert.deepEqual(
    a.legend.map((m) => m.number),
    [1, 2, 3, 4],
  );
  assert.deepEqual(a.legend, b.legend);
  assert.deepEqual(
    await readFile(path.join(f.dir, a.id + ".png")),
    await readFile(path.join(f.dir, b.id + ".png")),
  );
});

test("相邻窄目标竞争编号位置时，所有编号仍不重叠", async () => {
  const f = await fixture(150, 140);
  const marks = Array.from({ length: 5 }, (_, i) => ({
    // Target spacing is 18px, smaller than a 24px number badge: naive
    // placement along the same edge necessarily overlaps adjacent numbers.
    box: { x: 25 + i * 18, y: 50, width: 14, height: 40 },
    label: `目标 ${i + 1}`,
  }));
  const result = await annotateImage(f.projectId, f.browserId, f.id, marks);
  assert.equal(result.legend.length, marks.length);
  checkLayout(result);
});

test("没有安全编号空间时失败且不写入半成品，原图依然保留", async () => {
  const f = await fixture(80, 80);
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [
      { box: { x: 0, y: 0, width: 80, height: 80 } },
    ]),
    /无法.*全部标注.*拆图.*精确/,
  );
  assert.equal((await readdir(f.dir)).length, 2);
  assert.deepEqual(await readFile(path.join(f.dir, f.id + ".png")), f.png);
});

test("拒绝跨浏览器、错误 ref、路径穿越和再次标注派生图", async () => {
  const f = await fixture();
  await assert.rejects(
    annotateImage(f.projectId, "other-browser", f.id, [{ ref: "frozen-ref" }]),
    /当前浏览器/,
  );
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [{ ref: "new-live-ref" }]),
    /不属于这张截图/,
  );
  for (const id of [
    "../escape",
    f.id + "/../../escape",
    "..\\escape",
    "/tmp/escape",
    "%2e%2e%2fescape",
  ])
    await assert.rejects(
      annotateImage(f.projectId, f.browserId, id, [{ ref: "frozen-ref" }]),
      /图片ID无效/,
    );
  const result = await annotateImage(f.projectId, f.browserId, f.id, [
    { ref: "frozen-ref" },
  ]);
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, result.id, [
      { box: result.legend[0].box },
    ]),
    /原始截图/,
  );
});

test("坐标与输入校验不会以新页面坐标替代冻结 ref", async () => {
  const f = await fixture();
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [{}]),
    /ref 或 box/,
  );
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [
      { ref: "frozen-ref", box: { x: 0, y: 0, width: 20, height: 20 } },
    ]),
    /ref 或 box/,
  );
  for (const box of [
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 290, y: 0, width: 20, height: 20 },
    { x: NaN, y: 0, width: 20, height: 20 },
    { x: 1, y: 1, width: 0, height: 20 },
  ])
    await assert.rejects(
      annotateImage(f.projectId, f.browserId, f.id, [{ box }]),
      /超出截图/,
    );
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [
      { ref: "frozen-ref", label: "字".repeat(81) },
    ]),
    /description/,
  );
  await atomic(path.join(f.dir, f.id + ".json"), {
    ...f.source,
    width: f.source.width + 1,
  });
  await assert.rejects(
    annotateImage(f.projectId, f.browserId, f.id, [{ ref: "frozen-ref" }]),
    /冻结坐标不一致/,
  );
});
