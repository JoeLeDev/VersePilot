import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ConfigPanel } from "./components/ConfigPanel";
import { DemoScreen } from "./components/DemoScreen";
import { HypothesisList } from "./components/HypothesisList";
import { LiveTranscription } from "./components/LiveTranscription";
import { ProPresenterSettings } from "./components/ProPresenterSettings";
import { SearchPanel } from "./components/SearchPanel";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useProPresenter } from "./hooks/useProPresenter";
import {
  countWordOverlap,
  extractLastPhrase,
  isDuplicateTranscriptAddition,
  isSttPromptEchoText,
  isSttRepetitiveHallucination,
} from "./utils/transcript";
import {
  detectionSourceLabel,
  ensureVerseCoords,
  formatDetectionTime,
  splitVerseIntoPages,
  verseIdentityKey,
  verseScoreLabel,
} from "./utils/verse";
import {
  canUseSystemAudio,
  float32ToInt16Bytes,
  formatCaptureError,
  PCM_WORKLET_SRC,
  resampleFloat32,
  STREAM_TARGET_RATE,
} from "./utils/audio";
import type {
  AppConfig,
  BibleContext,
  BibleVersion,
  Detection,
  Preview,
  SentHistoryEntry,
  AudioOverlap,
  TranscribeJob,
  TranscriptSegment,
  Verse,
  VerseRef,
} from "./types";
import { apiUrl, wsUrl } from "./utils/api";
import { errorMessage } from "./utils/errors";
import {
  loadJSON,
  saveJSON,
  LS_AUDIO_KEY,
  LS_BIBLE_KEY,
  LS_DETECTIONS_KEY,
  LS_HISTORY_KEY,
  LS_KEY,
} from "./utils/storage";

const MAX_HISTORY = 60;
const MAX_STORED_DETECTIONS = 50;
const MIC_LEVEL_SCALE = 520;
const MIC_LEVEL_MIN_SPEECH = 8;

const defaultConfig = {
  ip: "127.0.0.1",
  port: 49354,
  dualMessages: false,
  dualMessageOrder: "verse-first",
  messageId: "",
  messageName: "Verset",
  refMessageId: "",
  refMessageName: "Reference",
  refTokenName: "Reference",
  textTokenName: "Verset",
  previewBeforeSend: false,
  verseMaxChars: 220,
  detectionMinPercent: 80,
  streaming: true,
  demoMode: false,
  liveMode: false,
  serviceName: "Culte du dimanche",
  noiseSuppression: true,
  echoCancellation: false,
  autoGainControl: false,
  inputGain: 100,
};

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
const MIN_PHRASE_CHARS = 6;
const LIVE_SEARCH_DEBOUNCE_MS = 120;
const DETECTION_MIN_SCORE = 22;
const MAX_DETECTIONS = 40;
const DETECTIONS_PAGE_SIZE = 10;
const MAX_QUEUE = 20;
const CONTEXT_RADIUS = 3;
const PIN_UNPIN_GRACE_MS = 45000;

