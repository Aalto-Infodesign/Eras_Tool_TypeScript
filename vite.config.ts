import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"

/**
 * Files in `public/` for local runs only. Vite copies the whole folder into the
 * build and has no option to leave a file out, so these are deleted from the
 * output once it is written. Paths are relative to `public/`.
 */
const LOCAL_ONLY = ["data/generated/data_1m.json"]

function excludeFromBuild(paths: readonly string[]): Plugin {
  let outDir = "dist"
  return {
    name: "exclude-from-build",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const path of paths) rmSync(resolve(outDir, path), { force: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), excludeFromBuild(LOCAL_ONLY)],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
      "@app": fileURLToPath(new URL("./src/app", import.meta.url)),
    },
  },
  worker: { format: "es" },
  build: { target: "es2022" },
})
