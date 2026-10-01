import fs from "node:fs";
import path from "node:path";

export function ensureResultsDir() {
  const dir = path.resolve("results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function reportFileBase(runName = "lighthouse") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${runName}-${ts}`;
}
