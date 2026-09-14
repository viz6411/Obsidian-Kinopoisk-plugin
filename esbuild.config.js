import { build } from "esbuild";
import * as path from "path";

const prod = process.argv.includes("--prod");

async function main() {
  await build({
    sourcemap: true,
    bundle: true,
    // tsconfig: path.resolve(__dirname, "tsconfig.json"),
    target: "esnext",
    external: ["obsidian"],
    format: "cjs",
    define: {
      "process.env.NODE_ENV": prod ? '"production"' : '"development"',
    },
    entryPoints: ["src/main.ts"],
    outfile: "main.js",
    minify: prod,
    treeShaking: prod,
  });
  console.log("Build complete.");
}

main();
