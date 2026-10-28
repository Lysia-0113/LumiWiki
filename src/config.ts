import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  data: path.resolve(process.env.DATA_DIR || ".webdemo"),
  token: process.env.QA_ADMIN_TOKEN || "",
  llm: {
    baseUrl: process.env.LLM_BASE_URL || "",
    key: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
  },
  wikiLimit: Number(process.env.WIKI_FULL_INJECT_MAX_CHARS || 30000),
  maxTools: Number(process.env.MAX_TOOL_CALLS || 30),
  quickStartMaxTools: Number(process.env.QUICK_START_MAX_TOOL_CALLS || 120),
  quickStartMaxTokens: Number(process.env.QUICK_START_MAX_TOKENS || 8192),
  timeout: Number(process.env.RUN_TIMEOUT_SECONDS || 180),
  deepwiki: (process.env.DEEPWIKI_BASE_URL || "http://127.0.0.1:8001").replace(
    /\/$/,
    "",
  ),
};
export const modelReady = () =>
  Boolean(config.llm.baseUrl && config.llm.key && config.llm.model);
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function ensure(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new HttpError(status, message);
}
