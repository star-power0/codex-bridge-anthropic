import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { buildModelCatalog } from "../src/model-catalog.js";

const config = loadConfig();
const outputPath = path.resolve(process.argv[2] || "model-catalog.json");
const catalog = buildModelCatalog(config);

fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`wrote ${outputPath}`);
