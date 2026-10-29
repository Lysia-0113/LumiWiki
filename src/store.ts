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

export interface PublicBrowserSettings {
  enabled: boolean;
  username: string;
  password: string;
}
export interface Project {
  key: string;
  name: string;
  path: string | null;
  url: string | null;
  createdAt: string;
  publicBrowser?: PublicBrowserSettings;
}
export function publicBrowserSettings(project: Project): PublicBrowserSettings {
  const settings = project.publicBrowser;
  return {
    enabled: settings?.enabled ?? process.env.PUBLIC_BROWSER_ENABLED === "true",
    username: settings?.username ?? process.env.PUBLIC_TEST_USERNAME ?? "",
    password: settings?.password ?? process.env.PUBLIC_TEST_PASSWORD ?? "",
  };
}
function websiteUrl(value: unknown): string | null {
  ensure(value === null || typeof value === "string", "网址无效");
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, "网址无效");
  }
  ensure(["http:", "https:"].includes(url.protocol), "网址必须是 HTTP/HTTPS");
  return value.trim();
}
function parsePublicBrowser(
  input: unknown,
  previous: PublicBrowserSettings,
): PublicBrowserSettings {
  if (input === undefined) return { ...previous };
  ensure(
    input && typeof input === "object" && !Array.isArray(input),
    "问答探索设置无效",
  );
  const data = input as Record<string, unknown>;
  const result = { ...previous };
  if (data.enabled !== undefined) {
    ensure(typeof data.enabled === "boolean", "问答探索开关无效");
    result.enabled = data.enabled;
  }
  ensure(
    data.url === undefined || data.url === null || data.url === "",
    "快速上手与问答共用目标网页，请修改项目目标网页",
    400,
  );
  for (const field of ["username", "password"] as const) {
    if (data[field] !== undefined) {
      ensure(
        typeof data[field] === "string" && data[field].length <= 4000,
        "测试账号无效",
      );
      result[field] = data[field];
    }
  }
  return result;
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
  publicBrowser?: Partial<PublicBrowserSettings>;
}) {
  ensure(
    typeof input.name === "string" &&
      input.name.trim() &&
      input.name.length <= 120,
    "请填写项目名称",
  );
  const repo = input.path ? await realpath(input.path) : null;
  if (repo) ensure((await stat(repo)).isDirectory(), "源码路径必须是目录");
  const p: Project = {
    key: randomUUID(),
    name: input.name.trim(),
    path: repo,
    url: websiteUrl(input.url ?? null),
    createdAt: new Date().toISOString(),
  };
  p.publicBrowser = parsePublicBrowser(
    input.publicBrowser,
    publicBrowserSettings(p),
  );
  await atomic(path.join(projectDir(p.key), "project.json"), p);
  await atomic(path.join(config.data, "deployment.json"), {
    activeProjectId: p.key,
  });
  return p;
}
export async function updateProject(
  id: string,
  input: {
    name?: string;
    url?: string | null;
    publicBrowser?: Partial<PublicBrowserSettings>;
    path?: unknown;
  },
) {
  ensure(input.path === undefined, "源码路径创建后不可修改");
  const project = await getProject(id);
  if (input.name !== undefined) {
    ensure(
      typeof input.name === "string" &&
        input.name.trim() &&
        input.name.length <= 120,
      "名称无效",
    );
    project.name = input.name.trim();
  }
  if (input.url !== undefined) project.url = websiteUrl(input.url);
  project.publicBrowser = parsePublicBrowser(
    input.publicBrowser,
    publicBrowserSettings(project),
  );
  await atomic(path.join(projectDir(id), "project.json"), project);
  return project;
}
export async function migrateProjectSettings() {
  const projects = await listProjects();
  for (const project of projects) {
    if (!project.publicBrowser || "url" in project.publicBrowser)
      await updateProject(project.key, {});
  }
  return projects;
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
