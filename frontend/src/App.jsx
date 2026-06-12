import { useEffect, useRef, useState } from "react";

const LS_KEY = "versepilot.config.v1";
const LS_BIBLE_KEY = "versepilot.bible.v1";
const LS_AUDIO_KEY = "versepilot.audio.v1";
const LS_DETECTIONS_KEY = "versepilot.detections.v1";
const LS_HISTORY_KEY = "versepilot.history.v1";
const MAX_HISTORY = 60;
const MAX_STORED_DETECTIONS = 50;
const MIC_LEVEL_SCALE = 520;
const MIC_LEVEL_MIN_SPEECH = 8;

const defaultConfig = {
  ip: "127.0.0.1",
  port: 50001,
  dualMessages: false,
  messageId: "",
  messageName: "Verset",
  refMessageId: "",
  refMessageName: "Reference",
  refTokenName: "Reference",
  textTokenName: "Verset",
  previewBeforeSend: false,
  verseMaxChars: 220,
  streaming: true,
  noiseSuppression: true,
  echoCancellation: false,
  autoGainControl: false,
  inputGain: 100,
};

/** Découpe un verset trop long en pages, sans couper les mots. */
function splitVerseIntoPages(text, maxChars = 220) {
  const clean = (text || "").trim();
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 220;
  if (!clean || clean.length <= limit) return [clean];
  const words = clean.split(/\s+/);
  const pages = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > limit) {
      pages.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) pages.push(cur);
  return pages;
}

const API_BASE =
  window.location.protocol === "file:" ? "http://127.0.0.1:4000" : "";
const VAD_RMS_THRESHOLD = 0.006;
const VAD_MIN_AVG_RMS = 0.004;
const VAD_MIN_AVG_RMS_SYSTEM = 0.0015;
const VOICE_CHUNK_MS = 2800;
const VOICE_CHUNK_MS_SYSTEM = 3600;
const VOICE_OVERLAP_MS = 900;
const VOICE_OVERLAP_MS_SYSTEM = 1200;
// Coupe un bloc plus tôt quand le locuteur fait une pause (frontières plus nettes).
const VOICE_SILENCE_TAIL_MS = 600;
const VOICE_MIN_CHUNK_MS = 900;
const TRANSCRIBE_MAX_PARALLEL = 1;
const TRANSCRIBE_MAX_PENDING = 2;
const LAST_PHRASE_MAX_WORDS = 12;
const MIN_PHRASE_CHARS = 6;
const LIVE_SEARCH_DEBOUNCE_MS = 120;
const DETECTION_MIN_SCORE = 22;
const MAX_DETECTIONS = 40;
const MAX_QUEUE = 20;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function wsUrl(path) {
  if (API_BASE) {
    return `${API_BASE.replace(/^http/, "ws")}${path}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}

// AudioWorklet : capture du PCM sur le thread audio (remplace ScriptProcessor).
// Accumule ~2048 échantillons puis les transfère au thread principal.
const PCM_WORKLET_SRC = `
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

const STREAM_TARGET_RATE = 16000;

/** Rééchantillonnage linéaire Float32 vers un autre taux. */
function resampleFloat32(input, inRate, outRate) {
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

function float32ToInt16Bytes(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Electron/i.test(ua);
}

function canUseSystemAudio() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    !isSafariBrowser()
  );
}

function formatCaptureError(err) {
  const name = err?.name || "";
  const msg = err?.message || String(err);

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

function isSttRepetitiveHallucination(text) {
  if (!text) return false;
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const n = tokens.length;
  if (n >= 8 && new Set(tokens.slice(-8)).size === 1) return true;
  if (n >= 12 && new Set(tokens).size / n < 0.2) return true;
  let prev = null;
  let runLen = 0;
  for (const token of tokens) {
    if (token === prev) {
      runLen += 1;
      if (runLen >= 6) return true;
    } else {
      prev = token;
      runLen = 1;
    }
  }
  return false;
}

function isDuplicateTranscriptAddition(addition, transcript) {
  const add = addition.trim().toLowerCase();
  if (!add || add.length < 12) return false;
  const full = transcript.trim().toLowerCase();
  if (!full) return false;
  if (full.endsWith(add)) return true;
  const lastPhrase = extractLastPhrase(transcript).trim().toLowerCase();
  if (lastPhrase && lastPhrase === add) return true;
  if (add.length >= 20 && full.includes(add)) {
    const tail = full.slice(-Math.min(full.length, add.length * 3));
    if (tail.split(add).length > 2) return true;
  }
  return false;
}

function isSttKnownHallucination(text) {
  const n = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return false;
  const exact = [
    "sous titrage societe radio canada",
    "sous titrage st 501",
    "merci d avoir regarde",
    "thank you for watching",
    "thanks for watching",
    "subtitles by the amara org community",
  ];
  if (exact.some((p) => n === p || n.includes(p))) return true;
  if (/sous\s*titrage/.test(n) && /radio\s*canada/.test(n)) return true;
  if (/sous\s*titrage/.test(n) && n.length < 80) return true;
  if (/merci\s+d\s*avoir\s+regard/.test(n)) return true;
  return false;
}

function isSttPromptEchoText(text) {
  const t = text.trim();
  if (!t) return true;
  if (isSttKnownHallucination(t)) return true;
  if (isSttRepetitiveHallucination(t)) return true;
  const n = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:predication en francais\.?\s*)?(?:lecture biblique louis segond\.?\s*)+$/.test(
      n
    )
  ) {
    return true;
  }
  if (
    n.includes("bible francaise louis segond") &&
    n.includes("versets bibliques") &&
    t.length < 220
  ) {
    return true;
  }
  return false;
}

