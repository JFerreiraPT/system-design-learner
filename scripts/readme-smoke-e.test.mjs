import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

test("README documents smoke task E via HTML comment", () => {
  assert.match(readme, /<!--\s*Smoke task E\s*-->/);
});
