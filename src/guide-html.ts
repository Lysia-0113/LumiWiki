import { escapeHtml as escape, documentStyle } from "./documents.js";
export function renderGuideHtml(
  title: string,
  modules: Array<{ id: string; title: string; html: string }>,
  limitations: string[] = [],
) {
  return (
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>${documentStyle}</style><h1>${escape(title)}</h1>` +
    (modules.length > 1
      ? '<nav aria-label="模块目录"><ol>' +
        modules
          .map(
            (m) => `<li><a href="#${escape(m.id)}">${escape(m.title)}</a></li>`,
          )
          .join("") +
        "</ol></nav>"
      : "") +
    (limitations.length
      ? `<aside aria-label="使用提示"><strong>使用提示</strong><ul>${limitations.map((x) => `<li>${escape(x)}</li>`).join("")}</ul></aside>`
      : "") +
    modules
      .map(
        (m) =>
          `<section id="${escape(m.id)}">${(
            m.html.match(/<main>([\s\S]*?)<\/main>/)?.[1] ||
            m.html.slice(m.html.indexOf("<h1>")).replace(/<\/html>\s*$/, "")
          )
            .replace(
              modules.length === 1
                ? `<h1>${escape(title)}</h1>`
                : "<!--none-->",
              "",
            )
            .replace(/<h2>/g, modules.length > 1 ? "<h3>" : "<h2>")
            .replace(/<\/h2>/g, modules.length > 1 ? "</h3>" : "</h2>")
            .replace(/<h1>/g, "<h2>")
            .replace(/<\/h1>/g, "</h2>")}</section>`,
      )
      .join("") +
    "</html>"
  );
}
