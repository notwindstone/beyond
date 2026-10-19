// Bundles app.ts with Elysia's AOT plugin (its handlers composed at build
// time) into dist/app.js, which Beyond compiles: `beyond run --no-native
// build.ts` (or `bun build.ts`), then `beyond build dist/app.js`.
import { aot } from "elysia/plugin/aot/bun";

const result = await Bun.build({
  entrypoints: ["./app.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [aot("./app.ts")],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
