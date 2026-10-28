import { readFile, writeFile } from "node:fs/promises";
import { QuickStartRun, planSchema } from "../../../src/quick-start.js";

const root = new URL("../", import.meta.url);
for (const name of ["gymbook", "helpdesk", "admin-procurement"]) {
  const plan = JSON.parse(
    await readFile(new URL(`examples/${name}.json`, root), "utf8"),
  );
  new QuickStartRun().setPlan(plan);
  process.stdout.write(`${name}: contract valid\n`);
}
if (process.argv.includes("--write-schema")) {
  await writeFile(
    new URL("schemas/task-plan.schema.json", root),
    JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...planSchema,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const saved = JSON.parse(
    await readFile(new URL("schemas/task-plan.schema.json", root), "utf8"),
  );
  delete saved.$schema;
  if (JSON.stringify(saved) !== JSON.stringify(planSchema))
    throw new Error("schema out of date: run with --write-schema");
}
