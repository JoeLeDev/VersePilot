/**
 * Abonnement VersePilot — accès STT via proxy (clé client, pas de Deepgram exposé).
 */

export function getLicenseConfig() {
  const licenseKey = (process.env.VERSEPILOT_LICENSE_KEY || "").trim();
  const proxyUrl = (process.env.VERSEPILOT_PROXY_URL || "").replace(/\/$/, "");
  return {
    licenseKey,
    proxyUrl,
    enabled: Boolean(licenseKey && proxyUrl),
  };
}

export function isDeepgramAvailable(deepgramApiKey, license = getLicenseConfig()) {
  return Boolean(deepgramApiKey) || license.enabled;
}

export function proxyWsUrl(httpBaseUrl, path = "/v1/stt/stream") {
  const base = httpBaseUrl.replace(/\/$/, "");
  if (base.startsWith("https://")) {
    return `wss://${base.slice(8)}${path}`;
  }
  if (base.startsWith("http://")) {
    return `ws://${base.slice(7)}${path}`;
  }
  return `${base}${path}`;
}
