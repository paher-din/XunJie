/*! @license
 * Adapted from CopilotKit/OpenIntelligentUI at 8391a94c1c3939c679e40ddd7bfc08a9ef690e70,
 * apps/app/src/components/generative-ui/open-generative-ui/process-partial-html.ts
 * (forked there from @copilotkit/react-core/v2).
 * The MIT License, Copyright (c) Atai Barkai
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
const openIntelligentUiNotice = 'The MIT License, Copyright (c) Atai Barkai\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.'

export function processPartialHtml(html: string): string {
  let result = html.replace(/<[^>]*$/, '')
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, '')
  result = result.replace(/&[a-zA-Z0-9#]*$/, '')
  const body = result.match(/<body[^>]*>([\s\S]*)/i)
  if (body) result = body[1].replace(/<\/body>[\s\S]*/i, '')
  return result
}

/** Fragment repair is only presentational; isolation and CSP are enforced independently. */
export function staticPreviewDocument(html: string, theme: { canvas: string; ink: string; line: string; muted: string }) {
  const parsed = new DOMParser().parseFromString(processPartialHtml(html.slice(0, 500000)), 'text/html')
  parsed.querySelectorAll('script,style,iframe,object,embed,link,base,meta,form').forEach(node => node.remove())
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ['src', 'srcset', 'href', 'action', 'formaction', 'contenteditable', 'autofocus', 'style'].includes(attribute.name)) element.removeAttribute(attribute.name)
    }
    if (element.matches('input,textarea,button,select')) element.setAttribute('disabled', '')
    element.setAttribute('tabindex', '-1')
  }
  const color = (value: string) => value.replace(/[^a-zA-Z0-9#().,%\s-]/g, '')
  return '<!doctype html><!--' + openIntelligentUiNotice + '--><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>'
    + `:root{--canvas:${color(theme.canvas)};--ink:${color(theme.ink)};--line:${color(theme.line)};--muted:${color(theme.muted)}}`
    + 'body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:16px;color:var(--ink);background:var(--canvas);overflow-wrap:anywhere}*{box-sizing:border-box}input,textarea,select{max-width:100%;color:var(--muted);background:var(--canvas);border:1px solid var(--line)}</style>' + parsed.body.innerHTML
}
