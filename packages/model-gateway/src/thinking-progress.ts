import { createProgressPublisher, createSensitiveOutput } from './sensitive-output.js';

export function createThinkingProgress(apiKey: string, emit?: (text: string) => void) {
  let text = '';
  const publish = emit ? createProgressPublisher(apiKey, emit) : undefined;
  const append = (fragment: unknown) => {
    if (typeof fragment !== 'string' || text.length >= 16000) return;
    text = (text + fragment).slice(0, 16000).replace(/[\uD800-\uDBFF]$/, '');
    publish?.(text);
  };
  return { append, finish() { if (text) emit?.(createSensitiveOutput(apiKey).clean(text)); } };
}
