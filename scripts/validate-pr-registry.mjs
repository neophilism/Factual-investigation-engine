import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const r = read("registry/prs.json"),
  p = read("docs/approved-design/development_backlog.json"),
  catalog = read("docs/approved-design/engine_catalog.json");
assert.equal(r.repository, "neophilism/Factual-investigation-engine");
assert(r.planVerified);
assert.equal(p.tasks.length, 122);
assert.equal(catalog.engines.length, 15);
const tasks = p.tasks.filter((t) => t.engines.includes("E08"));
assert.deepEqual(
  r.units.map((u) => u.id),
  tasks.map((t) => t.id),
);
assert.equal(r.plannedPrCount, tasks.length);
for (const u of r.units)
  assert.deepEqual(u.dependsOn, tasks.find((t) => t.id === u.id).dependencies);
assert.equal(
  read("package.json").dependencies["@accountability/knowledge-verification"],
  "git+https://github.com/neophilism/Knowledge-and-verification-engine.git#b937c856f9571fab42fafd31dd0f95eef25a6340",
);
console.log(
  "Valid E08 registry:15 engines/122 tasks; original IDs/dependencies and Knowledge pin retained",
);
