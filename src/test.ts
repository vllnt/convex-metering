/// <reference types="vite/client" />
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register this component with a `convex-test` instance so consuming apps can test
 * integration: `import { register } from "@vllnt/convex-metering/test"`.
 *
 * @param t - The host app's `convexTest(hostSchema, modules)` instance, for any host schema.
 * @param name - The component name the host mounts it under (`app.use(metering, { name })`).
 * @example
 * const t = convexTest(schema, modules);
 * register(t);
 */
export function register<TSchema extends GenericSchema>(
  t: TestConvex<SchemaDefinition<TSchema, boolean>>,
  name = "metering",
): void {
  t.registerComponent(name, schema, modules);
}
