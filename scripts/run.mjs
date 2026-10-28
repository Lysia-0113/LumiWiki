import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const command = process.argv[2] || "dev";
const children = [];
const childEnv = {
  ...process.env,
  PATH:
    path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ""),
};
function launch(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
    ...options,
  });
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  return child;
}
function stop(code = 0) {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
if (command === "check" || command === "test" || command === "smoke") {
  const args =
    command === "check"
      ? ["node_modules/typescript/bin/tsc", "--noEmit"]
      : command === "smoke"
        ? ["--import", "tsx", "scripts/smoke.mjs"]
        : [
            "--import",
            "tsx",
            "--test",
            ...readdirSync("test")
              .filter((f) => f.endsWith(".test.ts"))
              .map((f) => "test/" + f),
          ];
  launch(process.execPath, args).on("exit", (code) => process.exit(code || 0));
} else if (command === "start" || command === "dev") {
  if (!existsSync(".env")) {
    const sample = readFileSync(".env.example", "utf8").replace(
      "QA_ADMIN_TOKEN=\n",
      `QA_ADMIN_TOKEN=${randomBytes(24).toString("hex")}\n`,
    );
    writeFileSync(".env", sample, { mode: 0o600 });
    console.log("已创建 .env；模型字段待你填写，管理口令已随机生成。");
  }
  process.loadEnvFile(".env");
  Object.assign(childEnv, process.env);
  childEnv.PATH =
    path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "");
  const available = async (url) => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };
  if (command === "dev") {
    const repo = path.resolve(process.env.DEEPWIKI_REPO || "../deepwiki-open");
    const python = path.join(repo, ".venv/bin/python");
    if (
      !(await available(
        process.env.DEEPWIKI_BASE_URL || "http://127.0.0.1:8001",
      ))
    ) {
      if (existsSync(python)) {
        const data = path.resolve(process.env.DATA_DIR || ".webdemo");
        const configDir = path.join(data, "deepwiki-config");
        mkdirSync(configDir, { recursive: true });
        for (const f of readdirSync(path.join(repo, "api/config")).filter((f) =>
          f.endsWith(".json"),
        ))
          writeFileSync(
            path.join(configDir, f),
            readFileSync(path.join(repo, "api/config", f)),
          );
        const embedder = JSON.parse(
          readFileSync(path.join(configDir, "embedder.json"), "utf8"),
        );
        embedder.embedder.initialize_kwargs = {
          base_url: "${EMBEDDING_BASE_URL}",
          api_key: "${EMBEDDING_API_KEY}",
        };
        if (process.env.EMBEDDING_MODEL)
          embedder.embedder.model_kwargs = {
            model: process.env.EMBEDDING_MODEL,
            encoding_format: "float",
          };
        writeFileSync(
          path.join(configDir, "embedder.json"),
          JSON.stringify(embedder, null, 2),
        );
        const deepEnv = {
          ...childEnv,
          PYTHONPATH: repo,
          NODE_ENV: "production",
          DEEPWIKI_SOURCE: repo,
          DEEPWIKI_CONFIG_DIR: configDir,
          OPENAI_API_KEY: process.env.LLM_API_KEY || "",
          OPENAI_BASE_URL:
            process.env.LLM_BASE_URL || "https://api.openai.com/v1",
          EMBEDDING_BASE_URL:
            process.env.EMBEDDING_BASE_URL ||
            process.env.LLM_BASE_URL ||
            "https://api.openai.com/v1",
          EMBEDDING_API_KEY:
            process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || "",
        };
        launch(python, [path.join(root, "scripts/deepwiki_entry.py")], {
          cwd: repo,
          env: deepEnv,
        });
      } else
        console.log("DeepWiki 未安装依赖，详见 README。LumiWiki 将继续启动。");
    } else console.log("复用已运行的 DeepWiki。");
    const gymbook = path.resolve(process.env.GYMBOOK_REPO || "../gymbook");
    if (
      process.env.PUBLIC_TEST_URL === "http://127.0.0.1:9098" &&
      !(await available("http://127.0.0.1:9098/healthz")) &&
      existsSync(path.join(gymbook, "scripts/test-integration.sh"))
    )
      launch("bash", ["scripts/test-integration.sh", "--serve"], {
        cwd: gymbook,
      });
  }
  launch(process.execPath, ["--import", "tsx", "src/server.ts"]).on(
    "exit",
    (code) => stop(code || 0),
  );
} else {
  console.error("用法：./lumiwiki [dev|start|check|test|smoke]");
  process.exitCode = 1;
}
