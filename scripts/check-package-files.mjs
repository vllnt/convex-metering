import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";

/**
 * Fail when the npm tarball is missing a file coding agents read from
 * `node_modules/@vllnt/convex-metering/`, ships a contributor-only file, or when a
 * shipped Markdown file links to a file that is not inside the tarball. `llms.txt`
 * links shipped files as `./path`, never by repository URL. Runs from `pnpm lint`,
 * so CI checks it on every pull request.
 */

const REPO_BLOB = "https://github.com/vllnt/convex-metering/blob/main/";
const DOCS = existsSync("docs")
  ? readdirSync("docs")
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`)
  : [];
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "llms.txt", ...DOCS];
const FORBIDDEN = [
  /^AGENTS\.md$/,
  /^ROADMAP\.md$/,
  /^CONTRIBUTING\.md$/,
  /^example\//,
  /^scripts\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

/** @type {unknown} */
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
if (!Array.isArray(pack) || !Array.isArray(pack[0]?.files))
  throw new Error("unexpected `npm pack --json` output");
/** @type {Set<string>} */
const packed = new Set(pack[0].files.map((/** @type {{ path: string }} */ f) => f.path));

/** @type {string[]} */
const errors = [];
if (DOCS.length === 0) errors.push("no docs/*.md found");
for (const path of REQUIRED)
  if (!packed.has(path)) errors.push(`missing from tarball: ${path}`);
for (const path of packed)
  if (FORBIDDEN.some((re) => re.test(path)))
    errors.push(`must not ship: ${path}`);

for (const file of ["llms.txt", "README.md", ...DOCS].filter((f) => packed.has(f))) {
  const text = readFileSync(file, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const path = target.split("#")[0];
    if (target.startsWith(REPO_BLOB) && packed.has(path.slice(REPO_BLOB.length)))
      errors.push(`${file}: link shipped files relatively: ${target}`);
    if (/^[a-z]+:/i.test(target) || path === "") continue;
    if (file === "llms.txt" && !target.startsWith("./"))
      errors.push(`${file}: relative links start with ./: ${target}`);
    else if (!packed.has(posix.join(posix.dirname(file), path)))
      errors.push(`${file}: link does not resolve inside the tarball: ${target}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL  ${error}`);
  process.exit(1);
}
console.log(`OK    package files: ${REQUIRED.length} required file(s) packed, shipped links resolve`);