export default function App() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Verse[]>([]);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [lastSentVerse, setLastSentVerse] = useState<Verse | null>(null); // verset complet affiché
  const [pinnedVerse, setPinnedVerse] = useState<Verse | null>(null); // verset affiché en tête (même après désépinglage)
  const [pinActive, setPinActive] = useState(false); // true = verset « Live » actif
  const unpinGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bibleContext, setBibleContext] = useState<BibleContext | null>(null);
  const [contextCenter, setContextCenter] = useState<VerseRef | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [history, setHistory] = useState<SentHistoryEntry[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [demoFullscreen, setDemoFullscreen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported] = useState(
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
  const [liveTranscript, setLiveTranscript] = useState("");
  const [fullTranscript, setFullTranscript] = useState("");
  const [transcriptSegments, setTranscriptSegments] = useState<
    TranscriptSegment[]
  >([]);
  const [lastPhrase, setLastPhrase] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [detectionsPage, setDetectionsPage] = useState(0);
  const [queue, setQueue] = useState<Verse[]>([]);
  const [liveSearching, setLiveSearching] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [micLevelPct, setMicLevelPct] = useState(0);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
    []
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [audioSource, setAudioSource] = useState("mic");
  const [autoVoiceSearch, setAutoVoiceSearch] = useState(true);
  const stopMeterRef = useRef<(() => void) | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const [sttMode, setSttMode] = useState("local");
  const [sttEngine, setSttEngine] = useState("");
  const [streamingAvailable, setStreamingAvailable] = useState(false);
  const [streamInterim, setStreamInterim] = useState("");
  const [sttConfidence, setSttConfidence] = useState<number | null>(null);
  const streamWsRef = useRef<WebSocket | null>(null);
  const streamCtxRef = useRef<AudioContext | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const [bibleVersions, setBibleVersions] = useState<BibleVersion[]>([]);
  const [bibleVersion, setBibleVersion] = useState("");
  const [bibleVersionName, setBibleVersionName] = useState("");
  const [bibleVersionLoading, setBibleVersionLoading] = useState(false);
  const [embeddingHint, setEmbeddingHint] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listeningRef = useRef(false);
  const transcriptRef = useRef("");
  const lastPhraseSearchRef = useRef("");
  const liveSearchAbortRef = useRef<AbortController | null>(null);
  const liveSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const previousChunkTailRef = useRef("");
  const searchAbortRef = useRef<AbortController | null>(null);
  const listenSessionRef = useRef(0);
  const transcribeQueueRef = useRef<TranscribeJob[]>([]);
  const transcribeActiveRef = useRef(0);
  const chunkResultsRef = useRef<Map<number, string>>(new Map());
  const nextApplySeqRef = useRef(0);
  const chunkSeqRef = useRef(0);
  const audioOverlapRef = useRef<AudioOverlap | null>(null);
  const bibleContextRef = useRef<{
    book: string | null;
    chapter: number | null;
  }>({ book: null, chapter: null });
  const refScanDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  function persistAudioPrefs(nextDeviceId: string, nextSource: string) {
    saveJSON(LS_AUDIO_KEY, { deviceId: nextDeviceId, source: nextSource });
  }

  function startMicLevelMeter(stream: MediaStream) {
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

  async function acquireListenStream(sourceMode: string, deviceId: string) {
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

    const audio: MediaTrackConstraints = {
      echoCancellation: Boolean(config.echoCancellation),
      noiseSuppression: Boolean(config.noiseSuppression),
      autoGainControl: Boolean(config.autoGainControl),
      channelCount: 1,
    };
    if (deviceId) {
      audio.deviceId = { exact: deviceId };
    }
    return navigator.mediaDevices.getUserMedia({ audio });
  }

  function clearTranscript() {
    transcriptRef.current = "";
    previousChunkTailRef.current = "";
    lastPhraseSearchRef.current = "";
    setFullTranscript("");
    setTranscriptSegments([]);
    setLastPhrase("");
    if (!isListening) setLiveTranscript("");
  }

  // Ajoute une ligne horodatée au journal de transcription (affichage live).
  function pushTranscriptSegment(text: string) {
    const clean = (text || "").trim();
    if (!clean) return;
    setTranscriptSegments((prev) =>
      [
        ...prev,
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text: clean },
      ].slice(-80)
    );
  }

  // Load config from localStorage on mount
  useEffect(() => {
    const savedConfig = loadJSON<Partial<AppConfig> | null>(LS_KEY, null);
    if (savedConfig) setConfig({ ...defaultConfig, ...savedConfig });

    const savedDetections = loadJSON<Detection[]>(LS_DETECTIONS_KEY, []);
    if (Array.isArray(savedDetections) && savedDetections.length) {
      setDetections(savedDetections.slice(0, MAX_DETECTIONS));
    }

    const savedHistory = loadJSON<SentHistoryEntry[]>(LS_HISTORY_KEY, []);
    if (Array.isArray(savedHistory) && savedHistory.length) {
      setHistory(savedHistory.slice(0, MAX_HISTORY));
    }

    const savedAudio = loadJSON<{ deviceId?: string; source?: string } | null>(
      LS_AUDIO_KEY,
      null
    );
    if (savedAudio) {
      const { deviceId, source } = savedAudio;
      if (source === "system" || source === "mic") {
        const resolved =
          source === "system" && !canUseSystemAudio() ? "mic" : source;
        setAudioSource(resolved);
      }
      if (deviceId) setSelectedDeviceId(deviceId);
    }
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
        const available = ((data?.versions || []) as BibleVersion[]).filter(
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
    saveJSON(LS_KEY, config);
  }, [config]);

  function persistHistory(list: SentHistoryEntry[]) {
    saveJSON(LS_HISTORY_KEY, list.slice(0, MAX_HISTORY));
  }

  function recordHistory(entry: SentHistoryEntry) {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY);
      persistHistory(next);
      return next;
    });
  }

  function getVerseVersionSlug(verse: Verse | null | undefined) {
    return verse?.versionSlug || bibleVersion;
  }

  function tagVersesWithSlug(verses: Verse[], slug = bibleVersion): Verse[] {
    return verses.map((v) => ({
      ...v,
      versionSlug: v.versionSlug || slug,
    }));
  }

  async function resolveVerseInVersion(coords: Verse, slug: string) {
    const v = ensureVerseCoords(coords);
    const params = new URLSearchParams({
      version: slug,
      book: v.book ?? "",
      chapter: String(v.chapter),
      verse: String(v.verse),
    });
    const r = await fetch(apiUrl(`/bible/verse?${params.toString()}`));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Verset introuvable.");
    return data;
  }

  async function loadBibleContext(
    verse: Verse | VerseRef,
    slug = bibleVersion,
    radius = CONTEXT_RADIUS
  ) {
    const v = ensureVerseCoords(verse as Verse);
    if (!v.book || !v.chapter || !v.verse || !slug) {
      setBibleContext(null);
      setContextCenter(null);
      return;
    }
    setContextLoading(true);
    try {
      const params = new URLSearchParams({
        version: slug,
        book: v.book,
        chapter: String(v.chapter),
        verse: String(v.verse),
        radius: String(radius),
      });
      const r = await fetch(apiUrl(`/bible/context?${params.toString()}`));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Contexte introuvable.");
      setBibleContext(data);
      setContextCenter({
        book: data.book,
        chapter: data.chapter,
        verse: data.centerVerse,
      });
    } catch {
      /* conserve le contexte affiché si la navigation échoue */
    } finally {
      setContextLoading(false);
    }
  }

  const {
    ppConnected,
    sending,
    hiding,
    lastSent,
    demoDisplay,
    setDemoDisplay,
    sendToast,
    ppStatus,
    ppStatusLoading,
    ppMessages,
    ppMessagesLoading,
    sendToProPresenter,
    hideProPresenter,
    testProPresenterConnection,
    loadProPresenterMessages,
  } = useProPresenter({
    config,
    setError,
    setPinnedVerse,
    setPinActive,
    setLastSentVerse,
    recordHistory,
    loadBibleContext,
    getVerseVersionSlug,
    unpinGraceTimerRef,
    onScreenCleared: () => {
      setBibleContext(null);
      setContextCenter(null);
    },
  });

  async function verseWithVersion(verse: Verse, slug: string): Promise<Verse> {
    const base = ensureVerseCoords(verse);
    if (!base?.book || !slug) return verse;
    try {
      const data = await resolveVerseInVersion(base, slug);
      return {
        ...base,
        text: data.text,
        reference: data.reference,
        version: data.versionName || data.version,
        versionSlug: slug,
      };
    } catch {
      return verse;
    }
  }

  /** Change la version d'un seul verset (indépendant des autres). */
  async function applyVerseVersion(verse: Verse, slug: string) {
    if (!slug || !verse) return;
    const key = verseIdentityKey(verse);
    const updated = await verseWithVersion(verse, slug);
    setResults((prev) =>
      prev.map((v) => (verseIdentityKey(v) === key ? updated : v))
    );
    setDetections((prev) =>
      prev.map((d) =>
        verseIdentityKey(d.verse) === key
          ? { ...d, verse: { ...d.verse, ...updated } }
          : d
      )
    );
    if (pinnedVerse && verseIdentityKey(pinnedVerse) === key) {
      setPinnedVerse(updated);
      setLastSentVerse(updated);
      if (pinActive && lastSent) {
        void sendToProPresenter(updated, updated.text);
      }
      void loadBibleContext(updated, slug);
    }
  }

  /** Change la version globale (header) : recherche + tous les versets visibles. */
  async function applyBibleVersion(
    slug: string,
    versionsList: BibleVersion[] = bibleVersions,
    fallbackName?: string
  ) {
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

      setResults((prev) => {
        void Promise.all(prev.map((v) => verseWithVersion(v, slug))).then(setResults);
        return prev;
      });
      setDetections((prev) => {
        void Promise.all(
          prev.map(async (d) => ({
            ...d,
            verse: await verseWithVersion(d.verse, slug),
          }))
        ).then(setDetections);
        return prev;
      });
      setPinnedVerse((prev) => {
        if (!prev) return prev;
        void verseWithVersion(prev, slug).then((updated) => {
          setPinnedVerse(updated);
          setLastSentVerse(updated);
          if (pinActive && lastSent) {
            void sendToProPresenter(updated, updated.text);
          }
          void loadBibleContext(updated, slug);
        });
        return prev;
      });

      if (data.activeName) setBibleVersionName(data.activeName);
      if (data.active) setBibleVersion(data.active);
      setEmbeddingHint(data.embeddingHint || "");
    } catch (e) {
      setError(`Bible : ${errorMessage(e)}`);
    } finally {
      setBibleVersionLoading(false);
    }
  }

  async function shiftBibleContext(delta: number) {
    if (!contextCenter) return;
    const target = contextCenter.verse + delta;
    if (target < 1) return;
    const slug =
      bibleContext?.version ||
      getVerseVersionSlug(pinnedVerse) ||
      bibleVersion;
    await loadBibleContext({ ...contextCenter, verse: target }, slug, CONTEXT_RADIUS);
  }

  function schedulePinnedRemoval() {
    if (unpinGraceTimerRef.current) {
      clearTimeout(unpinGraceTimerRef.current);
    }
    unpinGraceTimerRef.current = setTimeout(() => {
      setPinnedVerse(null);
      unpinGraceTimerRef.current = null;
    }, PIN_UNPIN_GRACE_MS);
  }

  function handleHypothesisAction(
    verse: Verse,
    { isPinnedSlot = false, isLive = false }: { isPinnedSlot?: boolean; isLive?: boolean }
  ) {
    if (
      isPinnedSlot &&
      isLive &&
      pinnedVerse &&
      verseIdentityKey(verse) === verseIdentityKey(pinnedVerse)
    ) {
      setPinActive(false);
      schedulePinnedRemoval();
      return;
    }
    requestSend(verse);
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

  async function fetchVerseSuggestions(
    q: string,
    signal: AbortSignal,
    { live = false }: { live?: boolean } = {}
  ) {
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

  function persistDetectionsList(list: Detection[]) {
    saveJSON(LS_DETECTIONS_KEY, list.slice(0, MAX_STORED_DETECTIONS));
  }

  function mergeDetectionsList(prev: Detection[], fresh: Detection[]): Detection[] {
    const merged = [...fresh, ...prev];
    const seen = new Set<string>();
    const deduped: Detection[] = [];
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

  function pushDetectionEntries(entries: Detection[]) {
    if (!entries.length) return;
    setDetections((prev) => mergeDetectionsList(prev, entries));
  }

  function pushDetections(phrase: string, suggestions: Verse[], mode: string) {
    const fresh: Detection[] = [];
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
      const isStrongRef = source === "reference" || source === "chapter";
      const minScore = isStrongRef ? 70 : DETECTION_MIN_SCORE;
      if (score < minScore && !isStrongRef) {
        continue;
      }
      // Filtre de pertinence : les matchs sémantiques sous le seuil de
      // compatibilité (cosinus réel) sont écartés pour éviter le bruit live.
      if (
        !isStrongRef &&
        verse.semanticPercent != null &&
        verse.semanticPercent < (config.detectionMinPercent || 0)
      ) {
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

  async function scanTranscriptForReferences(snippet?: string) {
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

      const entries: Detection[] = hits.map((verse: Verse) => ({
        id: `${verse.reference}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        verse,
        phrase: verse.matchedText || text.slice(-80),
        score: verse.score || 95,
        source: verse.source || "reference",
        detectedAt: Date.now(),
      }));
      pushDetectionEntries(entries);
      setResults((prev) => {
        const byRef = new Map<string, Verse>(
          prev.map((v) => [v.reference, v] as [string, Verse])
        );
        for (const h of hits as Verse[]) byRef.set(h.reference, h);
        return [...byRef.values()].slice(0, 8);
      });
    } catch {
      /* réseau */
    }
  }

  function scheduleReferenceScan(snippet?: string) {
    const text = (snippet || "").trim();
    if (text.length < 4) return;
    if (refScanDebounceRef.current) clearTimeout(refScanDebounceRef.current);
    refScanDebounceRef.current = setTimeout(() => {
      refScanDebounceRef.current = null;
      void scanTranscriptForReferences(text);
    }, 180);
  }

  async function handleSearch(forcedQuery?: string) {
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
      setResults(tagVersesWithSlug(suggestions));
      if (!suggestions.length) setError("Aucun verset trouvé.");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        return;
      }
      setError(errorMessage(e));
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
      setLoading(false);
      }
    }
  }

  function scheduleLiveSearch(phrase: string) {
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

  async function searchFromLastPhrase(phrase: string) {
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
        // En live, on n'affiche/garde que les versets pertinents pour éviter
        // que l'écran change en permanence sur des matchs faibles.
        const pertinent = suggestions.filter((v: Verse) => {
          const strongRef = v.source === "reference" || v.source === "chapter";
          if (strongRef) return true;
          if (v.semanticPercent == null) return true;
          return v.semanticPercent >= (config.detectionMinPercent || 0);
        });
        if (pertinent.length) {
          const tagged = tagVersesWithSlug(pertinent);
          setResults(tagged);
          pushDetections(normalized, tagged, mode);
        }
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(errorMessage(e));
    } finally {
      if (liveSearchAbortRef.current === controller) {
        liveSearchAbortRef.current = null;
        setLiveSearching(false);
      }
    }
  }

  function addToQueue(verse: Verse) {
    setQueue((prev) => {
      if (prev.some((v) => v.reference === verse.reference)) return prev;
      return [{ ...verse, queuedAt: Date.now() }, ...prev].slice(0, MAX_QUEUE);
    });
  }

  function removeFromQueue(reference: string) {
    setQueue((prev) => prev.filter((v) => v.reference !== reference));
  }

  function openPreview(verse: Verse) {
    const pages = splitVerseIntoPages(verse.text, Number(config.verseMaxChars));
    setPreview({ verse, pages, pageIndex: 0 });
  }

  // Point d'entrée des boutons "Afficher" : aperçu d'abord si activé.
  function requestSend(verse: Verse) {
    if (config.previewBeforeSend) {
      openPreview(verse);
      return;
    }
    void sendToProPresenter(verse);
  }

  useKeyboardShortcuts({
    results,
    pinnedVerse,
    pinActive,
    preview,
    setPreview,
    requestSend,
    hideProPresenter,
    setConfig,
  });

  function sendPreviewPage() {
    if (!preview) return;
    const text = preview.pages[preview.pageIndex] ?? preview.verse.text;
    void sendToProPresenter(preview.verse, text);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  }

  function runLiveDetectionIfNeeded(transcript: string, addition = "") {
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

  function refreshLiveTranscriptLine(pendingOverride?: number) {
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

  function mergeTranscriptAddition(text: string): boolean {
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
    pushTranscriptSegment(addition);
    refreshLiveTranscriptLine();
    scheduleReferenceScan(addition || text);
    runLiveDetectionIfNeeded(transcriptRef.current, addition);
    return true;
  }

  function applyChunkResult(seq: number, text: string) {
    chunkResultsRef.current.set(seq, text ?? "");
    while (chunkResultsRef.current.has(nextApplySeqRef.current)) {
      const chunkText = chunkResultsRef.current.get(nextApplySeqRef.current);
      chunkResultsRef.current.delete(nextApplySeqRef.current);
      nextApplySeqRef.current += 1;
      if (chunkText) mergeTranscriptAddition(chunkText);
    }
  }

  async function runTranscriptionJob({ wavBlob, sessionId, seq }: TranscribeJob) {
    try {
      const text = await transcribeAudio(wavBlob);
      if (sessionId !== listenSessionRef.current) return;
      applyChunkResult(seq, text || "");
    } catch (e) {
      if (sessionId !== listenSessionRef.current) return;
      if ((e as Error)?.name === "AbortError") return;
      setError(`Dictée : ${errorMessage(e)}`);
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
      if (!job) break;
      transcribeActiveRef.current += 1;
      updateTranscribePendingUi();
      void runTranscriptionJob(job).finally(() => {
        transcribeActiveRef.current -= 1;
        updateTranscribePendingUi();
        drainTranscribeQueue();
      });
    }
  }

  function scheduleTranscription(wavBlob: Blob, sessionId: number) {
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

  function floatTo16BitPCM(float32Array: Float32Array) {
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

  function encodeWav(samplesFloat32: Float32Array, sampleRate: number) {
    const pcm = floatTo16BitPCM(samplesFloat32);
    const wavBuffer = new ArrayBuffer(44 + pcm.length);
    const view = new DataView(wavBuffer);

    const writeString = (offset: number, value: string) => {
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
    stream: MediaStream,
    durationMs = VOICE_CHUNK_MS,
    minAvgRms = VAD_MIN_AVG_RMS,
    overlapPrefix: AudioOverlap | null = null,
    overlapMs = VOICE_OVERLAP_MS
  ) {
    const audioContext = new window.AudioContext();
    const sampleRate = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
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
    await new Promise<void>((resolve) => {
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

  async function blobToBase64(blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function transcribeAudio(wavBlob: Blob) {
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
    let stream: MediaStream | undefined;
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

  function handleStreamInterim(text: string) {
    setStreamInterim(text);
    // Sur l'interim (qui change en continu) : seulement la détection de
    // références directes (locale, instantanée). La recherche sémantique ne
    // se déclenche qu'à la finalisation de phrase pour éviter que les versets
    // proposés changent trop vite.
    setLastPhrase(text);
    scheduleReferenceScan(text);
  }

  function appendStreamingFinal(text: string) {
    const clean = (text || "").trim();
    setStreamInterim("");
    if (!clean) return;
    if (isSttPromptEchoText(clean) || isSttRepetitiveHallucination(clean)) {
      return;
    }
    if (isDuplicateTranscriptAddition(clean, transcriptRef.current)) return;
    transcriptRef.current = `${transcriptRef.current} ${clean}`.trim();
    setFullTranscript(transcriptRef.current);
    pushTranscriptSegment(clean);
    scheduleReferenceScan(clean);
    runLiveDetectionIfNeeded(transcriptRef.current, clean);
  }

  async function startStreamingRecognition() {
    let stream: MediaStream;
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

    let workletNode: AudioWorkletNode | null = null;
    let ws: WebSocket | null = null;
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
      if (unpinGraceTimerRef.current) {
        clearTimeout(unpinGraceTimerRef.current);
      }
    };
  }, []);

  const showInterimStatus =
    !fullTranscript.trim() && Boolean(liveTranscript.trim());

  function dismissResult(verseOrIdx: number | Verse) {
    if (typeof verseOrIdx === "number") {
      setResults((prev) => prev.filter((_, i) => i !== verseOrIdx));
      return;
    }
    const key = verseIdentityKey(verseOrIdx);
    setResults((prev) => prev.filter((r) => verseIdentityKey(r) !== key));
  }

  const detectionsPageCount = Math.max(
    1,
    Math.ceil(detections.length / DETECTIONS_PAGE_SIZE)
  );
  const detectionsPageSafe = Math.min(detectionsPage, detectionsPageCount - 1);
  const pagedDetections = detections.slice(
    detectionsPageSafe * DETECTIONS_PAGE_SIZE,
    detectionsPageSafe * DETECTIONS_PAGE_SIZE + DETECTIONS_PAGE_SIZE
  );

  useEffect(() => {
    const maxPage = Math.max(
      0,
      Math.ceil(detections.length / DETECTIONS_PAGE_SIZE) - 1
    );
    if (detectionsPage > maxPage) setDetectionsPage(maxPage);
  }, [detections.length, detectionsPage]);

  // Verset actuellement « à l'écran » pour l'aperçu ProPresenter.
  const previewVerse =
    pinnedVerse ||
    lastSentVerse ||
    results[0] ||
    (detections[0] && detections[0].verse) ||
    null;

  const pinnedKey = pinnedVerse ? verseIdentityKey(pinnedVerse) : null;
  const resultsBelow = results.filter(
    (r) => verseIdentityKey(r) !== pinnedKey
  );

  function handleUnpinPinned() {
    if (unpinGraceTimerRef.current) {
      clearTimeout(unpinGraceTimerRef.current);
    }
    setPinnedVerse(null);
  }

  return (
    <div className={`app ${config.liveMode ? "live-mode" : ""}`}>
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
          <ProPresenterSettings
            config={config}
            onToggleDemo={() =>
              setConfig((c) => ({ ...c, demoMode: !c.demoMode }))
            }
            onToggleLive={() =>
              setConfig((c) => ({ ...c, liveMode: !c.liveMode }))
            }
            onOpenConfig={() => setShowConfig((v) => !v)}
          />
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

      <main className="main board">
          <aside className="col-left">
          <LiveTranscription
            config={config}
            setConfig={setConfig}
            isListening={isListening}
            speechSupported={speechSupported}
            liveTranscript={liveTranscript}
            fullTranscript={fullTranscript}
            showInterimStatus={showInterimStatus}
            streamInterim={streamInterim}
            transcriptSegments={transcriptSegments}
            streamingAvailable={streamingAvailable}
            sttMode={sttMode}
            sttEngine={sttEngine}
            bibleVersionName={bibleVersionName}
            sttConfidence={sttConfidence}
            isTranscribing={isTranscribing}
            pendingTranscriptions={pendingTranscriptions}
            liveSearching={liveSearching}
            autoVoiceSearch={autoVoiceSearch}
            lastPhrase={lastPhrase}
            audioSource={audioSource}
            selectedDeviceId={selectedDeviceId}
            audioInputDevices={audioInputDevices}
            micLevelPct={micLevelPct}
            onToggleLive={toggleVoiceRecognition}
            onClear={clearTranscript}
            onAudioSourceChange={(source) => {
              setAudioSource(source);
              persistAudioPrefs(selectedDeviceId, source);
            }}
            onDeviceChange={(deviceId) => {
              setSelectedDeviceId(deviceId);
              persistAudioPrefs(deviceId, audioSource);
            }}
            onAutoVoiceSearchChange={setAutoVoiceSearch}
          />

          <section className="panel detections-panel">
            <div className="panel-head">
              <span className="panel-hint">
                Détections récentes
                {detections.length > 0 && (
                  <span className="detections-count"> ({detections.length})</span>
                )}
              </span>
              <div className="detections-head-actions">
                <label
                  className="detection-thresh"
                  title="Seuil de pertinence : n'affiche que les versets dont la compatibilité dépasse cette valeur (les références « Jean 3:16 » passent toujours)"
                >
                  Pertinence ≥
                  <input
                    type="range"
                    min="60"
                    max="95"
                    step="1"
                    value={config.detectionMinPercent}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        detectionMinPercent: Number(e.target.value),
                      })
                    }
                  />
                  <span className="detection-thresh-val">
                    {config.detectionMinPercent}%
                  </span>
                </label>
                {detections.length > 0 && (
                  <button
                    className="panel-link-btn"
                    onClick={() => {
                      setDetections([]);
                      setDetectionsPage(0);
                      persistDetectionsList([]);
                    }}
                    type="button"
                  >
                    Effacer
                  </button>
                )}
              </div>
            </div>
            <div className="detections-list">
              {detections.length === 0 ? (
                <p className="panel-empty">
                  Références entendues (Jean 3:16), chapitres et citations
                  complètes — conservées en mémoire locale jusqu’à Effacer.
                </p>
              ) : (
                pagedDetections.map((d) => (
                  <article key={d.id} className="detection-card">
                    <div className="detection-top">
                      <div>
                        <div className="detection-ref-row">
                          <h3 className="detection-ref">{d.verse.reference}</h3>
                          <select
                            className="hyp-version-select detection-version-select"
                            value={getVerseVersionSlug(d.verse)}
                            disabled={bibleVersionLoading}
                            onChange={(e) =>
                              void applyVerseVersion(d.verse, e.target.value)
                            }
                            title="Version de ce verset"
                          >
                            {bibleVersionOptions.map((opt) => (
                              <option key={opt.slug} value={opt.slug}>
                                {opt.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <span className="detection-meta">
                          {formatDetectionTime(d.detectedAt)} ·{" "}
                          {detectionSourceLabel(d.source)} ·{" "}
                          {verseScoreLabel(d.verse)}
                        </span>
                      </div>
                      <div className="detection-actions">
                        <button
                          className="icon-action send"
                          title="Envoyer à ProPresenter"
                          onClick={() => requestSend(d.verse)}
                          disabled={sending === d.verse.reference}
                        >
                          {sending === d.verse.reference ? "…" : "▶"}
                        </button>
                      </div>
                    </div>
                    <p className="detection-text">{d.verse.text}</p>
                  </article>
                ))
              )}
            </div>
            {detections.length > 0 && (
              <div className="detections-pager">
                <button
                  type="button"
                  className="detections-pager-btn"
                  disabled={detectionsPageSafe <= 0}
                  onClick={() => setDetectionsPage((p) => Math.max(0, p - 1))}
                >
                  ← Préc.
                </button>
                <span className="detections-pager-info">
                  {detectionsPageSafe + 1} / {detectionsPageCount}
                  <span className="detections-pager-range">
                    {" "}
                    · {pagedDetections.length} sur {detections.length}
                  </span>
                </span>
                <button
                  type="button"
                  className="detections-pager-btn"
                  disabled={detectionsPageSafe >= detectionsPageCount - 1}
                  onClick={() =>
                    setDetectionsPage((p) =>
                      Math.min(detectionsPageCount - 1, p + 1)
                    )
                  }
                >
                  Suiv. →
                </button>
              </div>
            )}
          </section>
          </aside>

        <SearchPanel
          query={query}
          loading={loading}
          bibleVersion={bibleVersion}
          bibleVersionLoading={bibleVersionLoading}
          bibleVersionOptions={bibleVersionOptions}
          inputRef={inputRef}
          onQueryChange={setQuery}
          onSearch={handleSearch}
          onKeyDown={onKeyDown}
          onBibleVersionChange={(slug) => void applyBibleVersion(slug)}
        />
        {error && <div className="error">⚠ {error}</div>}

          <HypothesisList
            pinnedVerse={pinnedVerse}
            pinActive={pinActive}
            resultsBelow={resultsBelow}
            loading={loading}
            liveSearching={liveSearching}
            error={error}
            isListening={isListening}
            sendingRef={sending}
            bibleVersionLoading={bibleVersionLoading}
            bibleVersionOptions={bibleVersionOptions}
            onApplyVersion={(verse, slug) => void applyVerseVersion(verse, slug)}
            onDismiss={dismissResult}
            onUnpin={handleUnpinPinned}
            onAction={handleHypothesisAction}
            getVerseVersionSlug={(verse) => getVerseVersionSlug(verse)}
          />
          <aside className="col-right">
          <section className="panel pp-apercu">
            <div className="panel-head">
              <span className="panel-hint">Aperçu (ProPresenter)</span>
              {previewVerse && (
                <button
                  type="button"
                  className="panel-link-btn"
                  onClick={() => openPreview(previewVerse)}
                  title="Aperçu plein écran / pagination"
                >
                  Plein écran ⤢
                </button>
              )}
            </div>
            <div
              className={`pp-preview-screen ${lastSentVerse ? "is-onair" : ""}`}
            >
              {previewVerse ? (
                <>
                  <span className="pp-preview-ref">{previewVerse.reference}</span>
                  <p className="pp-preview-text">{previewVerse.text}</p>
                  {previewVerse.version && (
                    <span className="pp-preview-version">
                      {previewVerse.version}
                    </span>
                  )}
                </>
              ) : (
                <p className="pp-preview-empty">Aucun verset à l&apos;écran</p>
              )}
            </div>
            {lastSent ? (
              <div className="pp-preview-foot">
                <span className="pp-onair-pill">● EN DIRECT</span>
                <span className="pp-onair-ref">{lastSent.ref}</span>
                <button
                  type="button"
                  className="panel-link-btn"
                  onClick={hideProPresenter}
                  disabled={hiding}
                >
                  {hiding ? "…" : "Masquer"}
                </button>
              </div>
            ) : (
              <div className="pp-preview-foot pp-preview-foot-idle">
                <span>Rien à l&apos;écran</span>
              </div>
            )}
          </section>

          <section className="panel bible-context-panel">
            <div className="panel-head">
              <span className="panel-hint">Contexte biblique</span>
              {contextCenter && (
                <div className="context-head-meta">
                  <span className="context-ref-label">
                    {contextCenter.book} {contextCenter.chapter}:{contextCenter.verse}
                  </span>
                  <select
                    className="hyp-version-select context-version-select"
                    value={
                      bibleContext?.version ||
                      getVerseVersionSlug(pinnedVerse) ||
                      bibleVersion
                    }
                    disabled={contextLoading || bibleVersionLoading}
                    onChange={(e) => {
                      const slug = e.target.value;
                      if (pinnedVerse && pinActive) {
                        void applyVerseVersion(pinnedVerse, slug);
                      } else if (contextCenter) {
                        void loadBibleContext(contextCenter, slug);
                      }
                    }}
                    title="Version du contexte affiché"
                  >
                    {bibleVersionOptions.map((opt) => (
                      <option key={opt.slug} value={opt.slug}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {(contextCenter || (bibleContext?.verses?.length ?? 0) > 0) && (
              <div className="context-nav">
                <button
                  type="button"
                  className="context-nav-btn"
                  onClick={() => void shiftBibleContext(-3)}
                  disabled={contextLoading}
                  title="Reculer de 3 versets dans le chapitre"
                >
                  − 3 versets
                </button>
                <span className="context-nav-ref">
                  {contextCenter
                    ? `${contextCenter.book} ${contextCenter.chapter}:${contextCenter.verse}`
                    : "Navigation"}
                </span>
                <button
                  type="button"
                  className="context-nav-btn"
                  onClick={() => void shiftBibleContext(3)}
                  disabled={contextLoading}
                  title="Avancer de 3 versets dans le chapitre"
                >
                  + 3 versets
                </button>
              </div>
            )}

            <div className="context-verses">
              {contextLoading ? (
                <p className="panel-empty">Chargement du contexte…</p>
              ) : bibleContext?.verses?.length ? (
                bibleContext.verses.map((v) => (
                  <button
                    key={`${v.chapter}:${v.verse}`}
                    type="button"
                    className={`context-verse-row ${
                      v.isCenter ? "is-center" : ""
                    }`}
                    onClick={() =>
                      requestSend(
                        ensureVerseCoords({
                          reference: v.reference,
                          text: v.text,
                          book: v.book || bibleContext.book,
                          chapter: v.chapter || bibleContext.chapter,
                          verse: v.verse,
                          version: bibleContext.versionName,
                        })
                      )
                    }
                    title="Afficher ce verset"
                  >
                    <span className="context-verse-num">{v.verse}</span>
                    <span className="context-verse-text">{v.text}</span>
                    {v.isCenter && <span className="context-live-mark">▶</span>}
                  </button>
                ))
              ) : (
                <p className="panel-empty">
                  Affiche un verset pour voir le chapitre autour (±{CONTEXT_RADIUS}{" "}
                  versets).
                </p>
              )}
            </div>
          </section>

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
                    {h.serviceName && (
                      <span className="history-service">{h.serviceName}</span>
                    )}
                    <span className="history-snippet">
                      {h.text.slice(0, 64)}
                      {h.text.length > 64 ? "…" : ""}
                    </span>
                  </div>
                  <div className="history-side">
                    <span className="history-check" title="Envoyé">✓</span>
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
          </aside>
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
                      setPreview((p) =>
                        p ? { ...p, pageIndex: Math.max(0, p.pageIndex - 1) } : p
                      )
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
                      setPreview((p) =>
                        p
                          ? {
                              ...p,
                              pageIndex: Math.min(p.pages.length - 1, p.pageIndex + 1),
                            }
                          : p
                      )
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

      <footer className="footer shortcut-bar">
        <span className="shortcut-title">Raccourcis</span>
        <span className="shortcut"><kbd>1</kbd>–<kbd>5</kbd> Afficher</span>
        <span className="shortcut"><kbd>Échap</kbd> Masquer</span>
        <span className="shortcut"><kbd>↵</kbd> Rechercher</span>
        <span className="shortcut-spacer" />
        <span className="shortcut-target">
          ProPresenter <code>{config.ip}:{config.port}</code>
        </span>
      </footer>

      {sendToast && (
        <div className="send-toast" role="status">
          ✓ <strong>{sendToast.ref}</strong> affiché
          {config.demoMode ? " (démo)" : ""}
        </div>
      )}

      {demoDisplay && (
        <DemoScreen
          verse={demoDisplay.verse}
          mode={demoDisplay.mode}
          fullscreen={demoFullscreen}
          onToggleFullscreen={() => setDemoFullscreen((v) => !v)}
          onClose={() => {
            setDemoDisplay(null);
            setDemoFullscreen(false);
          }}
        />
      )}
    </div>
  );
}

