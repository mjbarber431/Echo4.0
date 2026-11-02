import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** pdf.js data files the document editor needs: fonts for PDFs that don't embed theirs, and image decoders for scans. */
const PDFJS_DATA = [
  ...['FoxitDingbats', 'FoxitFixed', 'FoxitFixedBold', 'FoxitFixedBoldItalic', 'FoxitFixedItalic', 'FoxitSerif', 'FoxitSerifBold', 'FoxitSerifBoldItalic', 'FoxitSerifItalic', 'FoxitSymbol'].map((f) => `standard_fonts/${f}.pfb`),
  ...['LiberationSans-Bold', 'LiberationSans-BoldItalic', 'LiberationSans-Italic', 'LiberationSans-Regular'].map((f) => `standard_fonts/${f}.ttf`),
  'wasm/openjpeg.wasm',
  'wasm/jbig2.wasm',
  'wasm/qcms_bg.wasm'
]

/**
 * `virtual:pdfjs-data` maps each file name to a loader for its bytes (base64). Each file is its own
 * chunk, loaded only when a PDF needs it, so it works from file:// without fetch.
 */
function pdfjsData(): Plugin {
  const ID = 'virtual:pdfjs-data'
  return {
    name: 'echo-pdfjs-data',
    resolveId: (id) => (id === ID || id.startsWith(`${ID}/`) ? `\0${id}` : null),
    load(id) {
      if (id === `\0${ID}`) {
        const entries = PDFJS_DATA.map((f) => `  ${JSON.stringify(f.split('/').pop())}: () => import(${JSON.stringify(`${ID}/${f}.b64`)}).then((m) => m.default)`)
        return `export default {\n${entries.join(',\n')}\n}`
      }
      if (id.startsWith(`\0${ID}/`)) {
        // A neutral suffix, so Vite's own wasm handling leaves these alone.
        const file = id.slice(`\0${ID}/`.length).replace(/\.b64$/, '')
        if (!PDFJS_DATA.includes(file)) return null
        return `export default ${JSON.stringify(readFileSync(resolve('node_modules/pdfjs-dist', file)).toString('base64'))}`
      }
      return null
    }
  }
}

export default defineConfig({
  main: {
    build: { externalizeDeps: true }
  },
  preload: {
    build: {
      externalizeDeps: true,
      // The presentation window gets its own, much narrower bridge.
      rollupOptions: { input: { index: resolve('src/preload/index.ts'), present: resolve('src/preload/present.ts') } }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react(), pdfjsData()]
  }
})
