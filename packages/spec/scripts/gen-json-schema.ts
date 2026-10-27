import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CanonicalEvent, EventRecord } from "../src/events.js";

// Emits JSON Schema (draft 2020-12) consumed by openapi/openapi.yaml.
// Commit the output so the front-end can mock the API without running this.
const out = new URL("../generated/", import.meta.url);
mkdirSync(out, { recursive: true });

for (const [name, schema] of Object.entries({ CanonicalEvent, EventRecord })) {
  const file = new URL(`${name}.schema.json`, out);
  writeFileSync(file, `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
  console.log(`wrote ${file.pathname}`);
}
