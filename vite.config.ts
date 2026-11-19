import { realpathSync } from "node:fs";
import path from "node:path";
import { defineConfig, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
// Also deny data and output paths supplied by the local server's environment.
const privateDirectories = [process.env.SHIYIN_DATA_DIR, process.env.SHIYIN_OUTPUT_DIR]
  .filter((directory): directory is string => !!directory)
  .flatMap(directory => {
    const absolute = path.resolve(directory);
    try {
      return [absolute, realpathSync(absolute)];
    } catch {
      return [absolute];
    }
  })
  .map(directory => normalizePath(directory).replace(/[?*\[\]{}()!+@]/g, "\\$&") + "/**");

export default defineConfig({
  plugins: [vue()],
  publicDir: false,
  server: {
    host: "127.0.0.1",
    cors: false,
    fs: {
      deny: [
        // A custom deny list replaces Vite's defaults.
        ".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**",
        "**/.local/**", "**/output/**", "**/release/**", "**/desktop-build/**",
        ...privateDirectories,
      ],
    },
  },
  build: { outDir: "dist" },
});