function normalizeMergeWords(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWordOverlap(transcriptWords, newWords, maxWords = 14) {
  if (!transcriptWords.length || !newWords.length) return 0;
  const limit = Math.min(maxWords, transcriptWords.length, newWords.length);
  for (let n = limit; n >= 2; n -= 1) {
    const suffix = normalizeMergeWords(transcriptWords.slice(-n).join(" "));
    const prefix = normalizeMergeWords(newWords.slice(0, n).join(" "));
    if (suffix && suffix === prefix) return n;
  }
  return 0;
}

function extractLastPhrase(transcript, maxWords = LAST_PHRASE_MAX_WORDS) {
  const t = transcript.trim();
  if (!t) return "";
  const parts = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const lastSentence = (parts[parts.length - 1] || t).trim();
  const words = lastSentence.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return lastSentence;
  return words.slice(-maxWords).join(" ");
}

function splitTranscriptHighlight(full) {
  const last = extractLastPhrase(full);
  if (!last) return { before: full, last: "" };
  const idx = full.lastIndexOf(last);
  if (idx < 0) return { before: full, last: "" };
  return {
    before: full.slice(0, idx).trimEnd(),
    last,
  };
}

function verseScoreLabel(verse) {
  if (verse.source === "semantic") {
    const pct =
      verse.semanticPercent ??
      (verse.reason?.match(/(\d+)\s*%/)?.[1]
        ? Number(verse.reason.match(/(\d+)\s*%/)[1])
        : null);
    return pct != null ? `${pct}% sens` : "Sémantique";
  }
  if (verse.source === "reference") return "Référence";
  if (verse.tokenHits) {
    return `${verse.tokenHits} mot${verse.tokenHits > 1 ? "s" : ""}`;
  }
  return "Texte";
}

function formatDetectionTime(ts) {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function detectionSourceLabel(source) {
  if (source === "reference") return "Référence";
  if (source === "chapter") return "Chapitre";
  if (source === "citation") return "Citation";
  if (source === "semantic") return "Sémantique";
  if (source === "lexical") return "Mots";
  return "Texte";
}

export default function App() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [config, setConfig] = useState(defaultConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [lastSent, setLastSent] = useState(null);
  const [sending, setSending] = useState(null); // reference being sent
  const [history, setHistory] = useState([]);
  const [ppConnected, setPpConnected] = useState(null); // null=inconnu, true, false
  const [hiding, setHiding] = useState(false);
  const [preview, setPreview] = useState(null); // { verse, pages, pageIndex }
  const [ppStatus, setPpStatus] = useState(null);
  const [ppStatusLoading, setPpStatusLoading] = useState(false);
  const [ppMessages, setPpMessages] = useState([]);
  const [ppMessagesLoading, setPpMessagesLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported] = useState(
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
  const [liveTranscript, setLiveTranscript] = useState("");
  const [fullTranscript, setFullTranscript] = useState("");
  const [lastPhrase, setLastPhrase] = useState("");
  const [detections, setDetections] = useState([]);
  const [queue, setQueue] = useState([]);
  const [liveSearching, setLiveSearching] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [micLevelPct, setMicLevelPct] = useState(0);
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [audioSource, setAudioSource] = useState("mic");
  const [autoVoiceSearch, setAutoVoiceSearch] = useState(true);
  const stopMeterRef = useRef(null);
  const meterRafRef = useRef(null);
  const [sttMode, setSttMode] = useState("local");
  const [sttEngine, setSttEngine] = useState("");
  const [streamingAvailable, setStreamingAvailable] = useState(false);
  const [streamInterim, setStreamInterim] = useState("");
  const [sttConfidence, setSttConfidence] = useState(null);
  const streamWsRef = useRef(null);
  const streamCtxRef = useRef(null);
  const streamCleanupRef = useRef(null);
  const [bibleVersions, setBibleVersions] = useState([]);
  const [bibleVersion, setBibleVersion] = useState("");
  const [bibleVersionName, setBibleVersionName] = useState("");
  const [bibleVersionLoading, setBibleVersionLoading] = useState(false);
  const [embeddingHint, setEmbeddingHint] = useState("");
  const inputRef = useRef(null);
  const listeningRef = useRef(false);
  const transcriptRef = useRef("");
  const lastPhraseSearchRef = useRef("");
  const liveSearchAbortRef = useRef(null);
  const liveSearchDebounceRef = useRef(null);
  const previousChunkTailRef = useRef("");
  const searchAbortRef = useRef(null);
  const listenSessionRef = useRef(0);
  const transcribeQueueRef = useRef([]);
  const transcribeActiveRef = useRef(0);
  const chunkResultsRef = useRef(new Map());
  const nextApplySeqRef = useRef(0);
  const chunkSeqRef = useRef(0);
  const audioOverlapRef = useRef(null);
  const bibleContextRef = useRef({ book: null, chapter: null });
  const refScanDebounceRef = useRef(null);
  const lastRefScanTextRef = useRef("");

  async function refreshAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    setAudioInputDevices(inputs);
    setSelectedDeviceId((prev) =>
      prev && !inputs.some((d) => d.deviceId === prev) ? "" : prev
    );
  }

  async function ensureMicPermissionForLabels() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  function persistAudioPrefs(nextDeviceId, nextSource) {
    try {
      localStorage.setItem(
        LS_AUDIO_KEY,
        JSON.stringify({
          deviceId: nextDeviceId,
          source: nextSource,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function startMicLevelMeter(stream) {
    stopMeterRef.current?.();
    const audioContext = new window.AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / data.length);
      setMicLevelPct(Math.min(100, Math.round(rms * MIC_LEVEL_SCALE)));
      meterRafRef.current = requestAnimationFrame(tick);
    };

    tick();

    stopMeterRef.current = () => {
      if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
      source.disconnect();
      audioContext.close().catch(() => {});
      stopMeterRef.current = null;
    };
  }

  async function acquireListenStream(sourceMode, deviceId) {
    if (sourceMode === "system") {
      if (!canUseSystemAudio()) {
        throw new Error(formatCaptureError({ name: "NotSupportedError" }));
      }
      let displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 320 },
            height: { ideal: 180 },
            frameRate: { ideal: 5, max: 10 },
          },
          audio: true,
        });
      } catch (err) {
        throw new Error(formatCaptureError(err));
      }
      displayStream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = displayStream.getAudioTracks();
      if (!audioTracks.length) {
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "Aucune piste audio système. macOS : choisis l’écran entier (pas une fenêtre) et coche « Partager l’audio du Mac ». Sinon Micro + BlackHole (https://existential.audio/blackhole/)."
        );
      }
      return new MediaStream(audioTracks);
    }

    const constraints = {
      audio: {
        echoCancellation: Boolean(config.echoCancellation),
        noiseSuppression: Boolean(config.noiseSuppression),
        autoGainControl: Boolean(config.autoGainControl),
        channelCount: 1,
      },
    };
    if (deviceId) {
      constraints.audio.deviceId = { exact: deviceId };
    }
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function clearTranscript() {
    transcriptRef.current = "";
    previousChunkTailRef.current = "";
    lastPhraseSearchRef.current = "";
    setFullTranscript("");
    setLastPhrase("");
    if (!isListening) setLiveTranscript("");
  }

  // Load config from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) setConfig({ ...defaultConfig, ...JSON.parse(saved) });
    } catch {}
    try {
      const detSaved = localStorage.getItem(LS_DETECTIONS_KEY);
      if (detSaved) {
        const parsed = JSON.parse(detSaved);
        if (Array.isArray(parsed) && parsed.length) {
          setDetections(parsed.slice(0, MAX_DETECTIONS));
        }
      }
    } catch {}
    try {
      const histSaved = localStorage.getItem(LS_HISTORY_KEY);
      if (histSaved) {
        const parsed = JSON.parse(histSaved);
        if (Array.isArray(parsed) && parsed.length) {
          setHistory(parsed.slice(0, MAX_HISTORY));
        }
      }
    } catch {}
    try {
      const audioSaved = localStorage.getItem(LS_AUDIO_KEY);
      if (audioSaved) {
        const { deviceId, source } = JSON.parse(audioSaved);
        if (source === "system" || source === "mic") {
          const resolved =
            source === "system" && !canUseSystemAudio() ? "mic" : source;
          setAudioSource(resolved);
        }
        if (deviceId) setSelectedDeviceId(deviceId);
      }
    } catch {}
    inputRef.current?.focus();

    fetch(apiUrl("/health"))
      .then((r) => r.json())
      .then((data) => {
        if (data?.sttMode) setSttMode(data.sttMode);
        if (data?.bibleVersion) setBibleVersion(data.bibleVersion);
        if (data?.bibleName) setBibleVersionName(data.bibleName);
        setStreamingAvailable(Boolean(data?.streamingAvailable));
      })
      .catch(() => {});

    fetch(apiUrl("/bible/versions"))
      .then((r) => r.json())
      .then((data) => {
        const available = (data?.versions || []).filter(
          (v) => v.available !== false && (v.verseCount || 0) > 0
        );
        if (available.length) setBibleVersions(available);
        const saved = localStorage.getItem(LS_BIBLE_KEY);
        const slug =
          saved && available.some((v) => v.slug === saved)
            ? saved
            : data?.active;
        if (slug) void applyBibleVersion(slug, available, data?.activeName);
        else if (data?.active) {
          setBibleVersion(data.active);
          setBibleVersionName(data.activeName || data.active);
        }
      })
      .catch(() => {});

    if (speechSupported) {
      (async () => {
        try {
          await ensureMicPermissionForLabels();
          await refreshAudioDevices();
        } catch {
          /* permissions refusées */
        }
      })();
      const onDeviceChange = () => {
        void refreshAudioDevices();
      };
      navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
      return () => {
        navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      };
    }
  }, []);

  // Persist config changes
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(config));
  }, [config]);

  // Sonde de connexion ProPresenter (état permanent dans la barre)
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      if (!config.ip || !config.port) {
        if (!cancelled) setPpConnected(null);
        return;
      }
      try {
        const params = new URLSearchParams({
          ip: config.ip,
          port: String(config.port),
        });
        const r = await fetch(apiUrl(`/propresenter/health?${params}`));
        const data = await r.json();
        if (!cancelled) setPpConnected(Boolean(r.ok && data.ok));
      } catch {
        if (!cancelled) setPpConnected(false);
      }
    }
    probe();
    const id = setInterval(probe, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.ip, config.port]);

  // Raccourcis clavier régie : 1/2/3 = afficher la suggestion, Échap = masquer
  useEffect(() => {
    function onKey(e) {
      const el = e.target;
      const tag = el?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable;

      if (e.key === "Escape") {
        if (preview) {
          setPreview(null);
        } else {
          void hideProPresenter();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (["1", "2", "3"].includes(e.key)) {
        const idx = Number(e.key) - 1;
        const verse = results[idx];
        if (verse) {
          e.preventDefault();
          requestSend(verse);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, preview, config]);

  function persistHistory(list) {
    try {
      localStorage.setItem(
        LS_HISTORY_KEY,
        JSON.stringify(list.slice(0, MAX_HISTORY))
      );
    } catch {
      /* ignore */
    }
  }

  function recordHistory(entry) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY);
      persistHistory(next);
      return next;
    });
  }

  async function applyBibleVersion(slug, versionsList = bibleVersions, fallbackName) {
    if (!slug) return;
    const found = versionsList.find((v) => v.slug === slug);
    setBibleVersion(slug);
    setBibleVersionName(found?.name || fallbackName || slug);
    localStorage.setItem(LS_BIBLE_KEY, slug);
    setBibleVersionLoading(true);
    try {
      const r = await fetch(apiUrl("/bible/select"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: slug }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Version introuvable.");
      if (data.activeName) setBibleVersionName(data.activeName);
      if (data.active) setBibleVersion(data.active);
      setEmbeddingHint(data.embeddingHint || "");
    } catch (e) {
      setError(`Bible : ${e.message}`);
    } finally {
      setBibleVersionLoading(false);
    }
  }

  const bibleVersionOptions =
    bibleVersions.length > 0
      ? bibleVersions
      : bibleVersion
        ? [
            {
              slug: bibleVersion,
              name: bibleVersionName || bibleVersion,
              verseCount: 0,
            },
          ]
        : [];

  async function fetchVerseSuggestions(q, signal, { live = false } = {}) {
    const r = await fetch(apiUrl("/search-verse"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        version: bibleVersion || undefined,
        live: live || undefined,
      }),
      signal,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Erreur de recherche.");
    return {
      suggestions: data.suggestions || [],
      mode: data.mode || "offline",
    };
  }

  function persistDetectionsList(list) {
    try {
      localStorage.setItem(
        LS_DETECTIONS_KEY,
        JSON.stringify(list.slice(0, MAX_STORED_DETECTIONS))
      );
    } catch {
      /* quota */
    }
  }

  function mergeDetectionsList(prev, fresh) {
    const merged = [...fresh, ...prev];
    const seen = new Set();
    const deduped = [];
    for (const item of merged) {
      const key = item.verse.reference;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
      if (deduped.length >= MAX_DETECTIONS) break;
    }
    persistDetectionsList(deduped);
    return deduped;
  }

  function pushDetectionEntries(entries) {
    if (!entries.length) return;
    setDetections((prev) => mergeDetectionsList(prev, entries));
  }

  function pushDetections(phrase, suggestions, mode) {
    const fresh = [];
    for (const verse of suggestions.slice(0, 3)) {
      const score = verse.score || 0;
      const tokenHits = verse.tokenHits || 0;
      let source = verse.source;
      if (!source) {
        if (score >= 90) source = "reference";
        else if (tokenHits >= 6 || score >= 78) source = "citation";
        else if (mode === "ai") source = "ai";
        else source = "semantic";
      }
      const minScore =
        source === "reference" || source === "chapter" ? 70 : DETECTION_MIN_SCORE;
      if (score < minScore && source !== "reference" && source !== "chapter") {
        continue;
      }
      fresh.push({
        id: `${verse.reference}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        verse,
        phrase,
        score,
        source,
        detectedAt: Date.now(),
      });
    }
    if (!fresh.length) return;
    pushDetectionEntries(fresh);
  }

  async function scanTranscriptForReferences(snippet) {
    const text = (snippet || transcriptRef.current || "").trim();
    if (text.length < 4) return;
    if (lastRefScanTextRef.current === text) return;
    lastRefScanTextRef.current = text;

    try {
      const r = await fetch(apiUrl("/detect-references"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          context: bibleContextRef.current,
          version: bibleVersion || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) return;
      if (data.context) bibleContextRef.current = data.context;

      const hits = data.hits || [];
      if (!hits.length) return;

      const entries = hits.map((verse) => ({
        id: `${verse.reference}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        verse,
        phrase: verse.matchedText || text.slice(-80),
        score: verse.score || 95,
        source: verse.source || "reference",
        detectedAt: Date.now(),
      }));
      pushDetectionEntries(entries);
      setResults((prev) => {
        const byRef = new Map(prev.map((v) => [v.reference, v]));
        for (const h of hits) byRef.set(h.reference, h);
        return [...byRef.values()].slice(0, 8);
      });
    } catch {
      /* réseau */
    }
  }

  function scheduleReferenceScan(snippet) {
    const text = (snippet || "").trim();
    if (text.length < 4) return;
    if (refScanDebounceRef.current) clearTimeout(refScanDebounceRef.current);
    refScanDebounceRef.current = setTimeout(() => {
      refScanDebounceRef.current = null;
      void scanTranscriptForReferences(text);
    }, 180);
  }

  async function handleSearch(forcedQuery) {
    const q = (forcedQuery ?? query).trim();
    if (!q) return;

    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setLoading(true);
    setError("");
    setResults([]);
    try {
      const { suggestions } = await fetchVerseSuggestions(q, controller.signal);
      setResults(suggestions);
      if (!suggestions.length) setError("Aucun verset trouvé.");
    } catch (e) {
      if (e.name === "AbortError") {
        return;
      }
      setError(e.message);
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
        setLoading(false);
      }
    }
  }

  function scheduleLiveSearch(phrase) {
    const normalized = phrase.trim();
    if (normalized.length < MIN_PHRASE_CHARS) return;
    if (liveSearchDebounceRef.current) {
      clearTimeout(liveSearchDebounceRef.current);
    }
    liveSearchDebounceRef.current = setTimeout(() => {
      liveSearchDebounceRef.current = null;
      void searchFromLastPhrase(normalized);
    }, LIVE_SEARCH_DEBOUNCE_MS);
  }

  async function searchFromLastPhrase(phrase) {
    const normalized = phrase.trim();
    if (normalized.length < MIN_PHRASE_CHARS) return;
    if (lastPhraseSearchRef.current === normalized) return;
    lastPhraseSearchRef.current = normalized;

    if (liveSearchAbortRef.current) {
      liveSearchAbortRef.current.abort();
    }
    const controller = new AbortController();
    liveSearchAbortRef.current = controller;

    setLiveSearching(true);
    try {
      const { suggestions, mode } = await fetchVerseSuggestions(
        normalized,
        controller.signal,
        { live: true }
      );
      if (suggestions.length) {
        setResults(suggestions);
        pushDetections(normalized, suggestions, mode);
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      setError(e.message);
    } finally {
      if (liveSearchAbortRef.current === controller) {
        liveSearchAbortRef.current = null;
        setLiveSearching(false);
      }
    }
  }

  function addToQueue(verse) {
    setQueue((prev) => {
      if (prev.some((v) => v.reference === verse.reference)) return prev;
      return [{ ...verse, queuedAt: Date.now() }, ...prev].slice(0, MAX_QUEUE);
    });
  }

  function removeFromQueue(reference) {
    setQueue((prev) => prev.filter((v) => v.reference !== reference));
  }

  function openPreview(verse) {
    const pages = splitVerseIntoPages(verse.text, config.verseMaxChars);
    setPreview({ verse, pages, pageIndex: 0 });
  }

  // Point d'entrée des boutons "Afficher" : aperçu d'abord si activé.
  function requestSend(verse) {
    if (config.previewBeforeSend) {
      openPreview(verse);
      return;
    }
    void sendToProPresenter(verse);
  }

  async function sendToProPresenter(verse, overrideText) {
    setSending(verse.reference);
    setError("");
    const textToSend = overrideText != null ? overrideText : verse.text;
    try {
      const r = await fetch(apiUrl("/send-to-propresenter"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          port: Number(config.port),
          dualMessages: Boolean(config.dualMessages),
          messageId: config.messageId || undefined,
          messageName: config.messageName,
          refMessageId: config.refMessageId || undefined,
          refMessageName: config.refMessageName,
          refTokenName: config.refTokenName,
          textTokenName: config.textTokenName,
          reference: verse.reference,
          text: textToSend,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Envoi impossible.");
      setLastSent({
        ref: verse.reference,
        at: new Date(),
        mode: data.mode || "single",
      });
      setPpConnected(true);
      recordHistory({
        id: `${verse.reference}-${Date.now()}`,
        reference: verse.reference,
        version: verse.version || "",
        text: textToSend,
        at: Date.now(),
        mode: data.mode || "single",
      });
    } catch (e) {
      setError(`ProPresenter : ${e.message}`);
    } finally {
      setSending(null);
    }
  }

  async function hideProPresenter() {
    setHiding(true);
    setError("");
    try {
      const r = await fetch(apiUrl("/propresenter/clear"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          port: Number(config.port),
          all: true,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Masquage impossible.");
      setPpConnected(true);
      setLastSent(null);
    } catch (e) {
      setError(`ProPresenter : ${e.message}`);
    } finally {
      setHiding(false);
    }
  }

  function sendPreviewPage() {
    if (!preview) return;
    const text = preview.pages[preview.pageIndex] ?? preview.verse.text;
    void sendToProPresenter(preview.verse, text);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  }

  function runLiveDetectionIfNeeded(transcript, addition = "") {
    const phrase = extractLastPhrase(transcript);
    setLastPhrase(phrase);
    if (!autoVoiceSearch) return;
    if (phrase) scheduleLiveSearch(phrase);
    const early = addition.trim();
    if (early.length >= MIN_PHRASE_CHARS && early !== phrase) {
      scheduleLiveSearch(extractLastPhrase(early) || early);
    }
  }

  function updateTranscribePendingUi() {
    const pending =
      transcribeActiveRef.current + transcribeQueueRef.current.length;
    setPendingTranscriptions(pending);
    setIsTranscribing(pending > 0);
    refreshLiveTranscriptLine(pending);
  }

  function refreshLiveTranscriptLine(pendingOverride) {
    if (!listeningRef.current) return;
    const pending =
      pendingOverride ??
      transcribeActiveRef.current + transcribeQueueRef.current.length;
    const spoken = transcriptRef.current.trim();
    if (spoken) {
      setLiveTranscript(
        pending > 0
          ? `${spoken}\n\n(${pending} segment(s) en traitement…)`
          : spoken
      );
      return;
    }
    if (pending > 0) {
      setLiveTranscript(
        `Transcription en cours (${pending} segment(s))… Parle clairement.`
      );
      return;
    }
    setLiveTranscript(
      audioSource === "system" ? "Écoute du son système…" : "Écoute du micro…"
    );
  }

  function resetTranscribePipeline() {
    listenSessionRef.current += 1;
    transcribeQueueRef.current = [];
    transcribeActiveRef.current = 0;
    chunkResultsRef.current.clear();
    nextApplySeqRef.current = 0;
    chunkSeqRef.current = 0;
    audioOverlapRef.current = null;
    bibleContextRef.current = { book: null, chapter: null };
    lastRefScanTextRef.current = "";
    updateTranscribePendingUi();
  }

  function mergeTranscriptAddition(text) {
    if (isSttPromptEchoText(text)) return false;
    const newWords = text.split(/\s+/).filter(Boolean);
    const transcriptWords = transcriptRef.current.split(/\s+/).filter(Boolean);
    let overlap = countWordOverlap(transcriptWords, newWords);
    let addition = text;

    if (overlap > 0) {
      addition = newWords.slice(overlap).join(" ");
    } else if (previousChunkTailRef.current) {
      const tail = previousChunkTailRef.current.toLowerCase();
      const lower = text.toLowerCase();
      if (lower.startsWith(tail)) {
        addition = text.slice(previousChunkTailRef.current.length).trim();
      }
    }

    if (!addition) return false;
    if (
      isSttRepetitiveHallucination(addition) ||
      isDuplicateTranscriptAddition(addition, transcriptRef.current)
    ) {
      return false;
    }
    previousChunkTailRef.current = addition.split(" ").slice(-10).join(" ");
    transcriptRef.current = `${transcriptRef.current} ${addition}`.trim();
    setFullTranscript(transcriptRef.current);
    refreshLiveTranscriptLine();
    scheduleReferenceScan(addition || text);
    runLiveDetectionIfNeeded(transcriptRef.current, addition);
    return true;
  }

  function applyChunkResult(seq, text) {
    chunkResultsRef.current.set(seq, text ?? "");
    while (chunkResultsRef.current.has(nextApplySeqRef.current)) {
      const chunkText = chunkResultsRef.current.get(nextApplySeqRef.current);
      chunkResultsRef.current.delete(nextApplySeqRef.current);
      nextApplySeqRef.current += 1;
      if (chunkText) mergeTranscriptAddition(chunkText);
    }
  }

  async function runTranscriptionJob({ wavBlob, sessionId, seq }) {
    try {
      const text = await transcribeAudio(wavBlob);
      if (sessionId !== listenSessionRef.current) return;
      applyChunkResult(seq, text || "");
    } catch (e) {
      if (sessionId !== listenSessionRef.current) return;
      if (e.name === "AbortError") return;
      setError(`Dictée : ${e.message}`);
      listeningRef.current = false;
      setIsListening(false);
    }
  }

  function drainTranscribeQueue() {
    while (
      transcribeActiveRef.current < TRANSCRIBE_MAX_PARALLEL &&
      transcribeQueueRef.current.length > 0
    ) {
      const job = transcribeQueueRef.current.shift();
      transcribeActiveRef.current += 1;
      updateTranscribePendingUi();
      void runTranscriptionJob(job).finally(() => {
        transcribeActiveRef.current -= 1;
        updateTranscribePendingUi();
        drainTranscribeQueue();
      });
    }
  }

  function scheduleTranscription(wavBlob, sessionId) {
    const pending =
      transcribeActiveRef.current + transcribeQueueRef.current.length;
    if (pending >= TRANSCRIBE_MAX_PENDING) {
      if (transcribeQueueRef.current.length > 0) {
        transcribeQueueRef.current.shift();
      } else {
        return;
      }
    }
    const seq = chunkSeqRef.current;
    chunkSeqRef.current += 1;
    transcribeQueueRef.current.push({ wavBlob, sessionId, seq });
    updateTranscribePendingUi();
    drainTranscribeQueue();
  }

  function stopVoiceRecognition() {
    listeningRef.current = false;
    setIsListening(false);
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
    }
    stopMeterRef.current?.();
    setMicLevelPct(0);
    resetTranscribePipeline();
  }

  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  function encodeWav(samplesFloat32, sampleRate) {
    const pcm = floatTo16BitPCM(samplesFloat32);
    const wavBuffer = new ArrayBuffer(44 + pcm.length);
    const view = new DataView(wavBuffer);

    const writeString = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + pcm.length, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // sampleRate * channels * bytesPerSample
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, pcm.length, true);

    new Uint8Array(wavBuffer, 44).set(pcm);
    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  async function captureWavChunk(
    stream,
    durationMs = VOICE_CHUNK_MS,
    minAvgRms = VAD_MIN_AVG_RMS,
    overlapPrefix = null,
    overlapMs = VOICE_OVERLAP_MS
  ) {
    const audioContext = new window.AudioContext();
    const sampleRate = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let totalFrames = 0;
    let speechFrames = 0;
    let rmsSum = 0;
    let trailingSilentFrames = 0;
    const frameSamples = 4096;

    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(channel));
      totalFrames += 1;

      let squareSum = 0;
      for (let i = 0; i < channel.length; i += 1) {
        squareSum += channel[i] * channel[i];
      }
      const rms = Math.sqrt(squareSum / channel.length);
      rmsSum += rms;
      if (rms >= VAD_RMS_THRESHOLD) {
        speechFrames += 1;
        trailingSilentFrames = 0;
      } else {
        trailingSilentFrames += 1;
      }
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    // Attend jusqu'à durationMs, mais coupe plus tôt si pause après de la parole.
    const frameMs = (frameSamples / sampleRate) * 1000;
    const startedAt = Date.now();
    await new Promise((resolve) => {
      const check = () => {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= durationMs) return resolve();
        const trailingSilenceMs = trailingSilentFrames * frameMs;
        if (
          elapsed >= VOICE_MIN_CHUNK_MS &&
          speechFrames > 0 &&
          trailingSilenceMs >= VOICE_SILENCE_TAIL_MS
        ) {
          return resolve();
        }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });

    processor.disconnect();
    source.disconnect();
    await audioContext.close();

    const length = chunks.reduce((acc, item) => acc + item.length, 0);
    const merged = new Float32Array(length);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const gainFactor = Math.max(
      0,
      Math.min(3, (Number(config.inputGain) || 100) / 100)
    );
    if (gainFactor !== 1) {
      for (let i = 0; i < merged.length; i += 1) {
        merged[i] = Math.max(-1, Math.min(1, merged[i] * gainFactor));
      }
    }

    let pcm = merged;
    if (
      overlapPrefix?.samples?.length &&
      overlapPrefix.sampleRate === sampleRate
    ) {
      const combined = new Float32Array(
        overlapPrefix.samples.length + merged.length
      );
      combined.set(overlapPrefix.samples, 0);
      combined.set(merged, overlapPrefix.samples.length);
      pcm = combined;
    }

    const overlapSamples = Math.max(
      1,
      Math.floor(sampleRate * (overlapMs / 1000))
    );
    const overlapTail =
      pcm.length > overlapSamples
        ? pcm.slice(pcm.length - overlapSamples)
        : pcm.slice();

    const speechRatio = totalFrames ? speechFrames / totalFrames : 0;
    const avgRms = totalFrames ? rmsSum / totalFrames : 0;

    return {
      wavBlob: encodeWav(pcm, sampleRate),
      sampleRate,
      overlapTail,
      speechRatio,
      avgRms,
      hasSpeech: avgRms >= minAvgRms,
    };
  }

  async function blobToBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function transcribeAudio(wavBlob) {
    const audioBase64 = await blobToBase64(wavBlob);
    const r = await fetch(apiUrl("/transcribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64 }),
    });
    const raw = await r.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!r.ok) {
      throw new Error(
        (data && data.error) ||
          `Transcription impossible (HTTP ${r.status}).`
      );
    }
    if (!data) {
      throw new Error("Reponse backend vide pendant la transcription.");
    }
    if (data.engine) setSttEngine(data.engine);
    const text = (data.text || "").trim();
    return isSttPromptEchoText(text) ? "" : text;
  }

  async function startVoiceRecognition() {
    if (!speechSupported) {
      setError("Micro non supporte sur cet appareil.");
      return;
    }
    let stream;
    try {
      stream = await acquireListenStream(audioSource, selectedDeviceId);
      startMicLevelMeter(stream);
      const sessionId = listenSessionRef.current;
      while (listeningRef.current) {
        const chunkMs =
          audioSource === "system" ? VOICE_CHUNK_MS_SYSTEM : VOICE_CHUNK_MS;
        const overlapMs =
          audioSource === "system" ? VOICE_OVERLAP_MS_SYSTEM : VOICE_OVERLAP_MS;
        const capture = await captureWavChunk(
          stream,
          chunkMs,
          audioSource === "system" ? VAD_MIN_AVG_RMS_SYSTEM : VAD_MIN_AVG_RMS,
          audioOverlapRef.current,
          overlapMs
        );
        if (capture.overlapTail?.length) {
          audioOverlapRef.current = {
            samples: capture.overlapTail,
            sampleRate: capture.sampleRate,
          };
        }
        if (!listeningRef.current) break;

        if (!capture.hasSpeech) {
          if (!transcriptRef.current.trim() && !isTranscribing) {
            setLiveTranscript("Silence détecté, parle un peu plus fort.");
          } else {
            refreshLiveTranscriptLine();
          }
          continue;
        }

        scheduleTranscription(capture.wavBlob, sessionId);
      }
    } catch (e) {
      setError(`Dictée : ${formatCaptureError(e)}`);
      listeningRef.current = false;
      setIsListening(false);
    } finally {
      stopMeterRef.current?.();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setMicLevelPct(0);
      if (!listeningRef.current) setLiveTranscript("");
    }
  }

  function handleStreamInterim(text) {
    setStreamInterim(text);
    const committed = transcriptRef.current.trim();
    const combined = committed ? `${committed} ${text}` : text;
    scheduleReferenceScan(text);
    runLiveDetectionIfNeeded(combined, text);
  }

  function appendStreamingFinal(text) {
    const clean = (text || "").trim();
    setStreamInterim("");
    if (!clean) return;
    if (isSttPromptEchoText(clean) || isSttRepetitiveHallucination(clean)) {
      return;
    }
    if (isDuplicateTranscriptAddition(clean, transcriptRef.current)) return;
    transcriptRef.current = `${transcriptRef.current} ${clean}`.trim();
    setFullTranscript(transcriptRef.current);
    scheduleReferenceScan(clean);
    runLiveDetectionIfNeeded(transcriptRef.current, clean);
  }

  async function startStreamingRecognition() {
    let stream;
    try {
      stream = await acquireListenStream(audioSource, selectedDeviceId);
    } catch (e) {
      setError(`Dictée : ${formatCaptureError(e)}`);
      listeningRef.current = false;
      setIsListening(false);
      return;
    }
    startMicLevelMeter(stream);

    const ctx = new window.AudioContext();
    streamCtxRef.current = ctx;
    const inRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = Math.max(
      0,
      Math.min(3, (Number(config.inputGain) || 100) / 100)
    );

    let workletNode = null;
    let ws = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        /* ignore */
      }
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
      try {
        workletNode && workletNode.disconnect();
      } catch {
        /* ignore */
      }
      try {
        gain.disconnect();
        source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
      stopMeterRef.current?.();
      stream.getTracks().forEach((t) => t.stop());
      setMicLevelPct(0);
      setStreamInterim("");
      streamWsRef.current = null;
      streamCtxRef.current = null;
      streamCleanupRef.current = null;
    };
    streamCleanupRef.current = cleanup;

    try {
      const blob = new Blob([PCM_WORKLET_SRC], {
        type: "application/javascript",
      });
      const moduleUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      workletNode = new AudioWorkletNode(ctx, "pcm-capture");
    } catch (e) {
      setError("AudioWorklet indisponible — bascule en mode blocs.");
      cleanup();
      if (listeningRef.current) startVoiceRecognition();
      return;
    }

    ws = new WebSocket(wsUrl(`/stt/stream?sampleRate=${STREAM_TARGET_RATE}`));
    ws.binaryType = "arraybuffer";
    streamWsRef.current = ws;

    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.type === "error") {
        setError(`Streaming : ${data.error}`);
        return;
      }
      if (data.type === "transcript") {
        if (data.confidence != null) setSttConfidence(data.confidence);
        if (data.isFinal) appendStreamingFinal(data.text);
        else handleStreamInterim(data.text);
      }
    };
    ws.onerror = () => {
      if (listeningRef.current) setError("Connexion streaming interrompue.");
    };

    workletNode.port.onmessage = (e) => {
      if (!listeningRef.current || closed) return;
      const float = e.data;
      const resampled = resampleFloat32(float, inRate, STREAM_TARGET_RATE);
      const int16 = float32ToInt16Bytes(resampled);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(int16.buffer);
      }
    };

    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(gain);
    gain.connect(workletNode);
    workletNode.connect(sink);
    sink.connect(ctx.destination);

    setLiveTranscript("Écoute du micro… (temps réel)");
  }

  function toggleVoiceRecognition() {
    if (isListening) {
      stopVoiceRecognition();
      return;
    }
    setError("");
    transcriptRef.current = "";
    previousChunkTailRef.current = "";
    lastPhraseSearchRef.current = "";
    setFullTranscript("");
    setLastPhrase("");
    setLiveTranscript("Écoute du micro…");
    resetTranscribePipeline();
    audioOverlapRef.current = null;
    bibleContextRef.current = { book: null, chapter: null };
    lastRefScanTextRef.current = "";
    if (refScanDebounceRef.current) {
      clearTimeout(refScanDebounceRef.current);
      refScanDebounceRef.current = null;
    }
    if (liveSearchDebounceRef.current) {
      clearTimeout(liveSearchDebounceRef.current);
      liveSearchDebounceRef.current = null;
    }
    listeningRef.current = true;
    setIsListening(true);
    setSttConfidence(null);
    setStreamInterim("");
    const useStreaming = config.streaming && streamingAvailable;
    if (useStreaming) {
      void startStreamingRecognition();
      return;
    }
    if (sttMode === "mlx" || sttMode === "hybrid") {
      void fetch(apiUrl("/stt/warmup"), { method: "POST" }).catch(() => {});
    }
    startVoiceRecognition();
  }

  useEffect(() => {
    return () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
      if (liveSearchAbortRef.current) {
        liveSearchAbortRef.current.abort();
      }
      if (liveSearchDebounceRef.current) {
        clearTimeout(liveSearchDebounceRef.current);
      }
      stopVoiceRecognition();
    };
  }, []);

  const transcriptDisplay = (() => {
    const base = fullTranscript.trim();
    if (streamInterim) {
      return base ? `${base} ${streamInterim}` : streamInterim;
    }
    return base || (isListening || isTranscribing ? liveTranscript : "");
  })();
  const transcriptParts = splitTranscriptHighlight(
    fullTranscript.trim() ? fullTranscript : ""
  );
  const showInterimStatus =
    !fullTranscript.trim() && Boolean(liveTranscript.trim());

  async function testProPresenterConnection() {
    setPpStatusLoading(true);
    try {
      const params = new URLSearchParams({
        ip: config.ip,
        port: String(config.port),
      });
      const r = await fetch(apiUrl(`/propresenter/health?${params.toString()}`));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Connexion impossible.");
      setPpStatus({
        ok: true,
        message: `Connecté (${config.ip}:${config.port})`,
        version: data.version,
      });
    } catch (e) {
      setPpStatus({ ok: false, message: e.message, version: null });
    } finally {
      setPpStatusLoading(false);
    }
  }

  async function loadProPresenterMessages() {
    setPpMessagesLoading(true);
    try {
      const params = new URLSearchParams({
        ip: config.ip,
        port: String(config.port),
      });
      const r = await fetch(
        apiUrl(`/propresenter/messages?${params.toString()}`)
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Chargement impossible.");
      setPpMessages(data.messages || []);
    } catch (e) {
      setError(`ProPresenter : ${e.message}`);
      setPpMessages([]);
    } finally {
      setPpMessagesLoading(false);
    }
  }

  return (
    <div className="app">
      <div className="grid-bg" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="brand-name">VersePilot</span>
          <span className="brand-live">LIVE</span>
        </div>
        <div className="topbar-right">
          <div className="topbar-bible">
            <label className="bible-version-label" htmlFor="topbar-bible-version">
              Bible
            </label>
            <select
              id="topbar-bible-version"
              className="bible-version-select topbar-bible-select"
              value={bibleVersion}
              disabled={bibleVersionLoading || !bibleVersionOptions.length}
              onChange={(e) => applyBibleVersion(e.target.value)}
            >
              {bibleVersionOptions.map((v) => (
                <option key={v.slug} value={v.slug}>
                  {v.name}
                  {v.verseCount ? ` (${v.verseCount})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div
            className={`pp-status ${
              ppConnected === true
                ? "ok"
                : ppConnected === false
                ? "ko"
                : "unknown"
            }`}
            title={
              ppConnected === true
                ? `ProPresenter connecté (${config.ip}:${config.port})`
                : ppConnected === false
                ? "ProPresenter injoignable"
                : "État ProPresenter inconnu"
            }
          >
            <span className="status-dot" />
            PP
          </div>
          {lastSent && (
            <div className="last-sent">
              Dernier : <strong>{lastSent.ref}</strong>
            </div>
          )}
          <button
            className="icon-btn hide-btn"
            onClick={hideProPresenter}
            disabled={hiding}
            aria-label="Masquer le verset à l'écran"
            title="Masquer le verset (Échap)"
          >
            {hiding ? "…" : "Masquer"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowConfig((v) => !v)}
            aria-label="Configuration ProPresenter"
            title="Configuration ProPresenter"
          >
            ⚙
          </button>
        </div>
      </header>

      {embeddingHint && (
        <div className="embedding-hint-banner" role="status">
          {embeddingHint}
        </div>
      )}

      {showConfig && (
        <ConfigPanel
          config={config}
          setConfig={setConfig}
          ppStatus={ppStatus}
          ppStatusLoading={ppStatusLoading}
          ppMessages={ppMessages}
          ppMessagesLoading={ppMessagesLoading}
          onTestConnection={testProPresenterConnection}
          onLoadMessages={loadProPresenterMessages}
          onClose={() => setShowConfig(false)}
        />
      )}

      <main className="main dashboard">
        <div className="dashboard-top">
          <section className="panel live-panel">
            <div className="panel-head">
              <span className="panel-hint">Transcription live</span>
              <div className="panel-head-actions">
                <button
                  type="button"
                  className="panel-link-btn"
                  onClick={clearTranscript}
                  disabled={!fullTranscript.trim() && !liveTranscript.trim()}
                  title="Effacer la transcription"
                >
                  Effacer
                </button>
                <button
                  className={`voice-btn ${isListening ? "is-listening" : ""}`}
                  onClick={toggleVoiceRecognition}
                  title="Dicter par la voix"
                  disabled={!speechSupported}
                >
                  {isListening ? "Stop 🎤" : "Dicter 🎤"}
                </button>
              </div>
            </div>

            <div className="audio-controls">
              <div className="audio-source-row">
                <span className="audio-controls-label">Source audio</span>
                <label className="audio-source-option">
                  <input
                    type="radio"
                    name="audio-source"
                    value="mic"
                    checked={audioSource === "mic"}
                    disabled={isListening}
                    onChange={() => {
                      setAudioSource("mic");
                      persistAudioPrefs(selectedDeviceId, "mic");
                    }}
                  />
                  Micro
                </label>
                <label
                  className={`audio-source-option ${
                    !canUseSystemAudio() ? "is-disabled" : ""
                  }`}
                  title={
                    !canUseSystemAudio()
                      ? "Non supporté dans Safari — utilise Chrome ou Electron"
                      : ""
                  }
                >
                  <input
                    type="radio"
                    name="audio-source"
                    value="system"
                    checked={audioSource === "system"}
                    disabled={isListening || !canUseSystemAudio()}
                    onChange={() => {
                      setAudioSource("system");
                      persistAudioPrefs(selectedDeviceId, "system");
                    }}
                  />
                  Son système
                </label>
              </div>

              {!window.versepilotDesktop?.isDesktop && (
                <p className="audio-system-hint audio-system-warn">
                  Son système : ouvre la <strong>fenêtre Electron</strong> lancée par{" "}
                  <strong>npm run dev</strong> (pas seulement l’onglet Chrome à
                  localhost:5173).
                </p>
              )}
              {!canUseSystemAudio() && (
                <p className="audio-system-hint audio-system-warn">
                  Safari ne gère pas le son système. Utilise la fenêtre Electron ou
                  Chrome.
                </p>
              )}

              {audioSource === "mic" && (
                <div className="audio-device-row">
                  <label className="audio-controls-label" htmlFor="audio-input-device">
                    Microphone
                  </label>
                  <select
                    id="audio-input-device"
                    className="audio-device-select"
                    value={selectedDeviceId}
                    disabled={isListening || !audioInputDevices.length}
                    onChange={(e) => {
                      setSelectedDeviceId(e.target.value);
                      persistAudioPrefs(e.target.value, audioSource);
                    }}
                  >
                    <option value="">Par défaut (système)</option>
                    {audioInputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Micro ${d.deviceId.slice(0, 8)}…`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {audioSource === "system" && canUseSystemAudio() && (
                <p className="audio-system-hint">
                  Clique <strong>Dicter</strong> → dialogue macOS : <strong>Écran entier</strong>{" "}
                  + <strong>« Partager l’audio du Mac »</strong>. Lance une vidéo ou Zoom pour
                  tester : la barre verte doit bouger. Plan B : <strong>Micro</strong> + BlackHole.
                </p>
              )}

              <div className="mic-level-block">
                <div className="mic-level-header">
                  <span className="audio-controls-label">Niveau audio</span>
                  <span
                    className={
                      micLevelPct >= MIC_LEVEL_MIN_SPEECH
                        ? "mic-level-status ok"
                        : "mic-level-status"
                    }
                  >
                    {isListening
                      ? micLevelPct >= MIC_LEVEL_MIN_SPEECH
                        ? "Signal OK"
                        : "Parle plus fort"
                      : "En attente"}
                  </span>
                </div>
                <div className="mic-level-track" aria-hidden="true">
                  <div
                    className={`mic-level-fill ${
                      micLevelPct >= MIC_LEVEL_MIN_SPEECH ? "is-hot" : ""
                    }`}
                    style={{ width: `${micLevelPct}%` }}
                  />
                  <div
                    className="mic-level-threshold"
                    style={{ left: `${MIC_LEVEL_MIN_SPEECH}%` }}
                  />
                </div>
              </div>

              <div className="stt-settings">
                <label
                  className={`stt-stream-toggle ${
                    !streamingAvailable ? "is-disabled" : ""
                  }`}
                  title={
                    streamingAvailable
                      ? "Transcription en continu (Deepgram), plus rapide et précise"
                      : "Nécessite une clé Deepgram (DEEPGRAM_API_KEY)"
                  }
                >
                  <input
                    type="checkbox"
                    checked={Boolean(config.streaming) && streamingAvailable}
                    disabled={!streamingAvailable || isListening}
                    onChange={(e) =>
                      setConfig({ ...config, streaming: e.target.checked })
                    }
                  />
                  Temps réel (streaming)
                  {config.streaming && streamingAvailable && (
                    <span className="stt-stream-badge">LIVE</span>
                  )}
                </label>

                {sttConfidence != null && isListening && (
                  <span
                    className={`stt-confidence ${
                      sttConfidence >= 0.8
                        ? "high"
                        : sttConfidence >= 0.6
                        ? "mid"
                        : "low"
                    }`}
                    title="Confiance de la transcription"
                  >
                    {Math.round(sttConfidence * 100)}%
                  </span>
                )}

                <div className="stt-gain-row">
                  <span className="audio-controls-label">Gain</span>
                  <input
                    type="range"
                    min="50"
                    max="250"
                    step="10"
                    value={config.inputGain}
                    onChange={(e) =>
                      setConfig({ ...config, inputGain: Number(e.target.value) })
                    }
                  />
                  <span className="stt-gain-val">{config.inputGain}%</span>
                </div>

                <div className="stt-dsp-row">
                  <label title="Réduction de bruit du navigateur — à désactiver sur un feed propre de console">
                    <input
                      type="checkbox"
                      checked={Boolean(config.noiseSuppression)}
                      disabled={isListening}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          noiseSuppression: e.target.checked,
                        })
                      }
                    />
                    Anti-bruit
                  </label>
                  <label title="Annulation d'écho — utile au micro laptop, à couper sur feed direct">
                    <input
                      type="checkbox"
                      checked={Boolean(config.echoCancellation)}
                      disabled={isListening}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          echoCancellation: e.target.checked,
                        })
                      }
                    />
                    Anti-écho
                  </label>
                  <label title="Gain automatique du navigateur">
                    <input
                      type="checkbox"
                      checked={Boolean(config.autoGainControl)}
                      disabled={isListening}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          autoGainControl: e.target.checked,
                        })
                      }
                    />
                    Gain auto
                  </label>
                </div>
              </div>
            </div>

            <div className="live-transcript-box">
              {transcriptDisplay ? (
                <p
                  className={
                    showInterimStatus
                      ? "live-transcript-text live-transcript-interim"
                      : "live-transcript-text"
                  }
                >
                  {fullTranscript.trim() ? (
                    <>
                      {transcriptParts.before && (
                        <span className="live-transcript-past">
                          {transcriptParts.before}{" "}
                        </span>
                      )}
                      <span className="live-transcript-last">
                        {transcriptParts.last || fullTranscript}
                      </span>
                      {streamInterim && (
                        <span className="live-transcript-pending">
                          {" "}
                          {streamInterim}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="live-transcript-last">
                      {streamInterim || liveTranscript}
                    </span>
                  )}
                </p>
              ) : (
                <p className="live-transcript-placeholder">
                  Clique sur Dicter pour transcrire la prédication en direct.
                </p>
              )}
            </div>
            <div className="voice-hint-row">
              {speechSupported ? (
                <>
                  {isListening
                    ? config.streaming && streamingAvailable
                      ? "Écoute active · temps réel (Deepgram)"
                      : isTranscribing
                        ? `Écoute · ${pendingTranscriptions} transcription(s) en file`
                        : `Écoute active · STT ${sttMode}`
                    : isTranscribing
                      ? `Finalisation (${pendingTranscriptions})...`
                      : `Dictée prête · STT ${sttMode}`}{" "}
                {bibleVersionName ? `· ${bibleVersionName}` : ""}{" "}
                  {sttEngine ? `· moteur ${sttEngine}` : ""}
                  {liveSearching ? " · détection..." : ""} ·
                  <label className="voice-toggle">
                    <input
                      type="checkbox"
                      checked={autoVoiceSearch}
                      onChange={(e) => setAutoVoiceSearch(e.target.checked)}
                    />
                    Détection auto (dernière phrase)
                  </label>
                </>
              ) : (
                "Dictée non supportée sur cet environnement."
              )}
            </div>
            {lastPhrase && isListening && (
              <p className="last-phrase-hint">
                Dernière phrase analysée :{" "}
                <em>&ldquo;{lastPhrase}&rdquo;</em>
              </p>
            )}
          </section>

          <section className="panel queue-panel">
            <div className="panel-head">
              <span className="panel-hint">File d&apos;attente</span>
              {queue.length > 0 && (
                <button
                  className="panel-link-btn"
                  onClick={() => setQueue([])}
                  type="button"
                >
                  Tout effacer
                </button>
              )}
            </div>
            <div className="queue-list">
              {queue.length === 0 ? (
                <p className="panel-empty">
                  Versets en attente d&apos;affichage ProPresenter.
                </p>
              ) : (
                queue.map((verse) => (
                  <div key={verse.reference} className="queue-item">
                    <div className="queue-item-main">
                      <strong>{verse.reference}</strong>
                      <span className="queue-snippet">
                        {verse.text.slice(0, 72)}
                        {verse.text.length > 72 ? "…" : ""}
                      </span>
                    </div>
                    <div className="queue-item-actions">
                      <button
                        className="icon-action"
                        title="Afficher"
                        onClick={() => requestSend(verse)}
                        disabled={sending === verse.reference}
                      >
                        ▶
                      </button>
                      <button
                        className="icon-action danger"
                        title="Retirer"
                        onClick={() => removeFromQueue(verse.reference)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="search-block">
          <label className="search-label" htmlFor="q">
            <span className="search-hint">Recherche manuelle</span>
            <span className="search-sub">
              Référence, citation approximative ou mot-clé
            </span>
          </label>
          {bibleVersionOptions.length > 0 && (
            <div className="bible-version-row">
              <label className="bible-version-label" htmlFor="search-bible-version">
                Version biblique
              </label>
              <select
                id="search-bible-version"
                className="bible-version-select"
                value={bibleVersion}
                disabled={bibleVersionLoading}
                onChange={(e) => applyBibleVersion(e.target.value)}
              >
                {bibleVersionOptions.map((v) => (
                  <option key={v.slug} value={v.slug}>
                    {v.name}
                    {v.verseCount ? ` (${v.verseCount} versets)` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="search-row">
            <textarea
              id="q"
              ref={inputRef}
              className="search-input"
              placeholder='"jean 3 16"   ·   "celui qui croit en moi aura la vie"   ·   "berger"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
            />
            <button
              className="search-btn"
              onClick={handleSearch}
              disabled={loading || !query.trim()}
            >
              {loading ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <>Rechercher <span className="arrow">→</span></>
              )}
            </button>
          </div>
          <div className="hint-row">
            <kbd>↵</kbd> pour lancer · <kbd>⇧</kbd> + <kbd>↵</kbd> nouvelle ligne
          </div>
        </div>

        {error && <div className="error">⚠ {error}</div>}

        <div className="dashboard-bottom">
          <section className="results panel-suggestions">
            {results.length > 0 && (
              <div className="results-header">
                <span className="results-hint">
                  {isListening ? "Dernière détection" : "Suggestions"}
                </span>
                <span className="results-count">
                  {results.length} résultat{results.length > 1 ? "s" : ""}
                </span>
              </div>
            )}

            {results.map((verse, idx) => (
              <article key={`${verse.reference}-${idx}`} className="verse-card compact">
                <div className="verse-meta">
                  <span className="verse-index">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <div className="verse-ref-block">
                    <h2 className="verse-ref">{verse.reference}</h2>
                    <span className="verse-version">{verse.version}</span>
                  </div>
                  {(verse.score != null || verse.tokenHits || verse.source) && (
                    <span
                      className={`confidence-pill ${
                        verse.source === "semantic" ? "is-semantic" : "is-lexical"
                      }`}
                      title={verse.reason || ""}
                    >
                      {verseScoreLabel(verse)}
                    </span>
                  )}
                </div>
                <p className="verse-text">{verse.text}</p>
                {verse.reason && (
                  <p className="verse-reason">
                    <span className="reason-label">Pourquoi&nbsp;:</span>{" "}
                    {verse.reason}
                  </p>
                )}
                <div className="verse-actions row-actions">
                  <button
                    className="send-btn"
                    onClick={() => requestSend(verse)}
                    disabled={sending === verse.reference}
                  >
                    {sending === verse.reference ? "Envoi…" : "Afficher ▶"}
                    {idx < 3 && <kbd className="send-kbd">{idx + 1}</kbd>}
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => addToQueue(verse)}
                    type="button"
                  >
                    + File
                  </button>
                </div>
              </article>
            ))}

            {!loading && !liveSearching && results.length === 0 && !error && (
              <div className="empty">
                <div className="empty-mark">⌖</div>
                <p>
                  {isListening
                    ? "En attente de la prochaine phrase détectée…"
                    : "En attente d'une recherche."}
                </p>
              </div>
            )}
          </section>

          <section className="panel detections-panel">
            <div className="panel-head">
              <span className="panel-hint">Détections récentes</span>
              {detections.length > 0 && (
                <button
                  className="panel-link-btn"
                  onClick={() => {
                    setDetections([]);
                    persistDetectionsList([]);
                  }}
                  type="button"
                >
                  Effacer
                </button>
              )}
            </div>
            <div className="detections-list">
              {detections.length === 0 ? (
                <p className="panel-empty">
                  Références entendues (Jean 3:16), chapitres et citations
                  complètes — conservées en mémoire locale jusqu’à Effacer.
                </p>
              ) : (
                detections.map((d) => (
                  <article key={d.id} className="detection-card">
                    <div className="detection-top">
                      <div>
                        <h3 className="detection-ref">{d.verse.reference}</h3>
                        <span className="detection-meta">
                          {formatDetectionTime(d.detectedAt)} ·{" "}
                          {detectionSourceLabel(d.source)} ·{" "}
                          {verseScoreLabel(d.verse)}
                        </span>
                      </div>
                      <div className="detection-actions">
                        <button
                          className="icon-action"
                          title="Afficher dans ProPresenter"
                          onClick={() => requestSend(d.verse)}
                          disabled={sending === d.verse.reference}
                        >
                          ▶
                        </button>
                        <button
                          className="icon-action"
                          title="Ajouter à la file"
                          onClick={() => addToQueue(d.verse)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <p className="detection-text">{d.verse.text}</p>
                    <p className="detection-phrase">
                      Phrase : &ldquo;{d.phrase}&rdquo;
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>

        <section className="panel history-panel">
          <div className="panel-head">
            <span className="panel-hint">Historique des envois</span>
            {history.length > 0 && (
              <button
                className="panel-link-btn"
                type="button"
                onClick={() => {
                  setHistory([]);
                  persistHistory([]);
                }}
              >
                Effacer
              </button>
            )}
          </div>
          <div className="history-list">
            {history.length === 0 ? (
              <p className="panel-empty">
                Les versets envoyés à ProPresenter pendant le service
                apparaîtront ici.
              </p>
            ) : (
              history.map((h) => (
                <div key={h.id} className="history-item">
                  <div className="history-main">
                    <strong>{h.reference}</strong>
                    <span className="history-snippet">
                      {h.text.slice(0, 64)}
                      {h.text.length > 64 ? "…" : ""}
                    </span>
                  </div>
                  <div className="history-side">
                    <span className="history-time">
                      {formatDetectionTime(h.at)}
                    </span>
                    <button
                      className="icon-action"
                      title="Renvoyer"
                      onClick={() =>
                        requestSend({
                          reference: h.reference,
                          text: h.text,
                          version: h.version,
                        })
                      }
                    >
                      ↻
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {preview && (
        <div className="preview-overlay" onClick={() => setPreview(null)}>
          <div className="preview-panel" onClick={(e) => e.stopPropagation()}>
            <div className="preview-head">
              <div>
                <h3 className="preview-ref">{preview.verse.reference}</h3>
                {preview.verse.version && (
                  <span className="preview-version">
                    {preview.verse.version}
                  </span>
                )}
              </div>
              <button className="icon-btn" onClick={() => setPreview(null)}>
                ✕
              </button>
            </div>

            {preview.pages.length > 1 && (
              <div className="preview-pages-bar">
                <span>
                  Verset long — {preview.pages.length} pages (≤{" "}
                  {config.verseMaxChars} car.)
                </span>
                <div className="preview-pages-nav">
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={preview.pageIndex === 0}
                    onClick={() =>
                      setPreview((p) => ({
                        ...p,
                        pageIndex: Math.max(0, p.pageIndex - 1),
                      }))
                    }
                  >
                    ‹
                  </button>
                  <span className="preview-page-num">
                    {preview.pageIndex + 1}/{preview.pages.length}
                  </span>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={preview.pageIndex >= preview.pages.length - 1}
                    onClick={() =>
                      setPreview((p) => ({
                        ...p,
                        pageIndex: Math.min(
                          p.pages.length - 1,
                          p.pageIndex + 1
                        ),
                      }))
                    }
                  >
                    ›
                  </button>
                </div>
              </div>
            )}

            <div className="preview-screen">
              <p className="preview-text">
                {preview.pages[preview.pageIndex] || preview.verse.text}
              </p>
            </div>

            <div className="preview-actions">
              <button
                className="send-btn"
                onClick={sendPreviewPage}
                disabled={sending === preview.verse.reference}
              >
                {sending === preview.verse.reference
                  ? "Envoi…"
                  : preview.pages.length > 1
                  ? `Afficher page ${preview.pageIndex + 1} ▶`
                  : "Afficher ▶"}
              </button>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => setPreview(null)}
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <span>VersePilot Live · MVP v1</span>
        <span className="footer-sep">·</span>
        <span>
          ProPresenter cible : <code>{config.ip}:{config.port}</code>
        </span>
        <span className="footer-sep">·</span>
        <span className="footer-kbd">
          <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> afficher · <kbd>Échap</kbd>{" "}
          masquer
        </span>
      </footer>
    </div>
  );
}

function ConfigPanel({
  config,
  setConfig,
  ppStatus,
  ppStatusLoading,
  ppMessages,
  ppMessagesLoading,
  onTestConnection,
  onLoadMessages,
  onClose,
}) {
  return (
    <div className="config-overlay" onClick={onClose}>
      <div className="config-panel" onClick={(e) => e.stopPropagation()}>
        <div className="config-header">
          <h3>Connexion ProPresenter</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <label className="config-toggle field-full">
          <input
            type="checkbox"
            checked={Boolean(config.dualMessages)}
            onChange={(e) =>
              setConfig({ ...config, dualMessages: e.target.checked })
            }
          />
          <span>Deux messages séparés (référence + verset)</span>
        </label>
        <label className="config-toggle field-full">
          <input
            type="checkbox"
            checked={Boolean(config.previewBeforeSend)}
            onChange={(e) =>
              setConfig({ ...config, previewBeforeSend: e.target.checked })
            }
          />
          <span>Aperçu avant envoi (+ pagination des versets longs)</span>
        </label>
        <div className="config-grid">
          <Field
            label="Adresse IP"
            value={config.ip}
            onChange={(v) => setConfig({ ...config, ip: v })}
            placeholder="127.0.0.1"
            mono
          />
          <Field
            label="Port"
            value={config.port}
            onChange={(v) => setConfig({ ...config, port: v })}
            placeholder="50001"
            mono
          />
          {config.dualMessages ? (
            <>
              <Field
                label="Message référence"
                value={config.refMessageName}
                onChange={(v) => setConfig({ ...config, refMessageName: v })}
                placeholder="Reference"
              />
              <Field
                label="ID message réf. (opt.)"
                value={config.refMessageId}
                onChange={(v) => setConfig({ ...config, refMessageId: v })}
                placeholder="uuid"
                mono
              />
              <Field
                label="Message verset"
                value={config.messageName}
                onChange={(v) => setConfig({ ...config, messageName: v })}
                placeholder="Verset"
              />
              <Field
                label="ID message verset (opt.)"
                value={config.messageId}
                onChange={(v) => setConfig({ ...config, messageId: v })}
                placeholder="uuid"
                mono
              />
            </>
          ) : (
            <>
              <Field
                label="Nom du message"
                value={config.messageName}
                onChange={(v) => setConfig({ ...config, messageName: v })}
                placeholder="Verset"
              />
              <Field
                label="Message ID (optionnel)"
                value={config.messageId}
                onChange={(v) => setConfig({ ...config, messageId: v })}
                placeholder="uuid du message"
                mono
              />
            </>
          )}
          <Field
            label="Token : référence"
            value={config.refTokenName}
            onChange={(v) => setConfig({ ...config, refTokenName: v })}
            placeholder="Reference"
            mono
          />
          <Field
            label="Token : verset"
            value={config.textTokenName}
            onChange={(v) => setConfig({ ...config, textTokenName: v })}
            placeholder="Verset"
            mono
          />
          <Field
            label="Longueur max / page"
            value={config.verseMaxChars}
            onChange={(v) =>
              setConfig({
                ...config,
                verseMaxChars: v.replace(/[^0-9]/g, "") || "",
              })
            }
            placeholder="220"
            mono
          />
        </div>
        <div className="config-actions">
          <button className="send-btn" onClick={onTestConnection}>
            {ppStatusLoading ? "Test..." : "Tester la connexion"}
          </button>
          <button className="send-btn" onClick={onLoadMessages}>
            {ppMessagesLoading ? "Chargement..." : "Charger les messages"}
          </button>
        </div>
        {ppStatus && (
          <p className={`config-debug ${ppStatus.ok ? "ok" : "ko"}`}>
            {ppStatus.ok ? "OK" : "KO"} - {ppStatus.message}
          </p>
        )}
        {ppMessages.length > 0 && (
          <div className="config-debug-list">
            <div className="config-debug-title">Messages disponibles</div>
            {ppMessages.map((m) => (
              <div key={m.id} className="message-pick-row">
                <span className="message-pick-name">{m.name || "Sans nom"}</span>
                <code className="message-pick-id">{m.id}</code>
                {config.dualMessages ? (
                  <div className="message-pick-actions">
                    <button
                      type="button"
                      className="message-pick-btn"
                      onClick={() =>
                        setConfig({
                          ...config,
                          refMessageId: m.id,
                          refMessageName: m.name || config.refMessageName,
                        })
                      }
                    >
                      → Réf.
                    </button>
                    <button
                      type="button"
                      className="message-pick-btn"
                      onClick={() =>
                        setConfig({
                          ...config,
                          messageId: m.id,
                          messageName: m.name || config.messageName,
                        })
                      }
                    >
                      → Verset
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="message-pick-btn message-pick-btn-solo"
                    onClick={() =>
                      setConfig({
                        ...config,
                        messageId: m.id,
                        messageName: m.name || config.messageName,
                      })
                    }
                  >
                    Utiliser
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="config-help">
          {config.dualMessages ? (
            <>
              Mode <strong>deux messages</strong> : dans ProPresenter, créez{" "}
              <strong>{config.refMessageName}</strong> (jeton{" "}
              {config.refTokenName}, thème petit) et{" "}
              <strong>{config.messageName}</strong> (jeton{" "}
              {config.textTokenName}, thème grand). Affichez les deux pour
              tester qu&apos;ils restent visibles ensemble.
            </>
          ) : (
            <>
              Message unique <strong>{config.messageName}</strong> avec jetons{" "}
              {config.refTokenName} et {config.textTokenName}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, mono, full }) {
  return (
    <label className={`field ${full ? "field-full" : ""}`}>
      <span className="field-label">{label}</span>
      <input
        className={`field-input ${mono ? "mono" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
