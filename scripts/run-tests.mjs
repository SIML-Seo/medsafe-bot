import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const testMasterDbPath = "data/master.test.sqlite";
const env = { ...process.env, SOURCE_DATE_EPOCH: "0", MASTER_DB_PATH: testMasterDbPath };

const build = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

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
    env
  }
);
if (buildMaster.status !== 0) {
  process.exit(buildMaster.status ?? 1);
}

const testFiles = readdirSync("dist/tests")
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join("dist/tests", file));

const test = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  env
});
process.exit(test.status ?? 1);
