import { spawnSync } from "node:child_process";

const secretScan = spawnSync(process.execPath, ["scripts/scan-secrets.mjs"], {
  stdio: "inherit",
  timeout: 60_000
});
exitOnFailure(secretScan, "secret scan");

const test = spawnSync("npm", ["test"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  timeout: 300_000
});
exitOnFailure(test, "test suite");

const check = spawnSync(process.execPath, ["dist/scripts/submission-check.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATA_MODE: "fixture",
    MASTER_DB_PATH: "data/master.test.sqlite"
  },
  timeout: 120_000
});
exitOnFailure(check, "submission check");

function exitOnFailure(result, label) {
  if (result.status === 0) return;
  if (result.error) console.error(`${label} failed: ${result.error.message}`);
  process.exit(result.status ?? 1);
}
