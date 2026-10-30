// Re-render saved chapters without rewriting content, operating the browser, or calling a model.
// node --import tsx --env-file=.env scripts/refresh-guide.mjs PROJECT_ID GUIDE_ID
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomic, json, projectDir, validId } from "../src/store.ts";
import { writeDocument, documentStepImages } from "../src/documents.ts";
import { renderGuideHtml } from "../src/guide-html.ts";
import { GuideWorkflow } from "../src/guide-workflow.ts";

const [projectId, guideId] = process.argv.slice(2);
assert.ok(
  validId(projectId) && validId(guideId),
  "provide PROJECT_ID GUIDE_ID",
);
const root = projectDir(projectId);
const guideFile = path.join(root, "guides", guideId + ".json");
const guide = await json(guideFile);
let workflow;
if (guide.taskId) {
  workflow = await GuideWorkflow.load(projectId, guide.taskId);
  assert.ok(
    ["completed", "partial"].includes(workflow.task.status),
    "finish or stop the guide task before refreshing its exports",
  );
}
const parts = [];
for (const module of guide.modules.filter((item) => item.documentId)) {
  assert.ok(validId(module.documentId), "invalid document ID");
  const doc = await json(
    path.join(root, "documents", module.documentId + ".json"),
  );
  assert.equal(doc.moduleId, module.id);
  await writeDocument(projectId, doc);
  const [html, md] = await Promise.all(
    ["html", "md"].map((extension) =>
      readFile(path.join(root, "documents", doc.id + "." + extension), "utf8"),
    ),
  );
  parts.push({
    id: module.id,
    title: module.title,
    html,
    md,
    images: doc.steps.flatMap(documentStepImages).length,
  });
}
if (workflow) {
  await workflow.assemble();
} else {
  const functional = guide.presentation === "functional_overview";
  const limitations = functional ? [] : guide.limitations || [];
  await atomic(
    path.join(root, "guides", guideId + ".html"),
    renderGuideHtml(
      guide.title,
      parts,
      limitations,
      guide.overview
        ? {
            overview: guide.overview,
            ...(functional ? {} : { audience: guide.audience || "" }),
          }
        : undefined,
    ),
    true,
  );
  await atomic(
    path.join(root, "guides", guideId + ".md"),
    `# ${guide.title}\n\n${guide.overview ? guide.overview + "\n\n" : ""}${limitations.length ? `## 使用限制与未完成范围\n\n${limitations.map((item) => `- ${item}`).join("\n")}\n\n` : ""}${parts.map((part) => part.md).join("\n\n---\n\n")}`,
    true,
  );
  await atomic(guideFile, {
    ...guide,
    presentationUpdatedAt: new Date().toISOString(),
  });
}
console.log(
  JSON.stringify({
    stage: "refresh-complete-guide",
    guideId,
    modules: parts.map(({ id, images }) => ({ id, images })),
    qa: "unchanged; generate/retry initial QA separately in the admin console",
  }),
);
