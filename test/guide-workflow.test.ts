import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { atomic, createProject, json, projectDir } from "../src/store.js";
import {
  GuideWorkflow,
  acquireGuideTask,
  guideTaskActive,
  type ChapterSpec,
  type GuideOutline,
} from "../src/guide-workflow.js";
import {
  allowedConversationTool,
  explorationAction,
} from "../src/guide-policy.js";
import { writeDocument } from "../src/documents.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-guide-workflow-"));
config.data = tmp;
after(() => rm(tmp, { recursive: true, force: true }));
const spec = (id: string, dependsOn: string[] = []): ChapterSpec => ({
  id,
  title: `章节${id}`,
  goal: `完成${id}业务任务`,
  scope: ["入口、操作、结果"],
  questions: [`如何完成${id}？`],
  dependsOn,
});
const outline = (...chapters: ChapterSpec[]): GuideOutline => ({
  title: "完整快速上手指南",
  audience: "测试角色",
  overview: "按业务任务理解并使用系统。",
  chapters,
});
async function workflow(...chapters: ChapterSpec[]) {
  const project = await createProject({ name: "章节任务" });
  const flow = GuideWorkflow.create(project.key, "生成完整指南");
  flow.setOutline(outline(...chapters));
  return flow;
}
async function finish(
  flow: GuideWorkflow,
  id: string,
  limitations: string[] = [],
  coverageComplete = true,
) {
  const chapter = flow.chapter(id);
  const lease = flow.begin(id),
    documentId = randomUUID();
  await writeDocument(flow.task.projectId, {
    id: documentId,
    guideTaskId: flow.task.id,
    moduleId: id,
    chapterVersion: chapter.version,
    title: chapter.spec.title,
    summary: "本章完整说明",
    details: "重要业务细节。".repeat(100),
    steps: [
      {
        title: "执行",
        instruction: "先检查业务状态，再完成对应操作并查看结果。",
      },
    ],
    references: [{ kind: "page", location: "http://fixture.local/" }],
  });
  flow.complete(
    id,
    lease,
    documentId,
    { summary: `${id}结果`, facts: [{ name: "对象", value: `record-${id}` }] },
    limitations,
    coverageComplete,
  );
  return documentId;
}

test("目录按依赖调度，支持超过八章，拒绝重复、未知依赖与依赖环", async () => {
  const flow = await workflow(
    spec("consumer", ["producer"]),
    spec("producer"),
    ...Array.from({ length: 10 }, (_, i) => spec(`extra-${i}`)),
  );
  assert.equal(flow.task.chapters.length, 12);
  assert.equal(flow.next()?.spec.id, "producer");
  await finish(flow, "producer");
  assert.equal(flow.next()?.spec.id, "consumer");
  for (const chapters of [
    [spec("a"), spec("a")],
    [spec("a", ["missing"])],
    [spec("a", ["b"]), spec("b", ["a"])],
  ]) {
    const project = await createProject({ name: "invalid" });
    const invalid = GuideWorkflow.create(project.key, "任务");
    assert.throws(() => invalid.setOutline(outline(...chapters)));
    assert.equal(invalid.task.chapters.length, 0);
  }
});

test("目录修订可追加及调整待执行章节，不能改写执行中和已生成的章节", async () => {
  const flow = await workflow(spec("a"), spec("b"));
  flow.revise(
    "发现遗漏的查询流程",
    [spec("c", ["a"])],
    [{ ...spec("b"), questions: ["如何查询完整结果？"] }],
  );
  assert.equal(flow.task.outlineRevision, 2);
  assert.equal(flow.chapter("b").version, 2);
  assert.equal(flow.task.revisions.length, 1);
  const lease = flow.begin("a");
  assert.throws(
    () => flow.revise("不能降低已执行标准", [], [spec("a")]),
    /尚未执行/,
  );
  flow.fail("a", lease, "测试数据尚未准备", true);
  assert.throws(
    () => flow.revise("不能改写受阻的标准", [], [spec("a")]),
    /尚未执行/,
  );
  assert.throws(
    () => flow.revise("未知依赖应当拒绝", [spec("d", ["unknown"])]),
    /依赖/,
  );
  assert.equal(flow.task.chapters.length, 3, "无效修订不能部分写入");
});

