// Package test, run by `pnpm test:package` after `pnpm build`. Packs the package,
// installs the tarball into one throwaway consumer project (same release-age gate
// and overrides as this repo, same dependency versions it develops against), then
// checks what a real consumer sees:
//   (a) every runtime entry point imports in Node,
//   (b) a strict nodenext consumer of every entry point type-checks with
//       `skipLibCheck: false`, including `register(t)` against a host schema
//       that has its own tables.
// The consumer project is removed at the end, pass or fail.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const { name, pnpm } = JSON.parse(readFileSync("package.json", "utf8"));

/** Installed dev version of a package, as an install spec for the consumer. */
const devSpec = (dependency) => {
  const installed = JSON.parse(
    readFileSync(
      join(root, "node_modules", dependency, "package.json"),
      "utf8",
    ),
  );
  return installed.name === dependency
    ? `${dependency}@${installed.version}`
    : `${dependency}@npm:${installed.name}@${installed.version}`;
};

const consumer = mkdtempSync(join(tmpdir(), "metering-consumer-"));
const run = (command, arguments_, cwd = consumer) =>
  execFileSync(command, arguments_, { cwd, stdio: "inherit" });
const write = (path, text) => {
  mkdirSync(dirname(join(consumer, path)), { recursive: true });
  writeFileSync(join(consumer, path), `${text.trim()}\n`);
};

try {
  run("pnpm", ["pack", "--pack-destination", consumer], root);
  const tarball = readdirSync(consumer).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");

  write(
    "package.json",
    JSON.stringify({
      private: true,
      type: "module",
      // Same overrides as this repo; pnpm reads them from package.json.
      pnpm: {
        ignoredBuiltDependencies: pnpm.ignoredBuiltDependencies,
        overrides: pnpm.overrides,
      },
    }),
  );
  // Same release-age gate as this repo; pnpm 10 reads it only from this file.
  copyFileSync(
    join(root, "pnpm-workspace.yaml"),
    join(consumer, "pnpm-workspace.yaml"),
  );
  run("pnpm", [
    "add",
    join(consumer, tarball),
    ...[
      "convex",
      "convex-test",
      "vite",
      "typescript",
      "react",
      "@types/react",
    ].map(devSpec),
  ]);

  // (a) Every runtime entry point loads in Node.
  run("node", [
    "--input-type=module",
    "--eval",
    `
const client = await import("${name}");
if (typeof client.Metering !== "function") throw new Error(". has no Metering");
const react = await import("${name}/react");
for (const hook of ["useUsage", "useUsageList"]) {
  if (typeof react[hook] !== "function") throw new Error("./react has no " + hook);
}
for (const entry of ["${name}/convex.config", "${name}/convex.config.js"]) {
  const config = await import(entry);
  if (!config.default) throw new Error(entry + " has no default export");
}
`,
  ]);

  // (b) A strict host app over every entry point, type-checked with nodenext.
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: false,
        noEmit: true,
        types: ["vite/client"],
      },
      include: ["**/*.ts"],
      exclude: ["node_modules"],
    }),
  );
  write(
    "convex/schema.ts",
    `
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  invoices: defineTable({ subjectRef: v.string(), period: v.string(), amount: v.number() }),
  notes: defineTable({ body: v.string() }),
});
`,
  );
  write(
    "convex/convex.config.ts",
    `
import metering from "${name}/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(metering);
export default app;
`,
  );
  // Stub of what \`convex codegen\` writes for this host.
  write(
    "convex/_generated/api.ts",
    `
import type { ComponentApi } from "${name}/_generated/component.js";
import { componentsGeneric } from "convex/server";

export const components = componentsGeneric() as unknown as {
  metering: ComponentApi<"metering">;
};
`,
  );
  write(
    "convex/usage.ts",
    `
import { Metering } from "${name}";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api.js";

const metering = new Metering(components.metering, { defaultPeriod: "2026-11" });

export const track = mutationGeneric({
  args: { subjectRef: v.string(), period: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { subjectRef, period }) => {
    const result = await metering.record(ctx, "api_calls", subjectRef, 1, { period });
    return result.recorded ? result.value : 0;
  },
});

export const usage = queryGeneric({
  args: { subjectRef: v.string() },
  returns: v.union(v.null(), v.object({ value: v.number(), count: v.number(), closed: v.boolean() })),
  handler: async (ctx, { subjectRef }) => metering.usage(ctx, "api_calls", subjectRef),
});
`,
  );
  // Every entry point, including the type-only ones, from one consumer file.
  write(
    "consumer.ts",
    `
import { Metering, type MeteringComponent, type Usage } from "${name}";
import type { ComponentApi } from "${name}/_generated/component";
import type { ComponentApi as ComponentApiJs } from "${name}/_generated/component.js";
import config from "${name}/convex.config";
import configJs from "${name}/convex.config.js";
import { useUsage, useUsageList, type UsageView } from "${name}/react";
import { register } from "${name}/test";
import { convexTest } from "convex-test";
import schema from "./convex/schema.js";

declare const component: ComponentApi;
declare const componentJs: ComponentApiJs;
const client = new Metering(component);
const fromJs: MeteringComponent = componentJs;

const t = convexTest(schema, import.meta.glob("./convex/**/*.*s"));
register(t);
register(t, "billing");

declare const view: UsageView;
declare const usage: Usage | null;
void [client, fromJs, config, configJs, useUsage, useUsageList, view, usage];
`,
  );
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"]);
  console.log(
    "OK    package test: tarball installs, entry points import and type-check",
  );
} finally {
  rmSync(consumer, { force: true, recursive: true });
}
