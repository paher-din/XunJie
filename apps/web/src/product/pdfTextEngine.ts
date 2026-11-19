import { getDocument, GlobalWorkerOptions, TextLayer, VerbosityLevel } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const assets = import.meta.glob<string>([
  '../../../../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
], { query: '?url', import: 'default' })

class BinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : ''
    const load = assets[`../../../../node_modules/pdfjs-dist/${folder}/${filename}`]
    if (!load) throw new Error('缺少 PDF 字体资源。')
    const response = await fetch(await load(), { redirect: 'error' })
    if (!response.ok) throw new Error('PDF 字体资源读取失败。')
    return new Uint8Array(await response.arrayBuffer())
  }
}

export function openPdfText(data: Uint8Array) {
  GlobalWorkerOptions.workerSrc = workerUrl
  return getDocument({ data, BinaryDataFactory, useWorkerFetch: false, useWasm: false,
    enableXfa: false, disableFontFace: true, maxImageSize: 16 * 1024 * 1024, verbosity: VerbosityLevel.ERRORS })
}

export { TextLayer }
