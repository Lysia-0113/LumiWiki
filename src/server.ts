import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, HttpError, ensure, modelReady } from "./config.js";
import {
  activeProject,
  atomic,
  createProject,
  getProject,
  json,
  listProjects,
  projectDir,
  validId,
} from "./store.js";
import { deleteWiki, importWiki, listWiki, parseWiki } from "./knowledge.js";
import {
  connectBrowser,
  closeBrowser,
  closeAllBrowsers,
  closeProjectBrowsers,
  getBrowser,
  observe,
} from "./browser.js";
import { ask, disposeConversations } from "./agent.js";
import {
  getGuideTask,
  listGuideTasks,
  guideTaskSummary,
} from "./guide-tasks.js";
import {
  deepwikiRequest,
  submitWiki,
  wikiTask,
  importGeneratedWiki,
} from "./deepwiki.js";
import { listQa, matchQa, publicQa, saveQa } from "./qa.js";
import { generateGuideQa } from "./quick-start-qa.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= limit, "请求体过大", 413);
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON 格式无效");
  }
  ensure(
    data && typeof data === "object" && !Array.isArray(data),
    "请求体必须是 JSON 对象",
  );
  return data;
}
function authorized(req: IncomingMessage) {
  const token = String(req.headers["x-qa-admin-token"] || "");
  const a = Buffer.from(token),
    b = Buffer.from(config.token);
  return b.length >= 6 && a.length === b.length && timingSafeEqual(a, b);
}
async function records(projectId: string, kind: string) {
  const dir = path.join(projectDir(projectId), kind);
  try {
    return await Promise.all(
      (await readdir(dir))
        .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
        .map((f) => json<Record<string, unknown>>(path.join(dir, f))),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const host = req.headers.host || "";
      ensure(
        [`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(host),
        "Host 不允许",
        403,
      );
      if (req.headers.origin)
        ensure(req.headers.origin === `http://${host}`, "来源不允许", 403);
      const u = new URL(req.url || "/", "http://" + host),
        route = u.pathname,
        method = req.method || "GET";
      if (
        method === "GET" &&
        ["/", "/user", "/help", "/app.js", "/style.css"].includes(route)
      ) {
        const file = route.endsWith(".js")
          ? "app.js"
          : route.endsWith(".css")
            ? "style.css"
            : "index.html";
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        );
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
        );
        res.end(await readFile(path.join(publicDir, file)));
        return;
      }
      if (route === "/api/v1/public/health") {
        send(res, 200, { status: "ok", name: "LumiWiki" });
        return;
      }
      if (route === "/api/v1/admin/status") {
        const base = {
          name: "LumiWiki",
          modelConfigured: modelReady(),
          embeddingConfigured: Boolean(process.env.EMBEDDING_MODEL),
          judgeConfigured: Boolean(process.env.QA_JUDGE_MODEL),
          publicModelConfigured: Boolean(process.env.PUBLIC_LLM_MODEL),
          adminConfigured: config.token.length >= 6,
        };
        send(
          res,
          200,
          authorized(req)
            ? {
                ...base,
                activeProjectId: await activeProject(),
                model: config.llm.model,
                deepwiki: config.deepwiki,
              }
            : base,
        );
        return;
      }
      const isPublic = route.startsWith("/api/v1/public/");
      if (!isPublic)
        ensure(
          authorized(req),
          "请输入正确的管理口令（.env 中的 QA_ADMIN_TOKEN）",
          403,
        );
      if (route === "/api/projects" && method === "GET") {
        send(res, 200, {
          projects: await listProjects(),
          activeProjectId: await activeProject(),
        });
        return;
      }
      if (route === "/api/projects" && method === "POST") {
        send(res, 201, await createProject(await body(req)));
        return;
      }
      const match = route.match(
        /^\/api\/projects\/([a-f0-9-]{36})(?:\/(.*))?$/,
      );
      if (match) {
        const id = match[1],
          sub = match[2] || "",
          project = await getProject(id);
        if (sub === "activate" && method === "POST") {
          const old = await activeProject();
          if (old && old !== id) {
            await disposeConversations(old);
            await closeProjectBrowsers(old);
          }
          await atomic(path.join(config.data, "deployment.json"), {
            activeProjectId: id,
          });
          send(res, 200, project);
          return;
        }
        if (sub === "wiki" && method === "GET") {
          const files = await listWiki(id);
          send(res, 200, {
            files,
            mode:
              files.reduce((n, f) => n + f.totalChars, 0) <= config.wikiLimit
                ? "full"
                : "catalog",
          });
          return;
        }
        if (sub === "wiki/import" && method === "POST") {
          const input = await body(req, 20 * 1024 * 1024);
          ensure(
            Array.isArray(input.files) &&
              input.files.length >= 1 &&
              input.files.length <= 10,
            "每次导入1至10个文件",
          );
          for (const f of input.files) {
            ensure(
              typeof f.name === "string" && typeof f.content === "string",
              "文件格式无效",
            );
            parseWiki(f.content, f.name);
          }
          const files = [];
          for (const f of input.files)
            files.push(await importWiki(project, f.name, f.content));
          send(res, 201, { files });
          return;
        }
        if (/^wiki\/[a-f0-9-]{36}$/.test(sub) && method === "DELETE") {
          await deleteWiki(id, sub.split("/")[1]);
          send(res, 200, { ok: true });
          return;
        }
        if (sub === "deepwiki/generate" && method === "POST") {
          send(res, 202, await submitWiki(project));
          return;
        }
        if (sub === "deepwiki/import" && method === "POST") {
          send(res, 201, await importGeneratedWiki(project));
          return;
        }
        if (sub.startsWith("deepwiki/tasks/") && method === "GET") {
          send(
            res,
            200,
            await wikiTask(project, sub.slice("deepwiki/tasks/".length)),
          );
          return;
        }
        if (sub === "tasks" && method === "GET") {
          send(res, 200, { items: await listGuideTasks(id) });
          return;
        }
        const taskId = sub.match(/^tasks\/([a-f0-9-]{36})$/);
        if (taskId && method === "GET") {
          const task = await getGuideTask(id, taskId[1]);
          send(res, 200, {
            ...guideTaskSummary(task),
            workflow: task.workflow,
          });
          return;
        }
        if (sub === "qa" && method === "GET") {
          send(res, 200, { items: await listQa(id) });
          return;
        }
        if (sub === "qa" && method === "POST") {
          send(res, 201, await saveQa(id, await body(req)));
          return;
        }
        if (/^qa\/[a-f0-9-]{36}$/.test(sub) && method === "DELETE") {
          await rm(path.join(projectDir(id), sub + ".json"), { force: true });
          send(res, 200, { ok: true });
          return;
        }
        const guideQa = sub.match(/^guides\/([a-f0-9-]{36})\/qa$/);
        if (guideQa && method === "POST") {
          const job = await generateGuideQa(id, guideQa[1], abort.signal);
          send(res, 200, job);
          return;
        }
        if (["documents", "guides", "runs"].includes(sub) && method === "GET") {
          send(res, 200, { items: await records(id, sub) });
          return;
        }
        const file = sub.match(
          /^(wiki|documents|guides|artifacts)\/([a-f0-9-]{36})\.(md|json|html|png)$/,
        );
        if (file && method === "GET") {
          const [, kind, fileId, ext] = file;
          ensure(
            (kind === "wiki" && ["md", "json"].includes(ext)) ||
              (kind === "artifacts" && ext === "png") ||
              (["documents", "guides"].includes(kind) &&
                ["md", "json", "html"].includes(ext)),
            "文件类型无效",
          );
          const data = await readFile(
            path.join(projectDir(id), kind, `${fileId}.${ext}`),
          );
          res.setHeader(
            "Content-Type",
            ext === "html"
              ? "text/html; charset=utf-8"
              : ext === "md"
                ? "text/plain; charset=utf-8"
                : ext === "png"
                  ? "image/png"
                  : "application/json",
          );
          if (ext === "html")
            res.setHeader(
              "Content-Security-Policy",
              "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-src 'self' about:",
            );
          res.end(data);
          return;
        }
        if (!sub && method === "GET") {
          send(res, 200, project);
          return;
        }
        if (!sub && method === "DELETE") {
          await disposeConversations(id);
          await closeProjectBrowsers(id);
          await rm(projectDir(id), { recursive: true });
          if ((await activeProject()) === id)
            await atomic(path.join(config.data, "deployment.json"), {
              activeProjectId: null,
            });
          send(res, 200, { ok: true });
          return;
        }
        if (!sub && method === "PATCH") {
          const data = await body(req);
          ensure(data.path === undefined, "源码路径创建后不可修改");
          if (data.name !== undefined) {
            ensure(
              typeof data.name === "string" && data.name.trim(),
              "名称无效",
            );
            project.name = data.name.trim();
          }
          if (data.url !== undefined) {
            ensure(
              typeof data.url === "string" &&
                ["http:", "https:"].includes(new URL(data.url).protocol),
              "网址无效",
            );
            project.url = data.url;
          }
          await atomic(path.join(projectDir(id), "project.json"), project);
          send(res, 200, project);
          return;
        }
      }
      if (route === "/api/deepwiki/status") {
        try {
          await deepwikiRequest("/");
          send(res, 200, { available: true });
        } catch {
          send(res, 200, { available: false });
        }
        return;
      }
      if (route === "/api/browser" && method === "POST") {
        const data = await body(req);
        send(res, 201, await connectBrowser(await getProject(data.projectKey)));
        return;
      }
      const br = route.match(/^\/api\/browser\/([a-f0-9-]{36})$/);
      if (br) {
        const projectId = u.searchParams.get("projectKey") || "";
        const browser = getBrowser(br[1], projectId);
        ensure(!browser.busy, "浏览器正忙", 409);
        if (method === "DELETE") {
          await closeBrowser(br[1], projectId);
          send(res, 200, { ok: true });
          return;
        }
        if (method === "GET") {
          send(res, 200, await observe(browser));
          return;
        }
      }
      if (route === "/api/ask" && method === "POST") {
        const data = await body(req);
        ensure(
          ["chat", "quick_start"].includes(data.mode || "chat"),
          "当前支持 chat / quick_start",
        );
        ensure(
          data.taskId === undefined ||
            (typeof data.taskId === "string" && validId(data.taskId)),
          "指南任务标识无效",
        );
        ensure(
          data.acknowledgePending === undefined ||
            typeof data.acknowledgePending === "boolean",
          "核对标记无效",
        );
        const project = await getProject(data.projectKey);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        const emit = (e: Record<string, unknown>) => {
          if (!res.destroyed) res.write("data: " + JSON.stringify(e) + "\n\n");
        };
        const keep = setInterval(() => {
          if (!res.destroyed) res.write(": keepalive\n\n");
        }, 15000);
        try {
          await ask(project, data, emit, abort.signal);
        } catch (e) {
          emit({ type: "error", error: (e as Error).message });
        } finally {
          clearInterval(keep);
          res.end();
        }
        return;
      }
      if (isPublic) {
        const active = await activeProject();
        ensure(active, "尚未选择项目", 503);
        const project = await getProject(active);
        if (route === "/api/v1/public/config") {
          send(res, 200, {
            name: project.name,
            recommendedQuestions: (await listQa(active))
              .filter((q) => q.status === "verified")
              .slice(0, 6)
              .map((q) => q.question),
          });
          return;
        }
        if (route === "/api/v1/public/qa" && method === "GET") {
          send(res, 200, {
            items: (await listQa(active))
              .filter((q) => q.status === "verified")
              .map(publicQa),
          });
          return;
        }
        if (route === "/api/v1/public/ask" && method === "POST") {
          const data = await body(req);
          ensure(
            typeof data.question === "string" &&
              data.question.trim() &&
              data.question.length <= 16000,
            "问题无效",
          );
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
          });
          res.flushHeaders();
          const emit = (e: Record<string, unknown>) => {
            if (!res.destroyed)
              res.write("data: " + JSON.stringify(e) + "\n\n");
          };
          let browserId: string | undefined;
          const keep = setInterval(() => {
            if (!res.destroyed) res.write(": keepalive\n\n");
          }, 15000);
          try {
            const matched = await matchQa(active, data.question, abort.signal);
            if (matched.decision === "direct" && matched.qa) {
              emit({
                type: "qa",
                qa: publicQa(matched.qa),
                tier: matched.tier,
                score: matched.score,
              });
              emit({
                type: "done",
                result: {
                  answer: matched.qa.answer,
                  qaId: matched.qa.id,
                  sessionId: null,
                },
              });
            } else {
              if (process.env.PUBLIC_BROWSER_ENABLED === "true") {
                ensure(
                  process.env.PUBLIC_TEST_URL &&
                    project.url === process.env.PUBLIC_TEST_URL,
                  "公共探索必须绑定专用测试网址",
                );
                browserId = (await connectBrowser(project, true)).id;
              }
              await ask(
                project,
                { question: data.question, browserId },
                (e) => {
                  if (
                    ["text", "answer_start", "error", "done"].includes(
                      String(e.type),
                    )
                  )
                    emit(e);
                },
                abort.signal,
                true,
              );
            }
          } catch (e) {
            emit({
              type: "error",
              error: "当前无法完成回答，请联系管理员检查模型和测试环境配置。",
            });
          } finally {
            clearInterval(keep);
            if (browserId)
              await closeBrowser(browserId, active).catch(() => {});
            res.end();
          }
          return;
        }
      }
      throw new HttpError(404, "接口不存在");
    } catch (e) {
      if (!res.headersSent)
        send(
          res,
          e instanceof HttpError
            ? e.status
            : (e as NodeJS.ErrnoException).code === "ENOENT"
              ? 404
              : 500,
          {
            error:
              e instanceof HttpError
                ? e.message
                : (e as NodeJS.ErrnoException).code === "ENOENT"
                  ? "文件不存在"
                  : (e as Error).message,
          },
        );
      else res.end();
    }
  });
}
export async function main() {
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  if (!(await listProjects()).length && process.env.TARGET_REPO)
    await createProject({
      name: path.basename(process.env.TARGET_REPO),
      path: process.env.TARGET_REPO,
      url: process.env.TARGET_URL,
    });
  const server = createServer();
  server.listen(config.port, "127.0.0.1", () =>
    console.log(
      `LumiWiki：http://127.0.0.1:${config.port}（模型${modelReady() ? "已配置" : "待配置"}）`,
    ),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await disposeConversations();
    await closeAllBrowsers();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
