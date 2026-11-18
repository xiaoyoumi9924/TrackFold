import { build } from "esbuild";
await build({
  entryPoints: ["verification/client.js"],
  outfile: "dist/verification.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
