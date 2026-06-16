// Helpers de capture/traitement audio (PCM, rééchantillonnage, détection navigateur).
// Extraits de App.tsx pour être typés et testables indépendamment.

export const STREAM_TARGET_RATE = 16000;

// AudioWorklet : capture du PCM sur le thread audio (remplace ScriptProcessor).
// Accumule ~2048 échantillons puis les transfère au thread principal.
export const PCM_WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    this._target = 2048;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      this._buf.push(new Float32Array(ch));
      this._count += ch.length;
      if (this._count >= this._target) {
        const merged = new Float32Array(this._count);
        let o = 0;
        for (const b of this._buf) { merged.set(b, o); o += b.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this._buf = [];
        this._count = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

/** Rééchantillonnage linéaire Float32 vers un autre taux. */
export function resampleFloat32(
  input: Float32Array,
  inRate: number,
  outRate: number
): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] != null ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Convertit du Float32 [-1,1] en PCM 16 bits. */
export function float32ToInt16Bytes(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Vrai si le navigateur est Safari (et non Chrome/Electron/Edge). */
export function isSafariBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Electron/i.test(ua);
}

/** Vrai si la capture du son système (getDisplayMedia) est utilisable ici. */
export function canUseSystemAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    !isSafariBrowser()
  );
}

type CaptureError = { name?: string; message?: string } | unknown;

/** Transforme une erreur de capture en message utilisateur clair. */
export function formatCaptureError(err: CaptureError): string {
  const e = (err ?? {}) as { name?: string; message?: string };
  const name = e.name || "";
  const msg = e.message || String(err);

  if (name === "NotSupportedError" || /not supported/i.test(msg)) {
    if (isSafariBrowser()) {
      return "Safari ne capture pas le son système. Utilise Chrome ou l’app Electron (npm run dev).";
    }
    if (window.versepilotDesktop?.isDesktop) {
      return "Son système indisponible. Redémarre l’app Electron, ou utilise Micro + BlackHole.";
    }
    return "Son système non supporté ici. Ouvre l’app avec npm run dev (Electron) ou Chrome, pas Safari.";
  }
  if (name === "NotAllowedError" || /denied|permission/i.test(msg)) {
    return "Partage refusé ou annulé. Réessaie et coche « Partager l’audio » (Mac) ou « Share system audio ».";
  }
  if (
    /could not start audio|audio source|loopback/i.test(msg) ||
    name === "NotReadableError"
  ) {
    return "Audio système refusé par macOS. Relance l’app Electron (npm run dev), partage l’écran entier avec « Partager l’audio du Mac », ou utilise Micro + BlackHole.";
  }
  if (name === "AbortError") {
    return "Capture annulée.";
  }
  return msg;
}
