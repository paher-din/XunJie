/** Protocols supply decoded tool arguments and assembled fields, never guessed JSON text. */
export function createSensitiveOutput(apiKey: string) {
  const clean = (value: string) => apiKey ? value.split(apiKey).join('[redacted]') : value;
  function contains(value: unknown): boolean {
    if (!apiKey) return false;
    const pending = [value], seen = new Set<object>();
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === 'string') { if (current.includes(apiKey)) return true; }
      else if (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        for (const [key, item] of Object.entries(current)) {
          if (key.includes(apiKey)) return true;
          pending.push(item);
        }
      }
    }
    return false;
  }
  // The caller determines which fragments belong to a single protocol field.
  const containsFragments = (fragments: Iterable<string>) => !!apiKey && [...fragments].join('').includes(apiKey);
  return { clean, contains, containsFragments };
}

/** Publish only a prefix that cannot contain the credential, withholding any tail that could
 * grow into it. A complete occurrence stops publication; the final result still fails/redacts.
 */
export function createProgressPublisher(apiKey: string, emit: (text: string) => void) {
  let published = '', halted = false;
  return (text: string) => {
    if (halted || !text) return;
    if (!apiKey) { if (text.length > published.length) { published = text; emit(text); } return; }
    const at = text.indexOf(apiKey);
    let base = at >= 0 ? text.slice(0, at) : text;
    if (at >= 0) halted = true;
    // Even a suffix that is only the beginning of the credential stays private.
    let cut = Math.max(0, base.length - (apiKey.length - 1));
    for (let size = Math.min(apiKey.length - 1, cut); size > 0; size--) {
      if (base.slice(0, cut).endsWith(apiKey.slice(0, size))) { cut -= size; break; }
    }
    const safe = base.slice(0, cut);
    if (safe.length > published.length) { published = safe; emit(safe); }
  };
}

/** Only the ordered primary logprob tokens are a deterministic output field. */
export function protocolTokenSequences(value: unknown): string[] {
  const sequences: string[] = [], pending = [value], seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const [field, item] of Object.entries(current)) {
      if (field === 'logprobs' && Array.isArray(item)) sequences.push(item.map(part => part && typeof part === 'object'
        && typeof part.token === 'string' ? part.token : '').join(''));
      else if (field !== 'top_logprobs') pending.push(item);
    }
  }
  return [...sequences, sequences.toReversed().join('')];
}

/** Decode string tokens only at a protocol-defined JSON argument boundary.
 * An unfinished string may already contain a whole secret. This is inspection,
 * never a repaired object or permission to publish incomplete tool arguments.
 */
export function protocolJsonStrings(input: string): string[] {
  const values: string[] = [], escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  let index = 0;
  while (index < input.length) {
    if (input[index++] !== '"') continue;
    let value = '';
    while (index < input.length) {
      const character = input[index++]!;
      if (character === '"') break;
      if (character !== '\\') { value += character; continue; }
      const escaped = input[index++];
      if (escaped === 'u') {
        const hex = input.slice(index, index + 4);
        if (!/^[\da-fA-F]{4}$/.test(hex)) break;
        value += String.fromCharCode(Number.parseInt(hex, 16)); index += 4;
      } else {
        if (escaped === undefined || escapes[escaped] === undefined) break;
        value += escapes[escaped];
      }
    }
    values.push(value);
  }
  return values;
}
