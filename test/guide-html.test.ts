import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGuideHtml } from "../src/guide-html.js";
import { renderDocument } from "../src/documents.js";
test("用户导出只呈现短流程和选定截图，完整事实仍在JSON", () => {
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
    assert.ok(
      !/预期结果|private-audit|internal-page-id|验证范围|## 依据/.test(output),
    );
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
