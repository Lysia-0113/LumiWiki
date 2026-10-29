import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { config, ensure } from "./config.js";

// Isolated native Pi session: only the supplied artifact tools and, optionally,
// one explicitly selected bundled skill. Never load user/repository resources.
export async function runArtifactAgent(input: {
  root: string;
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxCalls?: number;
  skill?: string;
  timeoutMs?: number;
  maxTokens?: number;
}) {
  ensure(
    config.llm.baseUrl && config.llm.key && config.llm.model,
    "模型尚未配置",
    503,
  );
  const maxCalls = input.maxCalls ?? 30;
  const timeoutMs = input.timeoutMs ?? 180000;
  const maxTokens = input.maxTokens ?? config.quickStartMaxTokens;
  ensure(Number.isSafeInteger(maxCalls) && maxCalls > 0, "产物工具预算无效");
  ensure(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
    "产物整理超时参数无效",
  );
  ensure(
    Number.isSafeInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 32768,
    "产物输出预算无效",
  );
  let skills: ReturnType<typeof loadSkillsFromDir> = {
    skills: [],
    diagnostics: [],
  };
  if (input.skill !== undefined) {
    ensure(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.skill),
      "产物 Skill 名称无效",
    );
    skills = loadSkillsFromDir({
      dir: fileURLToPath(new URL(`../skills/${input.skill}/`, import.meta.url)),
      source: "project",
    });
    ensure(
      !skills.diagnostics.length &&
        skills.skills.length === 1 &&
        skills.skills[0].name === input.skill,
      "产物 Skill 加载失败",
    );
  }
  const runtime = await ModelRuntime.create({
    authPath: path.join(config.data, "pi-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("lumiwiki", {
    baseUrl: config.llm.baseUrl,
    api: "openai-completions",
    apiKey: config.llm.key,
    models: [
      {
        id: config.llm.model,
        name: config.llm.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 64000),
        maxTokens,
        compat: { supportsStore: false },
      },
    ],
  });
  const empty = new DefaultResourceLoader({
    cwd: input.root,
    agentDir: path.join(config.data, "pi"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await empty.reload();
  const resources: ResourceLoader = {
    getExtensions: () => empty.getExtensions(),
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: input.root,
    agentDir: path.join(config.data, "pi"),
    modelRuntime: runtime,
    model: runtime.getModel("lumiwiki", config.llm.model),
    thinkingLevel: "off",
    tools: input.tools.map((t) => t.name),
    customTools: input.tools.map((tool) => ({
      ...tool,
      execute(...args: Parameters<ToolDefinition["execute"]>) {
        signal.throwIfAborted();
        ensure(!exhausted, "产物整理工具预算已用完");
        return tool.execute(...args);
      },
    })),
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(input.root),
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 1 },
      compaction: { enabled: true },
    }),
  });
  let calls = 0;
  let exhausted = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && ++calls > maxCalls) {
      exhausted = true;
      void session.abort();
    }
  });
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await session.prompt(
      input.skill ? `/skill:${input.skill} ${input.prompt}` : input.prompt,
    );
    signal.throwIfAborted();
    ensure(!exhausted, "产物整理工具预算已用完");
    const last = session.messages.at(-1);
    ensure(
      !(
        last?.role === "assistant" &&
        ["error", "aborted"].includes(last.stopReason)
      ),
      last?.role === "assistant"
        ? last.errorMessage || "模型整理未完成"
        : "模型整理未完成",
      502,
    );
    return { answer: session.getLastAssistantText() || "", toolCalls: calls };
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}
