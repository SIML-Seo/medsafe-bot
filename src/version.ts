import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function computeBuildId(root = process.cwd()): string {
  const sourceRoot = join(root, "dist", "src");
  if (!existsSync(sourceRoot)) {
    throw new Error(`compiled source directory is missing: ${sourceRoot}`);
  }
  const files = [
    ...javascriptFiles(sourceRoot),
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "Dockerfile")
  ].sort((left, right) => normalizedRelative(root, left).localeCompare(normalizedRelative(root, right)));
  return hashIdentity(root, files);
}

export function computeVerificationId(root = process.cwd()): string {
  const files = [
    join(root, "scripts", "verify-remote.ts"),
    join(root, "scripts", "submission-check.ts"),
    join(root, "scripts", "validate-inspector-output.mjs"),
    join(root, "src", "utils", "releaseProbes.ts"),
    join(root, ".github", "workflows", "remote-release.yml"),
    join(root, "package-lock.json")
  ].sort((left, right) => normalizedRelative(root, left).localeCompare(normalizedRelative(root, right)));
  return hashIdentity(root, files);
}

function hashIdentity(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const path of files) {
    if (!existsSync(path)) throw new Error(`identity input is missing: ${path}`);
    hash.update(normalizedRelative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function javascriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
