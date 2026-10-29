import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGuideHtml } from "../src/guide-html.js";
import { renderDocument } from "../src/documents.js";
test("用户导出完整操作、预期结果和选定截图，审计事实仍在JSON", () => {
  const doc = {
    id: "sample",
    title: "审批",
    summary: "审核员可以审批待处理单据。",
    steps: [
      {
        title: "提交",
        instruction: "填写意见后提交，回到列表查看状态。",
        expectedResult: "已通过",
        imageId: "key-image",
      },
    ],
    references: [{ kind: "doc" as const, location: "internal-page-id" }],
    verification: { checkpoints: ["private-audit"] },
  };
  const rendered = renderDocument(
    doc,
    new Map([["key-image", "data:image/png;base64,fixture"]]),
  );
  for (const output of [rendered.html, rendered.md]) {
    assert.ok(output.includes("填写意见后提交"));
    assert.ok(output.includes("data:image/png;base64,fixture"));
    assert.ok(output.includes("预期结果"));
    assert.ok(output.includes("已通过"));
    assert.ok(!/private-audit|internal-page-id|验证范围|## 依据/.test(output));
  }
  assert.equal(doc.steps[0].expectedResult, "已通过");
  assert.equal(doc.references[0].location, "internal-page-id");
});
test("离线指南直接包含全部模块，避免固定高度 iframe 截断打印", () => {
  const html = renderGuideHtml("指南", [
    {
      id: "wallet",
      title: "钱包",
      html: '<!doctype html><style>body{}</style><h1>钱包</h1><p>末尾步骤</p><img src="data:image/png;base64,fixture">',
    },
    { id: "history", title: "记录", html: "<h1>记录</h1><p>查询历史</p>" },
  ]);
  assert.ok(!html.includes("<iframe"));
  assert.ok(html.includes('href="#wallet"'));
  assert.ok(html.includes("末尾步骤"));
  assert.ok(html.includes("data:image/png;base64,"));
  const partial = renderGuideHtml(
    "部分指南",
    [],
    ["余额不足：缺少测试账号", "<script>unsafe</script>"],
  );
  assert.ok(partial.includes("缺少测试账号"));
  assert.ok(partial.includes("&lt;script&gt;"));
  assert.ok(!partial.includes("<script>"));
});

test("完整章节多图与全部图例合并进指南，长正文和层级标题不丢失", () => {
  const text = "完整的操作背景与操作说明。\n".repeat(1000);
  const rendered = renderDocument(
    {
      id: "chapter",
      title: "审批章节",
      summary: "完整上手",
      audience: ["审核员"],
      prerequisites: ["准备待审批单据"],
      details: text,
      outcomes: ["审批完成并可查询"],
      limitations: ["仅限测试环境"],
      troubleshooting: [{ problem: "审批被拒绝", solution: "检查权限后重试" }],
      steps: [
        {
          title: "提交并核对",
          instruction: text + "步骤末尾",
          images: [{ imageId: "a" }, { imageId: "b" }],
        },
      ],
      references: [],
    },
    new Map([
      ["a", "data:image/png;base64,first"],
      ["b", "data:image/png;base64,second"],
    ]),
    new Map([
      [
        "b",
        [
          { number: 1, label: "提交按钮" },
          { number: 2, label: "结果状态", description: "核对最终完成状态。" },
        ],
      ],
    ]),
  );
  const html = renderGuideHtml("完整指南", [
    { id: "approval", title: "审批章节", html: rendered.html },
    {
      id: "other",
      title: "其他章节",
      html: "<main><h1>其他章节</h1><h2>基础</h2><h3>细节</h3><p>最终正文</p></main>",
    },
  ]);
  assert.equal((html.match(/<main>/g) || []).length, 1);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.equal((html.match(/完整的操作背景与操作说明。/g) || []).length, 2000);
  for (const value of [
    "准备待审批单据",
    "步骤末尾",
    "审批完成并可查询",
    "仅限测试环境",
    "核对最终完成状态",
    "最终正文",
  ])
    assert.ok(html.includes(value));
  assert.ok(html.includes("<h2>审批章节</h2>"));
  assert.ok(html.includes("<h3>1. 提交并核对</h3>"));
  assert.ok(html.includes("<h4>细节</h4>"));
  assert.ok(!html.includes("<iframe"));
});

test("单章节不重复标题，旧 HTML 片段和带属性的 main 均保留完整内容", () => {
  const one = renderGuideHtml("单章", [
    {
      id: "one",
      title: "单章",
      html: '<main class="chapter"><h1>单章</h1><h2>内容</h2><p>完整正文</p></main>',
    },
  ]);
  assert.equal((one.match(/<h1>单章<\/h1>/g) || []).length, 1);
  assert.ok(one.includes("<h2>内容</h2>"));
  assert.ok(one.includes("完整正文"));
  const legacy = renderGuideHtml(
    '<img onerror="unsafe">',
    [
      {
        id: 'chapter" data-unsafe="yes',
        title: "章节",
        html: '<!doctype html><html><head><title>模块标题</title><style>p{}</style></head><body><p>无 h1 的完整旧正文</p><h3 class="nested">深入说明</h3></body></html>',
      },
    ],
    ["<script>限制文本</script>"],
  );
  assert.ok(legacy.includes("无 h1 的完整旧正文"));
  assert.ok(legacy.includes('id="chapter&quot; data-unsafe=&quot;yes"'));
  assert.ok(!legacy.includes('<img onerror="unsafe">'));
  assert.ok(!legacy.includes("<script>"));
  assert.ok(legacy.includes("&lt;script&gt;限制文本&lt;/script&gt;"));
  assert.equal((legacy.match(/<!doctype/gi) || []).length, 1);
  assert.equal((legacy.match(/<style>/g) || []).length, 1);
});
