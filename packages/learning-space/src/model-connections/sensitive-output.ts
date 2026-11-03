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
