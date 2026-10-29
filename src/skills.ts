import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { ensure } from "./config.js";
import { readFile } from "node:fs/promises";

const references = {
  workflow: "references/workflow.md",
  adapter: "references/adapter-contract.md",
  admin: "references/admin.md",
  gymbook: "examples/gymbook.json",
  helpdesk: "examples/helpdesk.json",
} as const;
export async function quickStartReference(name: keyof typeof references) {
  ensure(Object.hasOwn(references, name), "不存在的技能资料");
  return readFile(
    new URL(`../skills/quick-start/${references[name]}`, import.meta.url),
    "utf8",
  );
}

export function projectSkills(publicMode = false) {
  if (publicMode) return { skills: [], diagnostics: [] };
  // 仅加载应用自带技能；不读取个人 Pi 技能或被分析仓库中的指令。
  const result = loadSkillsFromDir({
    dir: fileURLToPath(new URL("../skills/", import.meta.url)),
    source: "project",
  });
  ensure(
    !result.diagnostics.some((d) => d.type === "warning"),
    "项目 Skill 校验失败",
  );
  ensure(
    result.skills.some((s) => s.name === "quick-start"),
    "缺少 quick-start Skill",
  );
  return {
    ...result,
    skills: result.skills.filter((s) => s.name === "quick-start"),
  };
}

export function runPrompt(question: string, mode?: string) {
  return mode === "quick_start" ? `/skill:quick-start ${question}` : question;
}
