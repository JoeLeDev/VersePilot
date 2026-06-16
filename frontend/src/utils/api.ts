// Construction des URLs backend (HTTP + WebSocket).
// En mode fichier (app packagée), le backend tourne en local sur le port 4000.

export const API_BASE =
  typeof window !== "undefined" && window.location.protocol === "file:"
    ? "http://127.0.0.1:4000"
    : "";

/** Préfixe un chemin avec la base API (vide en dev, absolu en app packagée). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Construit une URL WebSocket à partir d'un chemin. */
export function wsUrl(path: string): string {
  if (API_BASE) {
    return `${API_BASE.replace(/^http/, "ws")}${path}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}
