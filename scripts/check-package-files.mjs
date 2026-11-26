import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";

/**
 * Fail when the npm tarball is missing a file coding agents read from
 * `node_modules/@vllnt/convex-metering/`, ships a contributor-only file, or when
 * `llms.txt` links a shipped file by URL instead of a relative path that resolves
 * inside the tarball. Runs from `pnpm lint`, so CI checks it on every pull request.
 */

const REPO_BLOB = "https://github.com/vllnt/convex-metering/blob/main/";
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "llms.txt",
  ...readdirSync("docs")
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];
const FORBIDDEN = [
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^ROADMAP\.md$/,
  /^CONTRIBUTING\.md$/,
  /^\.claude\//,
  /^example\//,
  /^scripts\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

/** @type {unknown} */
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
if (!Array.isArray(pack) || !Array.isArray(pack[0]?.files))
  throw new Error("unexpected `npm pack --json` output");
/** @type {Set<string>} */
const packed = new Set(pack[0].files.map((/** @type {{ path: string }} */ f) => f.path));

/** @type {string[]} */
const errors = [];
for (const path of REQUIRED)
  if (!packed.has(path)) errors.push(`missing from tarball: ${path}`);
for (const path of packed)
  if (FORBIDDEN.some((re) => re.test(path)))
    errors.push(`must not ship: ${path}`);

const llms = readFileSync("llms.txt", "utf8");
for (const [, target] of llms.matchAll(/\]\(([^)\s]+)\)/g)) {
  if (target.startsWith(REPO_BLOB) && packed.has(target.slice(REPO_BLOB.length)))
    errors.push(`llms.txt: link shipped files relatively: ${target}`);
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
  if (!target.startsWith("./"))
    errors.push(`llms.txt: relative links start with ./: ${target}`);
  else if (!packed.has(target.slice(2)))
    errors.push(`llms.txt: link does not resolve inside the tarball: ${target}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL  ${error}`);
  process.exit(1);
}
console.log(`OK    package files: ${REQUIRED.length} required file(s) packed, llms.txt links resolve`);
