import { config, ensure } from "./config.js";
import { importWiki } from "./knowledge.js";
import { type Project } from "./store.js";

export async function deepwikiRequest(route: string, body?: unknown) {
  const response = await fetch(config.deepwiki + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  ensure(response.ok, `DeepWiki 请求失败（${response.status}）`, 502);
  return response;
}
export async function submitWiki(project: Project) {
  ensure(project.path, "自动生成 Wiki 需要源码目录");
  const model = process.env.DEEPWIKI_MODEL || config.llm.model;
  ensure(model, "请先填写 DEEPWIKI_MODEL 或 LLM_MODEL");
  return (
    await deepwikiRequest("/wiki/tasks", {
      repo_url: project.path,
      type: "local",
      owner: "lumiwiki",
      repo: project.key,
      provider: process.env.DEEPWIKI_PROVIDER || "openai",
      model,
      language: "zh",
      comprehensive: true,
      excluded_dirs: [
        "docs/report-work",
        "node_modules",
        ".git",
        ".venv",
        ".webdemo",
      ],
    })
  ).json();
}
export async function wikiTask(project: Project, taskId: string) {
  const task = await (
    await deepwikiRequest("/wiki/tasks/" + encodeURIComponent(taskId))
  ).json();
  ensure(
    task.owner === "lumiwiki" && task.repo === project.key,
    "任务不属于当前项目",
    404,
  );
  return task;
}
export async function importGeneratedWiki(project: Project) {
  const query = new URLSearchParams({
    owner: "lumiwiki",
    repo: project.key,
    repo_type: "local",
    language: "zh",
  });
  const cache = await (
    await deepwikiRequest("/api/wiki_cache?" + query)
  ).json();
  ensure(cache?.generated_pages, "Wiki 尚未生成完成");
  const response = await deepwikiRequest("/export/wiki", {
    repo_url: project.path,
    pages: Object.values(cache.generated_pages),
    format: "markdown",
  });
  return importWiki(project, "generated-wiki.md", await response.text());
}
