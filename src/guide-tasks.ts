import path from "node:path";
import { readdir } from "node:fs/promises";
import { ensure } from "./config.js";
import { atomic, json, projectDir, validId } from "./store.js";
import type { QuickStartRun } from "./quick-start.js";

export type GuideTaskStatus =
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "partial";
export interface GuideTask {
  version: 1;
  id: string;
  projectId: string;
  sessionId: string;
  question: string;
  status: GuideTaskStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  browserRequired: boolean;
  browserId?: string;
  pendingAction?: {
    tool: string;
    at: string;
    moduleId?: string;
    scenarioId?: string;
  };
  workflow: ReturnType<QuickStartRun["report"]>;
  context: {
    wikiIds: string[];
    screenshotIds: string[];
    documentIds: string[];
    observedUrls: string[];
    seenControls: string[];
    guideIds: string[];
  };
}

// Process-local leases make a crashed "running" task resumable on the next start.
const active = new Set<string>();
const taskKey = (projectId: string, taskId: string) => `${projectId}/${taskId}`;
export function setGuideTaskActive(
  projectId: string,
  taskId: string,
  running: boolean,
) {
  const key = taskKey(projectId, taskId);
  if (running) active.add(key);
  else active.delete(key);
}
export function isGuideTaskActive(projectId: string, taskId: string) {
  return active.has(taskKey(projectId, taskId));
}
export async function saveGuideTask(task: GuideTask) {
  ensure(validId(task.id), "指南任务标识无效");
  task.updatedAt = new Date().toISOString();
  await atomic(
    path.join(projectDir(task.projectId), "tasks", `${task.id}.json`),
    task,
  );
}
export async function getGuideTask(projectId: string, taskId: string) {
  ensure(validId(taskId), "指南任务标识无效");
  let task: GuideTask;
  try {
    task = await json<GuideTask>(
      path.join(projectDir(projectId), "tasks", `${taskId}.json`),
    );
  } catch (error) {
    ensure(
      (error as NodeJS.ErrnoException).code !== "ENOENT",
      "指南任务不存在",
      404,
    );
    throw error;
  }
  ensure(
    task.version === 1 && task.projectId === projectId && task.id === taskId,
    "指南任务不属于当前项目",
  );
  if (task.status === "running" && !isGuideTaskActive(projectId, taskId)) {
    task.status = "paused";
    task.error = "上次运行已中断，可连接网页后继续。";
  }
  return task;
}
export function guideTaskSummary(task: GuideTask) {
  return {
    id: task.id,
    title: task.workflow.plan?.title || "上手指南",
    status: task.status,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    modulesTotal: task.workflow.plan?.modules.length || 0,
    modulesSaved: Object.keys(task.workflow.documents).length,
    scenariosTotal: task.workflow.scenarios.length,
    scenariosVerified: task.workflow.scenarios.filter(
      (s) => s.status === "verified",
    ).length,
    requiresReview: Boolean(task.pendingAction),
    browserRequired: task.browserRequired,
  };
}
export async function listGuideTasks(projectId: string) {
  let names: string[];
  try {
    names = await readdir(path.join(projectDir(projectId), "tasks"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const tasks = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && validId(name.slice(0, -5)))
      .map((name) => getGuideTask(projectId, name.slice(0, -5))),
  );
  return tasks
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(guideTaskSummary);
}