test("章节租约阻止旧任务和跨章节提交，续跑仅恢复缺口并保留写入历史", async () => {
  const flow = await workflow(spec("a"), spec("b"), spec("c", ["b"]));
  const completedId = await finish(flow, "a");
  const oldLease = flow.begin("b");
  flow.chapter("b").lastAttempt = {
    sessionId: randomUUID(),
    toolCalls: 20,
    writes: 1,
    verification: { pending: true },
  };
  flow.fail("b", oldLease, "提交后连接中断，需要先核对真实状态");
  flow.blockUnresolved();
  await flow.save();
  const loaded = await GuideWorkflow.load(flow.task.projectId, flow.task.id);
  loaded.resume();
  assert.equal(loaded.chapter("a").documentId, completedId);
  assert.equal(loaded.chapter("a").status, "generated");
  assert.equal(loaded.chapter("b").lastAttempt?.writes, 1);
  const brief = loaded.brief("b");
  assert.equal(brief.previousAttempt?.writes, 1);
  assert.ok(
    !("verification" in brief.previousAttempt!),
    "不把完整旧核验上下文注入新会话",
  );
  const lease = loaded.begin("b");
  assert.throws(
    () =>
      loaded.complete("b", oldLease, randomUUID(), {
        summary: "旧任务",
        facts: [],
      }),
    /失效/,
  );
  assert.throws(
    () =>
      loaded.complete("c", lease, randomUUID(), { summary: "跨章", facts: [] }),
    /失效/,
  );
  const release = acquireGuideTask(loaded.task.projectId, loaded.task.id);
  try {
    assert.equal(guideTaskActive(loaded.task.projectId, loaded.task.id), true);
    assert.throws(
      () => acquireGuideTask(loaded.task.projectId, loaded.task.id),
      /正在执行/,
    );
  } finally {
    release();
  }
  assert.equal(guideTaskActive(loaded.task.projectId, loaded.task.id), false);
});

test("依赖只交接必要事实；重做受限生产章节会使其消费者失效，不重做无关章节", async () => {
  const flow = await workflow(spec("a"), spec("b", ["a"]), spec("independent"));
  await finish(flow, "a", ["部分权限无法确认"], false);
  await finish(flow, "b");
  const independentId = await finish(flow, "independent");
  const brief = flow.brief("b");
  assert.deepEqual(brief.dependencies[0].handoff?.facts, [
    { name: "对象", value: "record-a" },
  ]);
  assert.ok(!JSON.stringify(brief).includes("重要业务细节。"));
  flow.resume();
  assert.equal(flow.chapter("a").status, "pending");
  assert.equal(flow.chapter("b").status, "pending");
  assert.equal(flow.chapter("a").version, 2);
  assert.equal(flow.chapter("b").documentId, undefined);
  assert.equal(flow.chapter("independent").documentId, independentId);
});

test("宿主直接组装完整正文和章节链接，真实业务限制不等于内容缺口", async () => {
  const flow = await workflow(spec("a"), spec("b"));
  await finish(flow, "a", ["仅审批角色可以提交"], true);
  await finish(flow, "b");
  const guide = await flow.assemble();
  assert.equal(guide?.complete, true);
  assert.equal(flow.task.status, "completed");
  const root = projectDir(flow.task.projectId);
  const html = await readFile(
    path.join(root, "guides", flow.task.guideId + ".html"),
    "utf8",
  );
  const md = await readFile(
    path.join(root, "guides", flow.task.guideId + ".md"),
    "utf8",
  );
  assert.ok(html.includes("重要业务细节。".repeat(100)));
  assert.ok(html.includes("按业务任务理解并使用系统。"));
  assert.ok(html.includes("仅审批角色可以提交"));
  assert.ok(md.includes("[章节a](#chapter-a)"));
  assert.ok(md.includes('<a id="chapter-a"></a>'));
  flow.resume();
  assert.ok(
    flow.task.chapters.every((chapter) => chapter.status === "generated"),
  );
});

test("部分失败可发布明确部分指南，全受阻不能伪装生成成功，不能跨任务拼接文档", async () => {
  const flow = await workflow(spec("a"), spec("b"), spec("c", ["b"]));
  await finish(flow, "a");
  flow.fail("b", flow.begin("b"), "缺少有审批权限的测试账号", true);
  flow.blockUnresolved();
  const guide = await flow.assemble();
  assert.equal(guide?.complete, false);
  assert.equal(flow.task.status, "partial");
  assert.ok(guide?.limitations.some((s) => s.includes("依赖章节未完成")));
  const allBlocked = await workflow(spec("a"));
  allBlocked.fail("a", allBlocked.begin("a"), "没有有效测试登录态", true);
  assert.equal(await allBlocked.assemble(), undefined);
  assert.equal(allBlocked.task.status, "failed");
  const bad = await workflow(spec("x"));
  const documentId = await finish(bad, "x");
  const file = path.join(
    projectDir(bad.task.projectId),
    "documents",
    documentId + ".json",
  );
  const doc = await json<Record<string, unknown>>(file);
  await atomic(file, { ...doc, guideTaskId: randomUUID() });
  await assert.rejects(bad.assemble(), /归属或版本/);
});

test("工具权限由宿主阶段控制，QA/聊天无画框，规划无业务写入和文档提交", () => {
  assert.equal(allowedConversationTool("image_annotate", "chapter"), true);
  assert.equal(allowedConversationTool("image_annotate", "planner"), false);
  assert.equal(allowedConversationTool("image_annotate"), false);
  assert.equal(allowedConversationTool("document_write", "planner"), false);
  assert.equal(allowedConversationTool("document_write"), false);
  assert.equal(allowedConversationTool("guide_outline", "planner"), true);
  assert.equal(allowedConversationTool("guide_outline", "chapter"), false);
  assert.equal(
    allowedConversationTool("quick_start_publish", "chapter"),
    false,
  );
  assert.equal(explorationAction("fill"), false);
  assert.equal(explorationAction("click"), false);
  assert.equal(explorationAction("expand"), true);
});
