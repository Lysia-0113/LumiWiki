import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "../src/config.js";
import { createProject } from "../src/store.js";
import {
  connectBrowser,
  getBrowser,
  closeAllBrowsers,
  act,
} from "../src/browser.js";
import { ask, disposeConversations } from "../src/agent.js";
import { saveQa } from "../src/qa.js";

const tmp = await mkdtemp(path.join(os.tmpdir(), "lumiwiki-vision-"));
config.data = tmp;
after(async () => {
  await disposeConversations();
  await closeAllBrowsers();
  await rm(tmp, { recursive: true, force: true });
});

test("真实 Pi 请求发送遮挡后的图片及有效 ref；QA 只有文字；关闭视觉后仅发送文字", async () => {
  const target = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<main><label>密码<input type="password" value="vision-password"></label><div data-private style="width:180px;height:40px">vision-private</div><button>打开设置</button></main>',
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  let requests: any[] = [];
  const provider = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const tool =
      requests.length === 1
        ? "browser_observe"
        : requests.length === 2
          ? "browser_screenshot"
          : null;
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "vision-" + requests.length,
              type: "function",
              function: { name: tool, arguments: "{}" },
            },
          ],
        }
      : {
          role: "assistant",
          content: "点击「打开设置」，查看当前可用的设置项目。",
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "vision", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  config.llm = {
    baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    key: "fixture",
    model: "fixture",
  };
  const project = await createProject({
    name: "vision fixture",
    url: `http://127.0.0.1:${(target.address() as any).port}`,
  });
  const browser = await connectBrowser(project, true),
    session = getBrowser(browser.id, project.key);
  const passwordBox = (await session.page.locator("input").boundingBox())!;
  const privateBox = (await session.page
    .locator("[data-private]")
    .boundingBox())!;
  try {
    for (const scenario of [
      { vision: true, publicMode: false },
      { vision: false, publicMode: false },
      { vision: true, publicMode: true },
    ]) {
      config.vision = scenario.vision;
      requests = [];
      const events: Array<Record<string, any>> = [];
      await ask(
        project,
        {
          question: "怎么打开设置？",
          browserId: browser.id,
          mode: scenario.publicMode ? undefined : "qa",
        },
        (event) => events.push(event),
        AbortSignal.timeout(20000),
        scenario.publicMode,
      );
      assert.equal(requests.length, 3);
      const imageParts = (request: any) =>
        request.messages
          .flatMap((message: any) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part: any) => part.type === "image_url");
      assert.equal(imageParts(requests[1]).length, scenario.vision ? 1 : 0);
      assert.equal(imageParts(requests[2]).length, scenario.vision ? 2 : 0);
      assert.ok(!JSON.stringify(requests).includes("vision-password"));
      assert.ok(!JSON.stringify(requests).includes("vision-private"));
      assert.ok(
        requests[0].tools.every(
          (tool: any) =>
            ![
              "document_write",
              "quick_start_plan",
              "quick_start_publish",
            ].includes(tool.function.name),
        ),
      );
      if (scenario.vision) {
        const url = imageParts(requests[1])[0].image_url.url;
        assert.ok(url.startsWith("data:image/png;base64,"));
        const png = Buffer.from(url.split(",")[1], "base64");
        const metadata = await sharp(png).metadata();
        assert.equal(metadata.width, 1280);
        assert.equal(metadata.height, 800);
        for (const box of [passwordBox, privateBox]) {
          const pixel = await sharp(png)
            .extract({
              left: Math.floor(box.x + box.width / 2),
              top: Math.floor(box.y + box.height / 2),
              width: 1,
              height: 1,
            })
            .removeAlpha()
            .raw()
            .toBuffer();
          assert.deepEqual([...pixel], [255, 0, 255]);
        }
      }
      const observation = requests[1].messages.find(
        (message: any) =>
          message.role === "tool" && message.tool_call_id === "vision-1",
      );
      assert.ok(observation);
      const snapshot = JSON.parse(observation.content);
      const control = snapshot.elements.find(
        (element: any) => element.label === "打开设置",
      );
      // Observation images must not invalidate the refs supplied in the same result.
      if (scenario.vision) assert.ok(control.ref);
      const final = events.find((event) => event.type === "done")!.result
        .answer;
      assert.equal(typeof final, "string");
      assert.ok(!final.includes("data:image"));
      const qa = await saveQa(project.key, {
        question: "怎么打开设置？",
        answer: final,
      });
      assert.equal(qa.answer, final);
      // The explicit screenshot provides its own newest refs; they remain usable.
      const screenshotResult = requests[2].messages
        .filter((message: any) => message.role === "tool")
        .at(-1);
      const screenshot = JSON.parse(screenshotResult.content);
      const button = screenshot.elements.find(
        (element: any) => element.label === "打开设置",
      );
      await act(session, { action: "click", ref: button.ref });
      await disposeConversations();
    }
  } finally {
    target.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => target.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
  }
});
