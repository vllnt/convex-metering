import { defineComponent } from "convex/server";

/**
 * The metering component definition. Mount it in the host's `convex/convex.config.ts` with
 * `app.use(metering)`, or `app.use(metering, { name })` for a named mount.
 */
const component = defineComponent("metering");

// Nest official child components here, e.g.:
// import aggregate from "@convex-dev/aggregate/convex.config";
// component.use(aggregate);

export default component;
