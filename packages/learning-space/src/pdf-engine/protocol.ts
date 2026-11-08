export type Region = { x: number; y: number; width: number; height: number };
export type Inspection = {
  state: 'ready' | 'damaged' | 'encrypted' | 'limit' | 'timeout' | 'failed';
  pageCount: number; pageLabels: string[]; detail?: string;
};
export type PdfPage = {
  page: number; label: string;
  state: 'ready' | 'out-of-range' | 'failed' | 'limit' | 'timeout';
  text: string; textOrigin: 'native'; ocr: 'not-performed';
  image: null | { mediaType: 'image/png'; dataBase64: string; width: number; height: number; sha256: string };
  transform: { rotation: number; cropBox: number[]; region: null | Region; scale: number; engine: string };
  detail?: string;
};
export const ENGINE = 'pdfjs-dist@6.5.438/@napi-rs/canvas@1.1.0';
export const LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, pages: 200, milliseconds: 30_000,
  pixels: 2048 * 2048, sourceImagePixels: 16 * 1024 * 1024,
  png: 256 * 1024, text: 128 * 1024, response: 2 * 1024 * 1024 });
export function emptyPage(page: number, region: Region | null, state: PdfPage['state'], detail: string): PdfPage {
  return { page, label: String(page), state, text: '', textOrigin: 'native', ocr: 'not-performed', image: null,
    transform: { rotation: 0, cropBox: [], region, scale: 0, engine: ENGINE }, detail: `${detail} Page geometry has not been read.` };
}
