// Beyond.build (Bun.build): plugins, loaders, tree shaking, errors. Run in
// this directory with an output directory as its argument; the expected
// output is Bun's (`bun build.ts <dir>`).

const out = process.argv[2];
const shown = (p: string) => p.replace(out, "<out>").replace(process.cwd(), ".");

const seen: string[] = [];
const result = await Bun.build({
  entrypoints: ["./a.ts"],
  outdir: out,
  target: "bun",
  define: { VERSION: '"1.2.3"' },
  plugins: [
    {
      name: "probe",
      setup(build) {
        seen.push("builder " + Object.keys(build).sort().join(","));
        seen.push("config " + build.config.entrypoints.join(",") + " " + build.config.target);
        build.onStart(() => {
          seen.push("start");
        });
        build.onResolve({ filter: /^virtual:/ }, (args) => {
          seen.push(`resolve ${args.path} from ${shown(args.importer)} ${args.namespace} ${args.kind}`);
          return { path: args.path.slice("virtual:".length), namespace: "virtual" };
        });
        build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
          seen.push(`load ${args.path} ${args.namespace}`);
          return { contents: `export default "hi from " + ${JSON.stringify(args.path)};`, loader: "js" };
        });
        build.onLoad({ filter: /b\.ts$/ }, async (args) => {
          seen.push(`load ${shown(args.path)} ${args.namespace} ${args.loader}`);
          return undefined;
        });
        build.onEnd((r) => {
          seen.push(`end ${r.success} ${r.outputs.length}`);
        });
      },
    },
  ],
});
console.log(seen.join("\n"));
console.log("result", result.success, result.outputs.length, result.logs.length);
const artifact = result.outputs[0];
console.log("artifact", shown(artifact.path), artifact.kind, artifact.loader, artifact.type, artifact instanceof Blob);

// The bundle: what it does when it runs, and what tree shaking left out.
const code = await artifact.text();
console.log("header", code.startsWith("// @bun\n"));
console.log("unusedFunction", code.includes("never in the bundle"));
console.log("pure-lib unused", code.includes("pure-lib unused"));
console.log("effects-lib", code.includes("effectsLibRan"));
console.log("path import", /import\s*\{\s*join\s*\}\s*from\s*"(node:)?path"/.test(code));
const mod = await import(artifact.path);
console.log("main()", JSON.stringify(mod.default()), mod.a);
console.log("ran", (globalThis as any).effectsLibRan, (globalThis as any).pureLibUnusedRan);

// Errors: thrown as an AggregateError of BuildMessages, or in `logs`.
try {
  await Bun.build({ entrypoints: ["./broken.ts"] });
  console.log("no throw");
} catch (e: any) {
  const m = e.errors?.[0];
  console.log("threw", e.constructor.name, e.message, e.errors?.length);
  console.log("message", m?.constructor?.name, m?.level, m?.message);
  console.log("position", m?.position?.line, m?.position?.column, m?.position?.lineText, shown(m?.position?.file ?? ""));
}
const quiet = await Bun.build({ entrypoints: ["./broken.ts"], throw: false });
console.log("throw: false", quiet.success, quiet.outputs.length, quiet.logs.length, quiet.logs[0]?.message);

// Without outdir: the bundle in memory; `external` stays an import.
const mem = await Bun.build({ entrypoints: ["./b.ts"], external: ["./never"] });
console.log("in memory", mem.outputs.length, shown(mem.outputs[0].path), (await mem.outputs[0].text()).includes("41"));
