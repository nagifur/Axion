// Submissions are written in a plain-text form, so raw HTML or links with non-web schemes
// (javascript:, data:, ...) are never legitimate. The site also sanitizes rendered markdown;
// this check rejects such submissions up front with a clear message.

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const NAMED_REFERENCES = new Map([
  ["colon", ":"],
  ["tab", "\t"],
  ["newline", "\n"],
  ["sol", "/"],
  ["lpar", "("],
  ["rpar", ")"],
  ["period", "."],
]);

function fromCodePoint(code) {
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function decodeCharacterReferences(text) {
  return text
    .replace(/&#x([0-9a-f]{1,8});?/gi, (_, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,8});?/g, (_, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_REFERENCES.get(name.toLowerCase()) ?? match);
}

// Returns a human-readable reason when the markdown is unsafe, otherwise null.
export function findUnsafeMarkdown(text) {
  const tag = text.match(/<[A-Za-z!?/][^\s>]{0,20}/);
  if (tag) {
    return `HTML is not allowed (found "${tag[0]}"). If you meant a less-than sign, put a space after it.`;
  }

  const decoded = decodeCharacterReferences(text);
  const destinations = [
    ...decoded.matchAll(/\]\(\s*<?([^)>]*)/g),
    ...decoded.matchAll(/\[[^\]]*\]:\s*<?(\S+)/g),
  ].map((match) => match[1]);

  for (const destination of destinations) {
    // Browsers ignore whitespace and control characters inside URL schemes.
    const compact = destination.replace(/[\s\x00-\x1F\x7F]+/g, "").toLowerCase();
    const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
    if (scheme && !SAFE_SCHEMES.has(scheme)) return `Links using "${scheme}:" are not allowed.`;
  }
  return null;
}

// The whole file must be valid UTF-8 without control characters (tabs and newlines are fine).
export function isCleanText(data) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return !/[\x00-\x08\x0E-\x1F\x7F]/.test(text);
  } catch {
    return false;
  }
}

// Detects png/jpg/gif/webp from the file's first bytes, ignoring its name.
export function sniffImageExtension(data) {
  const hex = Array.from(data.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) return "gif";
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return "webp";
  return null;
}
