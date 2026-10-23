const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random, stable identifier such as `clip_k3j9x0a1qz`. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}
