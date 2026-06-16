const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /DEEPGRAM_API_KEY[=:]\s*\S+/gi,
  /OPENAI_API_KEY[=:]\s*\S+/gi,
  /VP-[A-Z0-9-]{8,}/gi,
];

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function safeError(err) {
  const msg = err?.message || String(err);
  return redactSecrets(msg);
}
