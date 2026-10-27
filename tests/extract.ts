// Writes every ```ts block that starts with `// file: <name>` in the skills' reference docs
// to a temp folder, so the tests run the exact code the docs show.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const refs = join(import.meta.dirname, "..", "skills", "production-backend", "references");

export function extractTemplates(): string {
  const out = mkdtempSync(join(tmpdir(), "skill-templates-"));
  for (const doc of readdirSync(refs).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(join(refs, doc), "utf8");
    for (const [, code] of md.matchAll(/```ts\n([\s\S]*?)```/g)) {
      const name = code.match(/^\/\/ file: (\S+)/)?.[1];
      if (name) writeFileSync(join(out, name), code);
    }
  }
  return out;
}
