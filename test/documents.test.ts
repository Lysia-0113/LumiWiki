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
import { annotateImage, type ScreenshotArtifact } from "../src/artifacts.js";
import {
  documentStepImages,
  renderDocument,
  writeDocument,
  type DocumentLegendItem,
  type UserDocument,
} from "../src/documents.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-documents-"));
const previousData = config.data;
config.data = tmp;
after(async () => {
  config.data = previousData;
  await rm(tmp, { recursive: true, force: true });
});
const document = (extra: Partial<UserDocument> = {}): UserDocument => ({
  id: randomUUID(),
  title: "完整上手说明",
  summary: "从准备到完成，逐项说明。",
  steps: [{ title: "操作", instruction: "阅读后执行。" }],
  references: [],
  ...extra,
});

async function fixture() {
  const projectId = randomUUID();
  const rawId = randomUUID();
  const browserId = randomUUID();
  const root = projectDir(projectId);
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  const source: ScreenshotArtifact = {
    id: rawId,
    kind: "screenshot",
    browserId,
    width: 320,
    height: 240,
    pageUrl: "https://example.test",
    revision: 2,
    capturedAt: "2026-01-02T00:00:00Z",
    elements: [
      {
        ref: "save",
        label: "保存入口",
        box: { x: 60, y: 80, width: 70, height: 35 },
      },
      {
        ref: "status",
        label: "状态区域",
        box: { x: 185, y: 140, width: 80, height: 35 },
      },
    ],
  };
  const png = await sharp({
    create: { width: 320, height: 240, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(root, "artifacts", rawId + ".png"), png);
  await atomic(path.join(root, "artifacts", rawId + ".json"), source);
  const annotated = await annotateImage(projectId, browserId, rawId, [
    {
      ref: "save",
      label: "实际图例一 <script>alert(1)</script>",
      description: "完整长说明\n".repeat(100),
    },
    {
      ref: "status",
      label: "实际图例二 & 状态",
      description: "查看保存后的状态，不要重复提交。",
    },
  ]);
  return { projectId, rawId, root, annotated, png };
}

test("旧单图 API 兼容，正文与预期结果完整输出，不要求原图有图例", () => {
  const doc = document({
    steps: [
      {
        title: "提交",
        instruction: "先填写，再提交。",
        expectedResult: "状态变为已完成。",
        imageId: "legacy-image",
      },
    ],
  });
  const output = renderDocument(
    doc,
    new Map([["legacy-image", "data:image/png;base64,raw"]]),
  );
  for (const value of [output.html, output.md]) {
    assert.ok(value.includes("状态变为已完成"));
    assert.ok(value.includes("data:image/png;base64,raw"));
    assert.ok(!value.includes("截图编号说明"));
  }
  assert.equal((output.html.match(/<img /g) || []).length, 1);
});

test("一步多图按顺序输出，合并旧 imageId 并保留新图题，逐图自动渲染全部图例", () => {
  const doc = document({
    steps: [
      {
        title: "录入与核对",
        instruction: "先录入，再核对。",
        imageId: "raw",
        images: [
          { imageId: "raw", caption: "未标注的整体截图" },
          { imageId: "annotated", caption: "只解释两个位置" },
          { imageId: "after", caption: "完成页面" },
        ],
      },
    ],
  });
  const legends = new Map<string, DocumentLegendItem[]>([
    [
      "annotated",
      [
        { number: 1, label: "录入区域", description: "这里填写全部必要信息。" },
        {
          number: 2,
          label: "核对状态",
          description: "这里确认最终结果。\n必要时刷新。",
        },
      ],
    ],
  ]);
  const output = renderDocument(
    doc,
    new Map([
      ["raw", "data:image/png;base64,raw"],
      ["annotated", "data:image/png;base64,annotated"],
      ["after", "data:image/png;base64,after"],
    ]),
    legends,
  );
  assert.equal((output.html.match(/<figure>/g) || []).length, 3);
  assert.equal((output.md.match(/!\[/g) || []).length, 3);
  for (const value of [output.html, output.md]) {
    assert.ok(value.indexOf("base64,raw") < value.indexOf("base64,annotated"));
    assert.ok(
      value.indexOf("base64,annotated") < value.indexOf("base64,after"),
    );
    for (const text of [
      "未标注的整体截图",
      "只解释两个位置",
      "1. 录入区域",
      "2. 核对状态",
      "必要时刷新",
    ])
      assert.ok(value.includes(text));
  }
  assert.equal(
    (output.html.match(/aria-label="截图编号说明"/g) || []).length,
    1,
  );
  assert.deepEqual(documentStepImages(doc.steps[0]), doc.steps[0].images);
});

test("完整章节和长正文不截断，不暴露审计引用或 verification", () => {
  const longText = "详细说明每一步的背景、输入、操作和结果。\n\n".repeat(400);
  const doc = document({
    audience: ["首次使用的管理员", "负责复核的同事"],
    prerequisites: ["已取得测试账号", "准备业务单据"],
    details: longText,
    outcomes: ["得到可复核的完成记录"],
    troubleshooting: [
      { problem: "提交失败怎么办？", solution: "先检查网络。\n再检查必填项。" },
    ],
    limitations: ["仅适用于测试环境"],
    steps: Array.from({ length: 12 }, (_, i) => ({
      title: `步骤 ${i + 1}`,
      instruction: longText + `正文末尾 ${i + 1}`,
      expectedResult: `结果 ${i + 1}`,
    })),
    references: [{ kind: "doc", location: "private-page-id" }],
    verification: { checkpoints: ["private-audit"] },
  });
  const output = renderDocument(doc, new Map());
  for (const value of [output.html, output.md]) {
    for (const text of [
      "首次使用的管理员",
      "准备业务单据",
      "得到可复核的完成记录",
      "提交失败怎么办",
      "再检查必填项",
      "仅适用于测试环境",
      "正文末尾 12",
      "结果 12",
    ])
      assert.ok(value.includes(text));
    assert.ok(!value.includes("private-page-id"));
    assert.ok(!value.includes("private-audit"));
    assert.equal(
      (value.match(/详细说明每一步的背景、输入、操作和结果。/g) || []).length,
      400 * 13,
    );
  }
});

test("HTML 转义覆盖章节、图题、编号解释与图片属性，Markdown 不输出活动 HTML", () => {
  const unsafe = '<script>alert("x")</script> & <img src=x onerror=alert(1)>';
  const doc = document({
    title: unsafe,
    summary: unsafe,
    audience: [unsafe],
    prerequisites: [unsafe],
    details: unsafe,
    outcomes: [unsafe],
    limitations: [unsafe],
    troubleshooting: [{ problem: unsafe, solution: unsafe }],
    steps: [
      {
        title: unsafe,
        instruction: unsafe,
        expectedResult: unsafe,
        images: [{ imageId: "test", caption: unsafe }],
      },
    ],
  });
  const output = renderDocument(
    doc,
    new Map([["test", 'data:image/png;base64,fixture" onerror="evil']]),
    new Map([["test", [{ number: 1, label: unsafe, description: unsafe }]]]),
  );
  assert.ok(!output.html.includes("<script>"));
  assert.ok(!output.html.includes("<img src=x"));
  assert.ok(!output.html.includes(' onerror="evil'));
  assert.ok(output.html.includes("&lt;script&gt;"));
  assert.ok(output.html.includes("&amp;"));
  assert.ok(output.html.includes("fixture&quot; onerror=&quot;evil"));
  assert.ok(!output.md.includes("<script>"));
  assert.ok(!output.md.includes("<img src=x"));
});

test("writeDocument 从 artifact.legend 自动导出而非使用文档自造编号，原图和引用不变", async () => {
  const f = await fixture();
  const originalMeta = await readFile(
    path.join(f.root, "artifacts", f.rawId + ".json"),
  );
  const doc = document({
    legend: [{ number: 99, label: "伪造图例" }],
    steps: [
      {
        title: "操作与结果",
        instruction: "操作后检查结果。",
        images: [
          { imageId: f.rawId, caption: "原始页面" },
          { imageId: f.annotated.id, caption: "需要解释的两个位置" },
        ],
      },
    ],
  });
  await writeDocument(f.projectId, doc);
  const html = await readFile(
    path.join(f.root, "documents", doc.id + ".html"),
    "utf8",
  );
  const md = await readFile(
    path.join(f.root, "documents", doc.id + ".md"),
    "utf8",
  );
  for (const value of [html, md]) {
    assert.ok(value.includes("1. 实际图例一"));
    assert.ok(value.includes("2. 实际图例二"));
    assert.ok(value.includes("查看保存后的状态"));
    assert.ok(!value.includes("伪造图例"));
    assert.ok(!value.includes("<script>"));
    assert.equal((value.match(/完整长说明/g) || []).length, 100);
  }
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(f.root, "documents", doc.id + ".json"), "utf8"),
    ),
    {
      ...doc,
      figureLegends: {
        [f.annotated.id]: f.annotated.legend.map(
          ({ number, label, description }) => ({
            number,
            label,
            ...(description ? { description } : {}),
          }),
        ),
      },
    },
  );
  assert.deepEqual(
    await readFile(path.join(f.root, "artifacts", f.rawId + ".png")),
    f.png,
  );
  assert.deepEqual(
    await readFile(path.join(f.root, "artifacts", f.rawId + ".json")),
    originalMeta,
  );
});

