import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";
import { config } from "../src/config.js";
import { atomic, createProject, projectDir } from "../src/store.js";
import { createServer } from "../src/server.js";
import { saveQa, listQa } from "../src/qa.js";
import {
  publishGuide,
  listPublications,
  publicGuide,
  publicGuideImage,
} from "../src/publications.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-publications-"));
config.data = tmp;
config.token = "publication-fixture";
config.deepwiki = "http://127.0.0.1:1";
const app = createServer();
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
config.port = (app.address() as any).port;
const origin = `http://127.0.0.1:${config.port}`;
after(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});
async function request(
  route: string,
  data?: unknown,
  method = data ? "POST" : "GET",
  admin = true,
) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { "X-QA-Admin-Token": config.token } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    response,
    data: response.headers.get("Content-Type")?.includes("json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer()),
  };
}
async function fixture(name = "项目指南") {
  const project = await createProject({
    name,
    url: "http://127.0.0.1:8081",
    publicBrowser: { enabled: false },
  });
  const id = randomUUID(),
    docId = randomUUID(),
    imageId = randomUUID(),
    privateImageId = randomUUID();
  const png = await sharp({
    create: { width: 90, height: 50, channels: 3, background: "#286451" },
  })
    .png()
    .toBuffer();
  await mkdir(path.join(projectDir(project.key), "artifacts"), {
    recursive: true,
  });
  for (const image of [imageId, privateImageId])
    await writeFile(
      path.join(projectDir(project.key), "artifacts", image + ".png"),
      png,
    );
  const doc = {
    id: docId,
    moduleId: "first",
    title: "创建记录",
    summary: "完成第一条记录",
    steps: [
      { title: "输入内容", instruction: "填写内容后点击保存。", imageId },
    ],
    references: [{ kind: "doc", location: "INTERNAL-SOURCE-PATH" }],
    audit: "INTERNAL-AUDIT",
    credential: "INTERNAL-CREDENTIAL",
  };
  await atomic(
    path.join(projectDir(project.key), "documents", docId + ".json"),
    doc,
  );
  const guide = {
    id,
    title: name,
    summary: "给第一次使用的用户",
    modules: [{ id: "first", title: "创建记录", documentId: docId }],
    verification: { published: true, audit: "INTERNAL-VERIFICATION" },
    privateRepo: "/private/internal/source",
    qaGeneration: { status: "completed", qaIds: ["private-qa-id"] },
    createdAt: new Date().toISOString(),
  };
  await atomic(
    path.join(projectDir(project.key), "guides", id + ".json"),
    guide,
  );
  return {
    project,
    id,
    docId,
    imageId,
    privateImageId,
    png,
    doc,
    base: `/api/projects/${project.key}`,
    publicBase: `/api/v1/public/guides/${id}?project=${project.key}`,
  };
}

