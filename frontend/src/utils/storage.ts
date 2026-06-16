// Clés et helpers typés de persistance localStorage.

export const LS_KEY = "versepilot.config.v1";
export const LS_BIBLE_KEY = "versepilot.bible.v1";
export const LS_AUDIO_KEY = "versepilot.audio.v1";
export const LS_DETECTIONS_KEY = "versepilot.detections.v1";
export const LS_HISTORY_KEY = "versepilot.history.v1";

/** Lit et parse une valeur JSON du localStorage, avec repli en cas d'erreur. */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Sérialise et écrit une valeur dans le localStorage (silencieux en cas d'erreur). */
export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota dépassé ou storage indisponible : on ignore */
  }
}
