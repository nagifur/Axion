/**
 * Normalizes a destination name for lookup, so "M-031", "m031", "Red Eye" and
 * “The Host” match the keys generated from database slugs and nicknames.
 */
export function terminalKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
