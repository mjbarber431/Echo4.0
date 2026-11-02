import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import pdfjsData from 'virtual:pdfjs-data'

// pdf.js for the document editor. Its fonts (for PDFs that don't embed theirs) and
// image decoders (JPEG 2000 and JBIG2, common in scans) come from chunks bundled with
// Echo and loaded on demand, so nothing is fetched from the web and it works the same
// in development and in the packaged app.

GlobalWorkerOptions.workerSrc = workerUrl

/** Fonts and decoders by file name, each a lazily loaded chunk (see pdfjsData in electron.vite.config.ts). */
const DATA = pdfjsData as Record<string, (() => Promise<string>) | undefined>

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

class BundledData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const load = kind === 'cMapUrl' ? undefined : DATA[filename]
    if (!load) throw new Error(`Echo doesn’t include ${filename}.`)
    return fromBase64(await load())
  }
}

export function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    // pdf.js takes ownership of the buffer it's given.
    data: bytes.slice(),
    useWorkerFetch: false,
    BinaryDataFactory: BundledData,
    // Only their presence matters: BundledData supplies the files.
    standardFontDataUrl: 'bundled/',
    wasmUrl: 'bundled/',
    enableXfa: false,
    verbosity: 0
  }).promise
}