test("生成与 QA 审核不会公开指南；发布接口必须有管理口令且明确确认审核", async () => {
  const f = await fixture("发布权限");
  await saveQa(f.project.key, {
    question: "已审核问题",
    answer: "文字答案",
    status: "verified",
  });
  assert.equal(
    (
      await request(
        `/api/v1/public/guides?project=${f.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).data.items.length,
    0,
  );
  assert.equal(
    (await request(f.publicBase, undefined, "GET", false)).response.status,
    404,
  );
  assert.equal(
    (
      await request(
        f.base + "/guides/" + f.id + ".json",
        undefined,
        "GET",
        false,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request(
        f.base + "/publications",
        { id: f.id, kind: "guides", reviewed: true },
        "POST",
        false,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (
      await request(f.base + "/publications", {
        id: f.id,
        kind: "guides",
        reviewed: false,
      })
    ).response.status,
    400,
  );
  const draftQa = await saveQa(f.project.key, {
    question: "尚未审核的问题",
    answer: "草稿答案",
    status: "draft",
  });
  const result = await request(f.base + "/publications", {
    id: f.id,
    kind: "guides",
    reviewed: true,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, "published");
  assert.equal(result.data.version, 1);
  const detail = await request(f.publicBase, undefined, "GET", false);
  assert.equal(detail.response.status, 200);
  assert.equal(
    detail.data.modules[0].steps[0].instruction,
    f.doc.steps[0].instruction,
  );
  const serialized = JSON.stringify(detail.data);
  for (const hidden of [
    "INTERNAL-SOURCE-PATH",
    "INTERNAL-AUDIT",
    "INTERNAL-CREDENTIAL",
    "INTERNAL-VERIFICATION",
    "private-qa-id",
    "privateRepo",
    f.docId,
  ])
    assert.ok(!serialized.includes(hidden));
  const image = await request(
    `/api/v1/public/guides/${f.id}/images/${f.imageId}?project=${f.project.key}&version=1`,
    undefined,
    "GET",
    false,
  );
  assert.equal(image.response.status, 200);
  assert.deepEqual(image.data, f.png);
  assert.equal(
    (
      await request(
        `/api/v1/public/guides/${f.id}/images/${f.privateImageId}?project=${f.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).response.status,
    404,
  );
  assert.equal(
    (
      await request(
        f.base + "/artifacts/" + f.imageId + ".png",
        undefined,
        "GET",
        false,
      )
    ).response.status,
    403,
  );
  const questions = await listQa(f.project.key);
  assert.equal(
    questions.find((item) => item.id === draftQa.id)?.status,
    "draft",
  );
  assert.ok(questions.some((item) => item.status === "verified"));
});

test("发布快照与草稿隔离；重复审核幂等，更新发布生成新版本，撤回阻断正文及所有图片", async () => {
  const f = await fixture("快照与撤回");
  const reviews = await Promise.all([
    publishGuide(f.project.key, "guides", f.id, true),
    publishGuide(f.project.key, "guides", f.id, true),
  ]);
  assert.equal(reviews[0].version, 1);
  assert.equal(reviews[1].version, 1);
  await atomic(
    path.join(projectDir(f.project.key), "documents", f.docId + ".json"),
    {
      ...f.doc,
      steps: [{ ...f.doc.steps[0], instruction: "修改后的操作说明。" }],
    },
  );
  assert.equal(
    (await request(f.publicBase, undefined, "GET", false)).data.modules[0]
      .steps[0].instruction,
    "填写内容后点击保存。",
  );
  const updated = await request(f.base + "/publications", {
    kind: "guides",
    id: f.id,
    reviewed: true,
  });
  assert.equal(updated.data.version, 2);
  assert.equal(
    (await request(f.publicBase, undefined, "GET", false)).data.modules[0]
      .steps[0].instruction,
    "修改后的操作说明。",
  );
  assert.equal(
    (
      await request(
        `/api/v1/public/guides/${f.id}/images/${f.imageId}?project=${f.project.key}&version=1`,
        undefined,
        "GET",
        false,
      )
    ).response.status,
    200,
  );
  assert.equal(
    (
      await request(
        f.base + "/publications/" + f.id,
        undefined,
        "DELETE",
        false,
      )
    ).response.status,
    403,
  );
  assert.equal(
    (await request(f.base + "/publications/" + f.id, undefined, "DELETE"))
      .response.status,
    200,
  );
  assert.equal(
    (await request(f.publicBase, undefined, "GET", false)).response.status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/v1/public/guides?project=${f.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).data.items.length,
    0,
  );
  for (const version of [1, 2])
    assert.equal(
      (
        await request(
          `/api/v1/public/guides/${f.id}/images/${f.imageId}?project=${f.project.key}&version=${version}`,
          undefined,
          "GET",
          false,
        )
      ).response.status,
      404,
    );
  const republished = await request(f.base + "/publications", {
    id: f.id,
    kind: "guides",
    reviewed: true,
  });
  assert.equal(republished.data.version, 3);
});

test("缺失图片不能发布或覆盖现有公开版本，单篇文档也可审核发布", async () => {
  const f = await fixture("截图完整性");
  await publishGuide(f.project.key, "guides", f.id, true);
  await atomic(
    path.join(projectDir(f.project.key), "documents", f.docId + ".json"),
    { ...f.doc, steps: [{ ...f.doc.steps[0], imageId: randomUUID() }] },
  );
  assert.equal(
    (
      await request(f.base + "/publications", {
        id: f.id,
        kind: "guides",
        reviewed: true,
      })
    ).response.status,
    409,
  );
  assert.equal(
    (await request(f.publicBase, undefined, "GET", false)).data.version,
    1,
  );
  await atomic(
    path.join(projectDir(f.project.key), "documents", f.docId + ".json"),
    f.doc,
  );
  const doc = await request(f.base + "/publications", {
    id: f.docId,
    kind: "documents",
    reviewed: true,
  });
  assert.equal(doc.response.status, 200);
  assert.equal(
    (
      await request(
        `/api/v1/public/guides/${f.docId}?project=${f.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).data.modules.length,
    1,
  );
  assert.equal((await listPublications(f.project.key)).length, 2);
});

test("用户链接绑定项目，切换管理台不改变指南和 QA；不能跨项目读取正文和图片", async () => {
  const a = await fixture("固定项目 A");
  await publishGuide(a.project.key, "guides", a.id, true);
  await saveQa(a.project.key, {
    question: "项目问题",
    answer: "项目 A 的答案",
    status: "verified",
  });
  const b = await fixture("固定项目 B");
  await publishGuide(b.project.key, "guides", b.id, true);
  await saveQa(b.project.key, {
    question: "项目问题",
    answer: "项目 B 的答案",
    status: "verified",
  });
  assert.equal(
    (
      await request(
        `/api/v1/public/config?project=${a.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).data.name,
    "固定项目 A",
  );
  assert.equal(
    (
      await request(
        `/api/v1/public/guides?project=${a.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).data.items[0].title,
    "固定项目 A",
  );
  assert.equal(
    (
      await request(
        `/api/v1/public/guides/${a.id}?project=${b.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).response.status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/v1/public/guides/${a.id}/images/${a.imageId}?project=${b.project.key}`,
        undefined,
        "GET",
        false,
      )
    ).response.status,
    404,
  );
  const response = await fetch(
    origin + `/api/v1/public/ask?project=${a.project.key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "项目问题" }),
    },
  );
  const events = await response.text();
  assert.ok(events.includes("项目 A 的答案"));
  assert.ok(!events.includes("项目 B 的答案"));
  const pub = await request(
    `/api/v1/public/qa?project=${a.project.key}`,
    undefined,
    "GET",
    false,
  );
  assert.equal(pub.data.items[0].answer, "项目 A 的答案");
});

test("完整章节的多图、预期结果与依据进入公开快照", async () => {
  const project = await createProject({
    name: "多图指南",
    url: "http://127.0.0.1:8081",
    publicBrowser: { enabled: false },
  });
  const guideId = randomUUID(),
    docId = randomUUID(),
    firstImage = randomUUID(),
    secondImage = randomUUID();
  const png = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  await mkdir(path.join(projectDir(project.key), "artifacts"), {
    recursive: true,
  });
  for (const imageId of [firstImage, secondImage])
    await writeFile(
      path.join(projectDir(project.key), "artifacts", imageId + ".png"),
      png,
    );
  await atomic(
    path.join(projectDir(project.key), "documents", docId + ".json"),
    {
      id: docId,
      moduleId: "multi",
      title: "多图步骤",
      summary: "两步合一",
      steps: [
        {
          title: "查看入口",
          instruction: "先看按钮位置。",
          expectedResult: "看到保存按钮。",
          images: [
            { imageId: firstImage, caption: "入口" },
            { imageId: secondImage },
          ],
        },
      ],
    },
  );
  await atomic(
    path.join(projectDir(project.key), "guides", guideId + ".json"),
    {
      id: guideId,
      title: "多图指南",
      overview: "完整说明",
      audience: ["新用户"],
      prerequisites: ["已登录"],
      modules: [{ id: "multi", title: "多图步骤", documentId: docId }],
      limitations: [],
    },
  );
  const publication = await publishGuide(project.key, "guides", guideId, true);
  assert.equal(publication.version, 1);
  const snapshot = await publicGuide(project.key, guideId);
  assert.equal(snapshot.summary, "完整说明");
  assert.deepEqual(snapshot.audience, ["新用户"]);
  assert.deepEqual(snapshot.prerequisites, ["已登录"]);
  assert.equal(snapshot.modules[0].steps[0].expectedResult, "看到保存按钮。");
  assert.equal(snapshot.modules[0].steps[0].imageId, firstImage);
  assert.deepEqual(snapshot.modules[0].steps[0].images, [
    { imageId: firstImage, caption: "入口" },
    { imageId: secondImage },
  ]);
  assert.ok(
    (await publicGuideImage(project.key, guideId, secondImage)).equals(png),
  );
});

test("页面贯通审核发布、图文阅读、撤回和重新发布，用户 QA 仍为文字", async () => {
  const f = await fixture("页面发布验收");
  await saveQa(f.project.key, {
    question: "如何操作？",
    answer: "打开页面，填写内容并保存。",
    status: "verified",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const admin = await browser.newPage({
        viewport: { width: 1440, height: 1050 },
      }),
      errors: string[] = [];
    admin.on("pageerror", (error) => errors.push(error.message));
    await admin.goto(origin);
    await admin.locator("#token").fill(config.token);
    await admin.locator("#auth-form button").click();
    await admin
      .locator("#outputs button")
      .filter({ hasText: "页面发布验收" })
      .click();
    await admin
      .getByRole("button", { name: "审核并发布", exact: true })
      .click();
    await mkdir(path.join(process.cwd(), ".webdemo", "verification"), {
      recursive: true,
    });
    await admin.screenshot({
      path: path.join(
        process.cwd(),
        ".webdemo",
        "verification",
        "publication-review.png",
      ),
      fullPage: true,
    });
    await admin.locator("#publication-reviewed").check();
    await admin.locator("#publication-form button.primary").click();
    await admin
      .getByRole("button", { name: "撤回发布", exact: true })
      .waitFor();
    const user = await browser.newPage();
    user.on("pageerror", (error) => errors.push(error.message));
    await user.goto(origin + `/user?project=${f.project.key}&guide=${f.id}`);
    await user
      .locator("#public-guide-detail h2")
      .filter({ hasText: "页面发布验收" })
      .waitFor();
    await user.locator("#public-guide-detail img").waitFor();
    await user.waitForFunction(() => {
      const image = document.querySelector(
        "#public-guide-detail img",
      ) as HTMLImageElement;
      return image.complete && image.naturalWidth === 90;
    });
    await user.screenshot({
      path: path.join(
        process.cwd(),
        ".webdemo",
        "verification",
        "public-guide.png",
      ),
      fullPage: true,
    });
    assert.equal(
      await user
        .locator("#public-guide-detail")
        .getByText("填写内容后点击保存。", { exact: true })
        .count(),
      1,
    );
    await user.locator('[data-public-view="qa"]').click();
    await user.locator("#user-question").fill("如何操作？");
    await user.locator("#user-submit").click();
    await user
      .locator(".message.answer")
      .filter({ hasText: "打开页面，填写内容并保存。" })
      .waitFor();
    assert.equal(await user.locator("#user-messages img").count(), 0);
    admin.once("dialog", (dialog) => dialog.accept());
    await admin.getByRole("button", { name: "撤回发布", exact: true }).click();
    await admin
      .getByRole("button", { name: "审核并发布", exact: true })
      .waitFor();
    await user.reload();
    await user
      .locator("#public-guide-detail")
      .getByText("这份指南尚未发布或已经撤回。", { exact: true })
      .waitFor();
    assert.equal(await user.locator("#public-guide-detail img").count(), 0);
    await admin
      .getByRole("button", { name: "审核并发布", exact: true })
      .click();
    await admin.locator("#publication-reviewed").check();
    await admin.locator("#publication-form button.primary").click();
    await admin
      .getByRole("button", { name: "撤回发布", exact: true })
      .waitFor();
    await user.reload();
    await user
      .locator("#public-guide-detail h2")
      .filter({ hasText: "页面发布验收" })
      .waitFor();
    await user.setViewportSize({ width: 390, height: 1000 });
    assert.equal(
      await user.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
