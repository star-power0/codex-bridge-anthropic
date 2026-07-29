import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../desktop/renderer/app.js", import.meta.url), "utf8");
const start = source.indexOf("function activateSection(sectionId)");
const end = source.indexOf("\nfunction currentStateRevision()", start);

assert.notEqual(start, -1, "activateSection() must exist");
assert.notEqual(end, -1, "activateSection() boundary must exist");

const activateSectionSource = source.slice(start, end);
assert.match(
  activateSectionSource,
  /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*renderActiveSection\(sectionId\)/,
  "navigation must yield one paint frame before rebuilding a cached page",
);
assert.match(
  activateSectionSource,
  /currentSectionId\(\) !== sectionId/,
  "deferred rendering must ignore a page that is no longer active",
);

console.log("Navigation paint scheduling verification passed.");
