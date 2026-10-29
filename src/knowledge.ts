import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { config, ensure } from "./config.js";
import { atomic, json, projectDir, sourcePath, type Project } from "./store.js";

export interface WikiPage {
  id: string;
  index: number;
  title: string;
  headings: string[];
  start: number;
  end: number;
  chars: number;
  sources: string[];
}
export interface WikiFile {
  id: string;
  name: string;
  title: string;
  sha256: string;
  bytes: number;
  importedAt: string;
  totalChars: number;
  pages: WikiPage[];
  stale: string[];
}
export function parseWiki(
  content: string,
  name: string,
  id = randomUUID(),
): WikiFile {
  ensure(
    /\.(md|markdown)$/i.test(name) &&
      name.length <= 120 &&
      !/[\\/]/.test(name) &&
      !name.includes(".."),
    "文件名无效，仅支持 Markdown",
  );
  ensure(
    content.trim() && Buffer.byteLength(content) <= 2 * 1024 * 1024,
    "文件不能为空，且不能超过 2MB",
  );
  const lines = [...content.matchAll(/^.*(?:\r?\n|$)/gm)].filter((m) => m[0]);
  const firstAnchor = content.search(/^<a\s+id=['"]/m);
  const exportPageIds = new Set(
    content.startsWith("# Wiki Documentation for ") && firstAnchor >= 0
      ? [
          ...content
            .slice(0, firstAnchor)
            .matchAll(/^- \[[^\]\n]+\]\(#([^\s)]+)\)\s*$/gm),
        ].map((m) => m[1])
      : [],
  );
  let fence = "";
  const visible: typeof lines = [];
  for (const line of lines) {
    const anchor = line[0].match(/^<a\s+id=['"]([^'"<>]+)['"]\s*>\s*<\/a>/);
    if (anchor && exportPageIds.has(anchor[1])) {
      fence = "";
      visible.push(line);
      continue;
    }
    const f = line[0].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
      continue;
    }
    if (!fence) visible.push(line);
  }
  let marks = visible
    .filter((m) => /^# Page:\s*\S/.test(m[0]))
    .map((m) => ({
      start: m.index!,
      title: m[0].replace(/^# Page:\s*/, "").trim(),
    }));
  if (!marks.length) {
    marks = visible
      .filter((m) => /^<a\s+id=['"][^'"<>]+['"]\s*>\s*<\/a>/.test(m[0]))
      .map((m) => {
        const next = visible.find(
          (n) => n.index! > m.index! && /^##\s+/.test(n[0]),
        );
        return {
          start: m.index!,
          title: next?.[0].replace(/^##\s+/, "").trim() || name,
        };
      });
  }
  const title =
    visible
      .find((m) => /^#\s+/.test(m[0]))?.[0]
      .replace(/^#\s+/, "")
      .trim() || name;
  if (!marks.length) marks = [{ start: 0, title }];
  const pages = marks.map((m, i): WikiPage => {
    const end = marks[i + 1]?.start ?? content.length;
    const body = content.slice(m.start, end);
    const headings = visible
      .filter(
        (l) => l.index! >= m.start && l.index! < end && /^#{2,4}\s+/.test(l[0]),
      )
      .map((l) => l[0].replace(/^#+\s+/, "").trim());
    const sources = [
      ...body.matchAll(
        /\[([^\]\n]+\.(?:go|ts|tsx|js|py|sql|md|json|yaml|yml|html|css)(?::\d+(?:-\d+)?)?)\]\(/g,
      ),
    ]
      .map((x) => x[1])
      .filter(
        (s) =>
          !s.startsWith("/") &&
          !s.split("/").includes("..") &&
          !s.includes("://"),
      );
    return {
      id: `${id}:p${i + 1}`,
      index: i + 1,
      title: m.title,
      headings,
      start: m.start,
      end,
      chars: Array.from(body).length,
      sources: [...new Set(sources)],
    };
  });
  return {
    id,
    name,
    title,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    importedAt: new Date().toISOString(),
    totalChars: pages.reduce((n, p) => n + p.chars, 0),
    pages,
    stale: [],
  };
}
export async function listWiki(projectId: string): Promise<WikiFile[]> {
  const dir = path.join(projectDir(projectId), "wiki");
  try {
    return Promise.all(
      (await readdir(dir))
        .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
        .map((f) => json<WikiFile>(path.join(dir, f))),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
let writes = Promise.resolve();
export async function importWiki(
  project: Project,
  name: string,
  content: string,
) {
  const file = parseWiki(content, name);
  const operation = writes.then(async () => {
    const old = (await listWiki(project.key)).filter((f) => f.name === name);
    if (project.path)
      for (const source of new Set(file.pages.flatMap((p) => p.sources))) {
        try {
          await sourcePath(project, source.replace(/:\d+(?:-\d+)?$/, ""));
        } catch {
          file.stale.push(source);
        }
      }
    const base = path.join(projectDir(project.key), "wiki", file.id);
    await atomic(base + ".md", content, true);
    await atomic(base + ".json", file);
    for (const f of old) await deleteWiki(project.key, f.id);
    return file;
  });
  writes = operation.then(
    () => {},
    () => {},
  );
  return operation;
}
export async function deleteWiki(projectId: string, id: string) {
  ensure(/^[a-f0-9-]{36}$/.test(id), "文件标识无效");
  const base = path.join(projectDir(projectId), "wiki", id);
  await rm(base + ".json", { force: true });
  await rm(base + ".md", { force: true });
}
export async function readPage(
  projectId: string,
  pageId: string,
  section?: number,
) {
  const files = await listWiki(projectId);
  const file = files.find((f) => f.pages.some((p) => p.id === pageId));
  const page = file?.pages.find((p) => p.id === pageId);
  ensure(file && page, "找不到这一页，请从目录重新选择", 404);
  let body = (
    await readFile(
      path.join(projectDir(projectId), "wiki", file.id + ".md"),
      "utf8",
    )
  ).slice(page.start, page.end);
  if (section !== undefined) {
    const sections = [...body.matchAll(/^#{2,4}\s+.+$/gm)];
    ensure(
      Number.isInteger(section) && section >= 1 && section <= sections.length,
      "小节编号无效",
    );
    body = body.slice(
      sections[section - 1].index,
      sections[section]?.index ?? body.length,
    );
  }
  const truncated = Array.from(body).length > 20000;
  return {
    pageId,
    fileId: file.id,
    sha256: file.sha256,
    citation: { kind: "doc" as const, location: pageId },
    ref: `wiki/${file.name}#${page.title}`,
    title: page.title,
    section,
    truncated,
    content: truncated ? Array.from(body).slice(0, 12000).join("") : body,
    headings: page.headings,
    sources: page.sources,
  };
}
export async function wikiContext(projectId: string, catalogOnly = false) {
  const files = await listWiki(projectId);
  const total = files.reduce((n, f) => n + f.totalChars, 0);
  const full = !catalogOnly && total <= config.wikiLimit;
  const pages = files.flatMap((f) => f.pages);
  const content = full
    ? (
        await Promise.all(
          files.map(async (f) => {
            const raw = await readFile(
              path.join(projectDir(projectId), "wiki", f.id + ".md"),
              "utf8",
            );
            return f.pages
              .map(
                (p) =>
                  `${p.id}｜wiki/${f.name}#${p.title}\n${raw.slice(p.start, p.end)}`,
              )
              .join("\n\n");
          }),
        )
      ).join("\n\n")
    : pages
        .map((p) => `${p.id}｜${p.title}｜${p.headings.join("；")}`)
        .join("\n");
  return {
    full,
    pages,
    content,
    files: files.length,
    chars: total,
    evidence: files.flatMap((file) =>
      file.pages.map((page) => ({
        kind: "doc" as const,
        location: page.id,
        fileId: file.id,
        sha256: file.sha256,
      })),
    ),
  };
}
