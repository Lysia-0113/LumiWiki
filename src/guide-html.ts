import { escapeHtml as escape, documentStyle } from "./documents.js";

// Module HTML is produced by our document renderer, not model-authored HTML.
// Keep the complete body (including figures/legends and long chapter guidance).
function moduleBody(html: string) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  if (main) return main[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return (body?.[1] ?? html)
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<\/?(?:html|body)\b[^>]*>/gi, "");
}

export function renderGuideHtml(
  title: string,
  modules: Array<{ id: string; title: string; html: string }>,
  limitations: string[] = [],
  introduction?: { overview: string; audience: string },
) {
  return (
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>${documentStyle}</style><main><h1>${escape(title)}</h1>` +
    (introduction
      ? `<p>${escape(introduction.overview)}</p><p><strong>适用对象：</strong>${escape(introduction.audience)}</p>`
      : "") +
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
      .map((m) => {
        let body = moduleBody(m.html);
        if (modules.length === 1)
          body = body.replace(`<h1>${escape(title)}</h1>`, "");
        // One pass also demotes nested troubleshooting headings without repeated
        // replacements accidentally demoting the same heading more than once.
        body = body.replace(
          /<(\/?)h([1-6])(\b[^>]*)>/gi,
          (_, close: string, level: string, attributes: string) => {
            const next =
              modules.length > 1
                ? Math.min(6, Number(level) + 1)
                : Math.max(2, Number(level));
            return `<${close}h${next}${attributes}>`;
          },
        );
        return `<section id="${escape(m.id)}">${body}</section>`;
      })
      .join("") +
    "</main></html>"
  );
}
