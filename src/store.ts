import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  realpath,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, ensure, HttpError } from "./config.js";

export interface Project {
  key: string;
  name: string;
  path: string | null;
  url: string | null;
  createdAt: string;
}
export const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
export function projectDir(id: string) {
  ensure(validId(id), "项目标识无效");
  return path.join(config.data, "projects", id);
}
export async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8"));
}
export async function atomic(file: string, value: unknown, raw = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, raw ? String(value) : JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function getProject(id: string) {
  try {
    return await json<Project>(path.join(projectDir(id), "project.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new HttpError(404, "项目不存在");
    throw e;
  }
}
export async function listProjects() {
  await mkdir(path.join(config.data, "projects"), { recursive: true });
  const entries = await readdir(path.join(config.data, "projects"));
  return Promise.all(entries.filter(validId).map(getProject));
}
export async function createProject(input: {
  name: string;
  path?: string;
  url?: string;
}) {
  ensure(
    typeof input.name === "string" &&
      input.name.trim() &&
      input.name.length <= 120,
    "请填写项目名称",
  );
  const repo = input.path ? await realpath(input.path) : null;
  if (repo) ensure((await stat(repo)).isDirectory(), "源码路径必须是目录");
  if (input.url)
    ensure(
      ["http:", "https:"].includes(new URL(input.url).protocol),
      "网址必须是 HTTP/HTTPS",
    );
  const p: Project = {
    key: randomUUID(),
    name: input.name.trim(),
    path: repo,
    url: input.url || null,
    createdAt: new Date().toISOString(),
  };
  await atomic(path.join(projectDir(p.key), "project.json"), p);
  await atomic(path.join(config.data, "deployment.json"), {
    activeProjectId: p.key,
  });
  return p;
}
export async function activeProject() {
  try {
    const d = await json<{ activeProjectId: string }>(
      path.join(config.data, "deployment.json"),
    );
    return d.activeProjectId;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function sourcePath(project: Project, relative: string) {
  ensure(project.path, "项目未配置源码目录");
  ensure(
    typeof relative === "string" &&
      !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/).includes(".."),
    "路径必须在项目目录中",
  );
  ensure(
    !relative
      .split(/[\\/]/)
      .some((s) => s.startsWith(".") || s === "node_modules"),
    "禁止读取隐藏文件、凭证和依赖目录",
  );
  const result = await realpath(path.resolve(project.path, relative));
  ensure(
    result === project.path || result.startsWith(project.path + path.sep),
    "路径越界",
  );
  return result;
}
