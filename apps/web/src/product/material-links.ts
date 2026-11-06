/** Keep navigable source links outside the original-text selection root, so quote offsets stay exact. */
export function materialLinks(text: string): { href: string; label: string }[] {
  const links: { href: string; label: string }[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/\[([^\]\n]{1,160})\]\((https:\/\/[^\s)]+)\)/g)) {
    let url: URL
    try { url = new URL(match[2]) } catch { continue }
    if (url.username || url.password || seen.has(url.href)) continue
    seen.add(url.href)
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const context = text.slice(lineStart, match.index).replace(/^\s*[-*]\s*/, '').trim()
    links.push({ href: url.href, label: (context || match[1]).slice(0, 180) })
    if (links.length === 32) break
  }
  return links
}
