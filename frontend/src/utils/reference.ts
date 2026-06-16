/** Miroir client de backend/utils/text.parseReferenceString */
export function parseReferenceString(ref: string) {
  const m = String(ref || "")
    .trim()
    .match(/^(.+?)\s+(\d+)\s*:\s*(\d+)\s*$/);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: parseInt(m[2], 10),
    verse: parseInt(m[3], 10),
  };
}
