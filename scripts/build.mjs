import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync(resolve("dist"), { recursive: true, force: true });

const compiler = resolve("node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
