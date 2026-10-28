import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { config, ensure } from "./config.js";

// Isolated native Pi session: only the supplied artifact tools, no browser,
// filesystem tools, user skills, extensions, or target repository context.
export async function runArtifactAgent(input: {
  root: string;
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxCalls?: number;
}) {
  ensure(
    config.llm.baseUrl && config.llm.key && config.llm.model,
    "模型尚未配置",
    503,
  );
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
        maxTokens: config.quickStartMaxTokens,
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
    getSkills: () => ({ skills: [], diagnostics: [] }),
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
    customTools: input.tools,
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
    if (
      event.type === "tool_execution_start" &&
      ++calls > (input.maxCalls ?? 30)
    ) {
      exhausted = true;
      void session.abort();
    }
  });
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(180000),
  ]);
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await session.prompt(input.prompt);
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
