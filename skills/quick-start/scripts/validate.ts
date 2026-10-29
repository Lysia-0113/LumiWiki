import { readFile, writeFile } from "node:fs/promises";
import { QuickStartRun, planSchema } from "../../../src/quick-start.js";
import { outlineSchema } from "../../../src/guide-workflow.js";

const root = new URL("../", import.meta.url);
for (const name of ["gymbook", "helpdesk", "admin-procurement"]) {
  const plan = JSON.parse(
    await readFile(new URL(`examples/${name}.json`, root), "utf8"),
  );
  new QuickStartRun().setPlan(plan);
  process.stdout.write(`${name}: contract valid\n`);
}
for (const [name, schema] of [
  ["task-plan", planSchema],
  ["guide-outline", outlineSchema],
] as const) {
  const file = new URL(`schemas/${name}.schema.json`, root);
  if (process.argv.includes("--write-schema")) {
    await writeFile(
      file,
      JSON.stringify(
        { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema },
        null,
        2,
      ) + "\n",
    );
  } else {
    const saved = JSON.parse(await readFile(file, "utf8"));
    delete saved.$schema;
    if (JSON.stringify(saved) !== JSON.stringify(schema))
      throw new Error(`${name} schema out of date: run with --write-schema`);
  }
}
