export type GuidePhase = "planner" | "chapter";

const explorationTools = new Set([
  "wiki_read",
  "browser_observe",
  "browser_inspect",
  "browser_table",
  "browser_wait",
  "browser_navigate",
  "browser_act",
  "quick_start_reference",
]);
const chapterTools = new Set([
  ...explorationTools,
  "browser_screenshot",
  "image_annotate",
  "quick_start_status",
  "quick_start_plan",
  "quick_start_prepare",
  "quick_start_begin",
  "quick_start_checkpoint",
  "quick_start_verify",
  "quick_start_block",
  "document_write",
  "guide_chapter_block",
  "guide_outline_update",
]);

export function allowedConversationTool(name: string, phase?: GuidePhase) {
  if (phase === "planner")
    return explorationTools.has(name) || name === "guide_outline";
  if (phase === "chapter") return chapterTools.has(name);
  return (
    !name.startsWith("quick_start_") &&
    !name.startsWith("guide_") &&
    !["document_write", "image_annotate"].includes(name)
  );
}

export function explorationAction(action: string) {
  return ["navigate", "back", "scroll", "hover", "expand", "collapse"].includes(
    action,
  );
}
