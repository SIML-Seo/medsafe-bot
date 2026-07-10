import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const testMasterDbPath = "data/master.test.sqlite";
const env = { ...process.env, SOURCE_DATE_EPOCH: "0", MASTER_DB_PATH: testMasterDbPath };
const BUILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 240_000;

const build = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
  timeout: BUILD_TIMEOUT_MS
});
exitOnFailure(build, "TypeScript build");

const buildMaster = spawnSync(
  process.execPath,
  [
    "dist/scripts/build-master-db.js",
    "--input",
    "data/master.seed.json",
    "--aliases",
    "data/aliases.json",
    "--output",
    testMasterDbPath
  ],
  {
    stdio: "inherit",
    env,
    timeout: BUILD_TIMEOUT_MS
  }
);
exitOnFailure(buildMaster, "fixture DB build");

const testFiles = readdirSync("dist/tests")
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join("dist/tests", file));

const test = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  env,
  timeout: TEST_TIMEOUT_MS
});
exitOnFailure(test, "test suite");

function exitOnFailure(result, label) {
  if (result.status === 0) return;
  if (result.error) console.error(`${label} failed: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
