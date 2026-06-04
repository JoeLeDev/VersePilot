import { useEffect, useRef, useState } from "react";

const LS_KEY = "versepilot.config.v1";
const LS_BIBLE_KEY = "versepilot.bible.v1";
const LS_AUDIO_KEY = "versepilot.audio.v1";
const LS_DETECTIONS_KEY = "versepilot.detections.v1";
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
};

const API_BASE =
  window.location.protocol === "file:" ? "http://127.0.0.1:4000" : "";
const VAD_RMS_THRESHOLD = 0.006;
const VAD_MIN_AVG_RMS = 0.004;
const VAD_MIN_AVG_RMS_SYSTEM = 0.0015;
const VOICE_CHUNK_MS = 2800;
const VOICE_CHUNK_MS_SYSTEM = 3600;
const VOICE_OVERLAP_MS = 900;
const VOICE_OVERLAP_MS_SYSTEM = 1200;
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
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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

  async function sendToProPresenter(verse) {
    setSending(verse.reference);
    setError("");
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
          text: verse.text,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Envoi impossible.");
      setLastSent({
        ref: verse.reference,
        at: new Date(),
        mode: data.mode || "single",
      });
    } catch (e) {
      setError(`ProPresenter : ${e.message}`);
    } finally {
      setSending(null);
    }
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
      }
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

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

  const transcriptDisplay =
    fullTranscript.trim() ||
    (isListening || isTranscribing ? liveTranscript : "");
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
          {lastSent && (
            <div className="last-sent">
              <span className="status-dot ok" />
              Dernier envoi : <strong>{lastSent.ref}</strong>
            </div>
          )}
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
                    </>
                  ) : (
                    <span className="live-transcript-last">{liveTranscript}</span>
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
                    ? isTranscribing
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
                        onClick={() => sendToProPresenter(verse)}
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
                    onClick={() => sendToProPresenter(verse)}
                    disabled={sending === verse.reference}
                  >
                    {sending === verse.reference ? "Envoi…" : "Afficher ▶"}
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
                          onClick={() => sendToProPresenter(d.verse)}
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
      </main>

      <footer className="footer">
        <span>VersePilot Live · MVP v1</span>
        <span className="footer-sep">·</span>
        <span>
          ProPresenter cible : <code>{config.ip}:{config.port}</code>
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
            full
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