test("writeDocument 拒绝旧/新图片字段及文档 ID 的路径穿越，在写入前校验所有 ID", async () => {
  const f = await fixture();
  for (const badId of [
    "../escape",
    f.rawId + "/../../escape",
    "..\\escape",
    "/tmp/escape",
    "%2e%2e%2fescape",
  ]) {
    await assert.rejects(
      writeDocument(
        f.projectId,
        document({
          steps: [{ title: "旧", instruction: "内容", imageId: badId }],
        }),
      ),
      /图片ID无效/,
    );
    await assert.rejects(
      writeDocument(
        f.projectId,
        document({
          steps: [
            {
              title: "新",
              instruction: "内容",
              images: [{ imageId: f.rawId }, { imageId: badId }],
            },
          ],
        }),
      ),
      /图片ID无效/,
    );
  }
  await assert.rejects(
    writeDocument(f.projectId, document({ id: "../escape" })),
    /文档ID无效/,
  );
  assert.ok(!(await readdir(f.root)).includes("documents"));
});

test("编号图片缺少/损坏图例就拒绝导出，不悄悄省略任何编号", async () => {
  const f = await fixture();
  const doc = document({
    steps: [
      { title: "标注图", instruction: "阅读所有编号", imageId: f.annotated.id },
    ],
  });
  for (const legend of [
    undefined,
    [],
    [
      { number: 1, label: "一" },
      { number: 1, label: "重复" },
    ],
    [{ number: 0, label: "错误编号" }],
  ]) {
    await atomic(path.join(f.root, "artifacts", f.annotated.id + ".json"), {
      ...f.annotated,
      legend,
    });
    await assert.rejects(writeDocument(f.projectId, doc), /legend/);
  }
  assert.ok(!(await readdir(f.root)).includes("documents"));
});

test("缺失图片内容不导出 undefined，图例长度不额外限制为 label 80 字", () => {
  const doc = document({
    steps: [{ title: "图", instruction: "说明", imageId: "missing" }],
  });
  assert.throws(() => renderDocument(doc, new Map()), /缺少内容/);
  const longLabel = "旧版图例的完整文字".repeat(100);
  const output = renderDocument(
    doc,
    new Map([["missing", "data:image/png;base64,fixture"]]),
    new Map([["missing", [{ number: 1, label: longLabel }]]]),
  );
  assert.ok(output.html.includes(longLabel));
  assert.ok(output.md.includes(longLabel));
});
