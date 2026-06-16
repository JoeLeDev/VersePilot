/** Extrait un message lisible d'une erreur inconnue (catch (e: unknown)). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
