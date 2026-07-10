import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRECTORIES = new Set([".git", ".secrets", "dist", "node_modules"]);
const SENSITIVE_FILE = /(^|\/)(?:\.env(?:\..+)?|credentials[^/]*\.json|service-account[^/]*\.json)$|\.(?:pem|key|p12|pfx)$/i;
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:API_KEY|SERVICE_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY))[ \t]*[:=][ \t]*["']?([^\s"',}#]*)/g;
const INLINE_SERVICE_KEY = /(?:[?&]|\b)serviceKey=([^&\s"']+)/gi;
const DEFINITE_TOKEN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g;
const PLACEHOLDER = /^(?:null|undefined|[/(\[]|process\.env\.|env\.|config\.|\$\{(?:\{|[A-Z_])|your[_-]|change[_-]|example|placeholder|demo[_-]|dummy[_-]|fixture[_-]|test[_-]|ci[_-]|production-test-|32자|여기에|공공데이터포털|운영환경)/i;
const HISTORY_CANDIDATE = "API_KEY|SERVICE_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|BEGIN [A-Z ]*PRIVATE KEY|AKIA|gh[pousr]_|xox[baprs]-|serviceKey=";

const files = repositoryFiles();
const findings = new Set();
for (const path of files) {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
    continue;
  }
  const normalized = path.replaceAll("\\", "/");
  if (SENSITIVE_FILE.test(normalized) && basename(normalized) !== ".env.example") {
    findings.add(`${normalized}: sensitive file path is tracked or unignored`);
    continue;
  }
  scanBuffer(readFileSync(absolute), normalized);
}
scanGitHistory();

if (findings.size > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`ok secret content scan: ${files.length} repository files`);

function scan(text, pattern, describe, path) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const message = describe(match);
    if (!message) continue;
    const line = text.slice(0, match.index).split("\n").length;
    findings.add(`${path}:${line}: ${message}`);
  }
}

function scanBuffer(buffer, label) {
  const text = buffer.toString(buffer.includes(0) ? "latin1" : "utf8");
  if (!buffer.includes(0)) {
    scan(text, ASSIGNMENT, (match) => {
      const value = match[2] ?? "";
      return isPlaceholder(value) ? null : `non-placeholder ${match[1]} assignment`;
    }, label);
    scan(text, INLINE_SERVICE_KEY, (match) => {
      const value = decodeURIComponentSafe(match[1] ?? "");
      return isPlaceholder(value) ? null : "non-placeholder serviceKey query value";
    }, label);
  }
  scan(text, DEFINITE_TOKEN, () => "private key or provider token pattern", label);
}

function repositoryFiles() {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return walk(ROOT);
  }
}

function scanGitHistory() {
  let commits;
  try {
    commits = execFileSync("git", ["rev-list", "--all"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return;
  }
  for (const commit of commits) {
    for (const path of historyPaths(commit)) {
      const normalized = path.replaceAll("\\", "/");
      if (SENSITIVE_FILE.test(normalized) && basename(normalized) !== ".env.example") {
        findings.add(
          `history ${commit.slice(0, 12)}:${normalized}: sensitive file path was tracked`
        );
      }
    }
    const paths = historyCandidatePaths(commit);
    for (const path of paths) {
      const normalized = path.replaceAll("\\", "/");
      if (SENSITIVE_FILE.test(normalized) && basename(normalized) !== ".env.example") continue;
      let buffer;
      try {
        buffer = execFileSync("git", ["show", `${commit}:${path}`], {
          cwd: ROOT,
          encoding: "buffer",
          maxBuffer: 128 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"]
        });
      } catch {
        continue;
      }
      scanBuffer(buffer, `history ${commit.slice(0, 12)}:${path}`);
    }
  }
}

function historyPaths(commit) {
  try {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", commit], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function historyCandidatePaths(commit) {
  try {
    return execFileSync("git", ["grep", "-Il", "-E", HISTORY_CANDIDATE, commit, "--"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => entry.startsWith(`${commit}:`) ? entry.slice(commit.length + 1) : entry);
  } catch {
    return [];
  }
}

function walk(directory) {
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walk(absolute));
    else if (entry.isFile() && statSync(absolute).size <= 64 * 1024 * 1024) {
      results.push(relative(ROOT, absolute));
    }
  }
  return results;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPlaceholder(value) {
  return value === "" || PLACEHOLDER.test(value);
}
