import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { WebSocketServer, WebSocket } from "ws";

const execFileAsync = promisify(execFile);

export function createSttService({
  normalize,
  escapeRegex,
  applyBiblicalLexicon,
  getBibleBooks,
  licenseConfig,
  isDeepgramAvailable,
  proxyWsUrl,
  openai,
}) {
  const STT_MODE = (process.env.STT_MODE || "local").toLowerCase();
  const MLX_STT_URL = (process.env.MLX_STT_URL || "http://127.0.0.1:8002").replace(
    /\/$/,
    ""
  );
  const MLX_STT_LANG = process.env.MLX_STT_LANG || "fr";
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
  const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
  const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "fr";
  const DEEPGRAM_KEYWORDS_ENABLED =
    (process.env.DEEPGRAM_KEYWORDS_ENABLED || "false").toLowerCase() === "true";
  const DEEPGRAM_BIBLE_KEYTERMS = [
    "Genèse", "Exode", "Lévitique", "Nombres", "Deutéronome", "Josué", "Juges",
    "Ruth", "Samuel", "Rois", "Chroniques", "Esdras", "Néhémie", "Esther",
    "Job", "Psaumes", "Proverbes", "Ecclésiaste", "Cantique", "Ésaïe",
    "Jérémie", "Lamentations", "Ézéchiel", "Daniel", "Osée", "Joël", "Amos",
    "Abdias", "Jonas", "Michée", "Nahum", "Habacuc", "Sophonie", "Aggée",
    "Zacharie", "Malachie", "Matthieu", "Marc", "Luc", "Jean", "Actes",
    "Romains", "Corinthiens", "Galates", "Éphésiens", "Philippiens",
    "Colossiens", "Thessaloniciens", "Timothée", "Tite", "Philémon", "Hébreux",
    "Jacques", "Pierre", "Jude", "Apocalypse", "chapitre", "verset",
  ];
  const STREAMING_AVAILABLE =
    isDeepgramAvailable(DEEPGRAM_API_KEY, licenseConfig) &&
    (STT_MODE === "deepgram" || STT_MODE === "hybrid");
  const OPENAI_TRANSCRIBE_MODEL =
    process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  const WHISPER_MODE = (process.env.WHISPER_MODE || "local").toLowerCase();
  const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
  const WHISPER_MODEL_PATH =
    process.env.WHISPER_MODEL_PATH || path.join(process.cwd(), "backend/models/ggml-base.bin");
  const WHISPER_LANG = process.env.WHISPER_LANG || "fr";
  const WHISPER_BEAM_SIZE = Number(process.env.WHISPER_BEAM_SIZE || 5);
  const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 6);
  const WHISPER_SUPPRESS_NST =
    (process.env.WHISPER_SUPPRESS_NST || "true").toLowerCase() !== "false";
  const WHISPER_CARRY_PROMPT =
    (process.env.WHISPER_CARRY_PROMPT || "true").toLowerCase() !== "false";
  const WHISPER_NO_GPU =
    process.env.WHISPER_NO_GPU !== undefined
      ? process.env.WHISPER_NO_GPU.toLowerCase() !== "false"
      : process.platform === "darwin";
  const WHISPER_USE_VAD =
    process.env.WHISPER_USE_VAD !== undefined
      ? process.env.WHISPER_USE_VAD.toLowerCase() === "true"
      : false;
  const WHISPER_PROMPT_MAX_CHARS = Number(process.env.WHISPER_PROMPT_MAX_CHARS || 600);
  const OPENAI_TRANSCRIBE_USE_PROMPT =
    (process.env.OPENAI_TRANSCRIBE_USE_PROMPT || "false").toLowerCase() === "true";
  const OPENAI_TRANSCRIBE_PROMPT = OPENAI_TRANSCRIBE_USE_PROMPT
    ? (
        process.env.OPENAI_TRANSCRIBE_PROMPT ||
        "Prédication en français. Lecture biblique Louis Segond."
      ).slice(0, 224)
    : "";

  const STT_PROMPT_ECHO_PHRASES = [
    "Prédication en français. Lecture biblique Louis Segond.",
    "Prédication en français. Lecture biblique Louis Segond",
    "Bible française Louis Segond, versets bibliques, référence livre chapitre verset.",
    "Bible française, versets bibliques en français.",
    "Lecture biblique Louis Segond.",
    "Prédication en français.",
  ];
  const STT_HALLUCINATION_PHRASES = [
    "Sous-titrage Société Radio-Canada",
    "Sous-titrage ST' 501",
    "Sous-titrage ST'501",
    "Merci d'avoir regardé",
    "Merci de regarder",
    "Thank you for watching",
    "Thanks for watching",
    "Subtitles by the Amara.org community",
    "Subtitles by Amara.org",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
  ];
  const BOOK_ALIASES = [
    [/\bjan\b/gi, "Jean"],
    [/\bjohan\b/gi, "Jean"],
    [/\bjohn\b/gi, "Jean"],
    [/\bmatieu\b/gi, "Matthieu"],
    [/\bmatheu\b/gi, "Matthieu"],
    [/\bpsaume\b/gi, "Psaumes"],
    [/\bsaume\b/gi, "Psaumes"],
    [/\bpsalm\b/gi, "Psaumes"],
    [/\bproverbe\b/gi, "Proverbes"],
    [/\bromain\b/gi, "Romains"],
    [/\bcore?inthiens?\b/gi, "Corinthiens"],
    [/\bgalatien\b/gi, "Galates"],
    [/\bephesiens?\b/gi, "Éphésiens"],
    [/\bthessaloniciens?\b/gi, "Thessaloniciens"],
    [/\bhebreux?\b/gi, "Hébreux"],
    [/\bapocalipse\b/gi, "Apocalypse"],
  ];

  let mlxPreviousText = "";

  function buildWhisperCppPrompt() {
    if (process.env.WHISPER_PROMPT) {
      return process.env.WHISPER_PROMPT.slice(0, WHISPER_PROMPT_MAX_CHARS);
    }
    const booksHint = getBibleBooks()
      .filter(
        (b) =>
          !/\b(chronicles|corinthians|kings|peter|samuel|thessalonians|timothy|john)\b/i.test(
            b
          )
      )
      .slice(0, 24);
    return [
      "Bible française, versets bibliques en français.",
      ...booksHint,
      "Seigneur, Jésus, Christ, Dieu, Esprit, prière, grâce, foi, lumière, amour.",
    ]
      .join(" ")
      .slice(0, WHISPER_PROMPT_MAX_CHARS);
  }
  let WHISPER_CPP_PROMPT = buildWhisperCppPrompt();

  function onBibleUpdated() {
    WHISPER_CPP_PROMPT = buildWhisperCppPrompt();
  }

  function decodeBase64Audio(audioBase64) {
    if (!audioBase64 || typeof audioBase64 !== "string") return null;
    const b64 = audioBase64.includes(",") ? audioBase64.split(",")[1] : audioBase64;
    return Buffer.from(b64, "base64");
  }

  function isSttKnownHallucination(text) {
    const n = normalize(text);
    if (!n) return false;
    return STT_HALLUCINATION_PHRASES.some((phrase) => n.includes(normalize(phrase)));
  }
  function isSttRepetitiveHallucination(text) {
    if (!text || typeof text !== "string") return false;
    const tokens = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean);
    const n = tokens.length;
    if (n >= 8 && new Set(tokens.slice(-8)).size === 1) return true;
    if (n >= 12 && new Set(tokens).size / n < 0.2) return true;
    return false;
  }
  function stripSttPromptHallucination(text) {
    let out = String(text || "").trim();
    if (!out) return out;
    for (const phrase of STT_PROMPT_ECHO_PHRASES) {
      out = out.replace(new RegExp(escapeRegex(phrase), "gi"), " ");
    }
    if (OPENAI_TRANSCRIBE_PROMPT) {
      out = out.replace(new RegExp(escapeRegex(OPENAI_TRANSCRIBE_PROMPT), "gi"), " ");
    }
    out = out.replace(/\s+/g, " ").trim();
    return out;
  }
  function isSttPromptEcho(text) {
    const n = normalize(text);
    if (!n) return true;
    for (const phrase of STT_PROMPT_ECHO_PHRASES) {
      const p = normalize(phrase);
      if (n === p || (n.includes(p) && n.length <= p.length + 12)) return true;
    }
    return !stripSttPromptHallucination(text);
  }

  function cleanupTranscribedText(text) {
    if (isSttKnownHallucination(text) || isSttRepetitiveHallucination(text) || isSttPromptEcho(text)) return "";
    let out = stripSttPromptHallucination(text);
    for (const [pattern, value] of BOOK_ALIASES) out = out.replace(pattern, value);
    out = applyBiblicalLexicon(out);
    return out.replace(/\s+/g, " ").trim();
  }
  function correctBiblicalSpeech(text) {
    const base = String(text || "").trim();
    if (!base) return base;
    return applyBiblicalLexicon(base).replace(/\s+/g, " ").trim();
  }

  function parseWavToMonoPcm16(wavBuffer, targetRate = 16000) {
    if (!wavBuffer || wavBuffer.length < 44) throw new Error("Fichier WAV invalide ou trop court.");
    if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") throw new Error("Format audio non WAV.");
    let fmtOffset = -1;
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;
    while (offset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
      const chunkSize = wavBuffer.readUInt32LE(offset + 4);
      offset += 8;
      if (chunkId === "fmt ") fmtOffset = offset;
      if (chunkId === "data") {
        dataOffset = offset;
        dataSize = chunkSize;
        break;
      }
      offset += chunkSize + (chunkSize % 2);
    }
    const channels = wavBuffer.readUInt16LE(fmtOffset + 2);
    const sampleRate = wavBuffer.readUInt32LE(fmtOffset + 4);
    const frameCount = Math.floor(dataSize / (channels * 2));
    const mono = Buffer.alloc(frameCount * 2);
    for (let i = 0; i < frameCount; i += 1) {
      const base = dataOffset + i * channels * 2;
      mono[i * 2] = wavBuffer[base];
      mono[i * 2 + 1] = wavBuffer[base + 1];
    }
    if (sampleRate === targetRate) return mono;
    const outFrames = Math.max(1, Math.floor((frameCount * targetRate) / sampleRate));
    const resampled = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i += 1) {
      const srcPos = (i * sampleRate) / targetRate;
      const idx = Math.min(frameCount - 1, Math.floor(srcPos));
      resampled.writeInt16LE(mono.readInt16LE(idx * 2), i * 2);
    }
    return resampled;
  }

  async function probeMlxStt() {
    try {
      const r = await fetch(`${MLX_STT_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      const data = await r.json();
      return { ok: true, modelLoaded: Boolean(data.model_loaded), avgInferenceMs: data.avg_inference_ms ?? null };
    } catch (err) {
      return { ok: false, detail: err.message || "indisponible" };
    }
  }

  async function transcribeWithMlx(wavBuffer) {
    const pcm16 = parseWavToMonoPcm16(wavBuffer, 16000);
    const payload = {
      audio_b64: pcm16.toString("base64"),
      sample_rate: 16000,
      language: MLX_STT_LANG,
      use_biblical_hints: (process.env.MLX_STT_BIBLICAL_HINTS || "false").toLowerCase() === "true",
      previous_text: mlxPreviousText || undefined,
    };
    const r = await fetch(`${MLX_STT_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.detail) || (data && data.error) || `MLX STT HTTP ${r.status}`);
    const text = String(data?.text || "").trim();
    mlxPreviousText = text ? `${mlxPreviousText} ${text}`.trim().slice(-400) : mlxPreviousText;
    return text;
  }

  function buildDeepgramStreamUrl(sampleRate = 16000) {
    const params = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      vad_events: "true",
    });
    if (DEEPGRAM_KEYWORDS_ENABLED) {
      for (const term of DEEPGRAM_BIBLE_KEYTERMS) params.append("keywords", `${term}:2`);
    }
    return `wss://api.deepgram.com/v1/listen?${params}`;
  }

  async function transcribeWithDeepgram(audioBuffer) {
    if (licenseConfig.enabled) {
      const r = await fetch(`${licenseConfig.proxyUrl}/v1/transcribe`, {
        method: "POST",
        headers: { "X-VersePilot-License": licenseConfig.licenseKey, "Content-Type": "audio/wav" },
        body: audioBuffer,
        signal: AbortSignal.timeout(25000),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || `Proxy licence HTTP ${r.status}`);
      return String(data?.transcript || "").trim();
    }
    if (!DEEPGRAM_API_KEY) throw new Error("DEEPGRAM_API_KEY manquant. Configure DEEPGRAM_API_KEY ou VERSEPILOT_LICENSE_KEY + VERSEPILOT_PROXY_URL.");
    const params = new URLSearchParams({ model: DEEPGRAM_MODEL, language: DEEPGRAM_LANGUAGE, punctuate: "true", smart_format: "true", diarize: "false" });
    const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "audio/wav" },
      body: audioBuffer,
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.err_msg || data?.error || data?.message || `Deepgram HTTP ${r.status}`);
    return String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  }

  async function transcribeWithOpenAI(audioBuffer) {
    if (!openai) throw new Error("OPENAI_API_KEY manquant pour la transcription cloud.");
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "versepilot-openai-"));
    const inputPath = path.join(tempRoot, "chunk.wav");
    try {
      await fs.promises.writeFile(inputPath, audioBuffer);
      const req = { file: fs.createReadStream(inputPath), model: OPENAI_TRANSCRIBE_MODEL, language: WHISPER_LANG };
      if (OPENAI_TRANSCRIBE_USE_PROMPT && OPENAI_TRANSCRIBE_PROMPT) req.prompt = OPENAI_TRANSCRIBE_PROMPT;
      const result = await openai.audio.transcriptions.create(req);
      return String(result.text || "").trim();
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }

  function buildWhisperArgs(inputPath, outBase, { useGpu }) {
    const args = ["-m", WHISPER_MODEL_PATH, "-f", inputPath, "-l", WHISPER_LANG, "-t", String(WHISPER_THREADS), "-bs", String(WHISPER_BEAM_SIZE), "--prompt", WHISPER_CPP_PROMPT, "-otxt", "-of", outBase, "-np"];
    if (!useGpu) args.push("-ng", "-nfa");
    if (WHISPER_SUPPRESS_NST) args.push("-sns");
    if (WHISPER_CARRY_PROMPT) args.push("--carry-initial-prompt");
    if (WHISPER_USE_VAD) args.push("--vad");
    return args;
  }

  async function transcribeWithWhisperCpp(audioBuffer) {
    if (!fs.existsSync(WHISPER_MODEL_PATH)) throw new Error(`Modele whisper introuvable: ${WHISPER_MODEL_PATH}.`);
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "versepilot-"));
    const inputPath = path.join(tempRoot, "input.wav");
    const outBase = path.join(tempRoot, "output");
    const outTxt = `${outBase}.txt`;
    try {
      await fs.promises.writeFile(inputPath, audioBuffer);
      const args = buildWhisperArgs(inputPath, outBase, { useGpu: !WHISPER_NO_GPU });
      await execFileAsync(WHISPER_BIN, args, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 });
      return (await fs.promises.readFile(outTxt, "utf-8")).trim();
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }

  async function transcribeAudio(audioBuffer, mode = STT_MODE) {
    if (mode === "deepgram") return { text: await transcribeWithDeepgram(audioBuffer), engine: "deepgram" };
    if (mode === "mlx") return { text: await transcribeWithMlx(audioBuffer), engine: "mlx" };
    if (mode === "openai") return { text: await transcribeWithOpenAI(audioBuffer), engine: "openai" };
    if (mode === "hybrid") {
      if (isDeepgramAvailable(DEEPGRAM_API_KEY, licenseConfig)) {
        try { return { text: await transcribeWithDeepgram(audioBuffer), engine: "deepgram" }; } catch {}
      }
      try { return { text: await transcribeWithMlx(audioBuffer), engine: "mlx" }; } catch {}
      try { return { text: await transcribeWithOpenAI(audioBuffer), engine: "openai" }; } catch {}
    }
    return { text: await transcribeWithWhisperCpp(audioBuffer), engine: "local" };
  }

  async function handleTranscribe(req, forcedMode) {
    const { audioBase64 } = req.body || {};
    const audioBuffer = decodeBase64Audio(audioBase64);
    if (!audioBuffer || audioBuffer.length === 0) {
      const e = new Error("audioBase64 requis.");
      e.status = 400;
      throw e;
    }
    const mode = String(forcedMode || STT_MODE).toLowerCase();
    const { text, engine } = await transcribeAudio(audioBuffer, mode);
    return { ok: true, text: cleanupTranscribedText(text), rawText: text, engine, mode };
  }

  async function warmupMlx() {
    const r = await fetch(`${MLX_STT_URL}/warmup`, { method: "POST", signal: AbortSignal.timeout(120000) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }

  function attachSttStream(server) {
    const wss = new WebSocketServer({ server, path: "/stt/stream" });
    wss.on("connection", (client, req) => {
      if (!isDeepgramAvailable(DEEPGRAM_API_KEY, licenseConfig)) {
        client.send(JSON.stringify({ type: "error", error: "STT cloud indisponible : configure DEEPGRAM_API_KEY ou VERSEPILOT_LICENSE_KEY + VERSEPILOT_PROXY_URL." }));
        client.close();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const sampleRate = Number(url.searchParams.get("sampleRate")) || 16000;
      const upstreamUrl = licenseConfig.enabled ? `${proxyWsUrl(licenseConfig.proxyUrl)}?sampleRate=${sampleRate}` : buildDeepgramStreamUrl(sampleRate);
      const upstreamHeaders = licenseConfig.enabled ? { "X-VersePilot-License": licenseConfig.licenseKey } : { Authorization: `Token ${DEEPGRAM_API_KEY}` };
      const dg = new WebSocket(upstreamUrl, { headers: upstreamHeaders });
      let dgOpen = false;
      const backlog = [];
      let keepAlive = null;
      dg.on("open", () => {
        dgOpen = true;
        for (const b of backlog) dg.send(b);
        backlog.length = 0;
        keepAlive = setInterval(() => {
          if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" }));
        }, 8000);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "ready" }));
      });
      dg.on("message", (raw) => {
        let data = null;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (data.type === "Results") {
          const alt = data.channel?.alternatives?.[0];
          const text = (alt?.transcript || "").trim();
          if (!text) return;
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "transcript", text, isFinal: Boolean(data.is_final), speechFinal: Boolean(data.speech_final), confidence: alt?.confidence ?? null }));
          }
        }
      });
      dg.on("error", (err) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", error: `Deepgram: ${err.message}` }));
      });
      dg.on("close", () => {
        if (keepAlive) clearInterval(keepAlive);
        if (client.readyState === WebSocket.OPEN) client.close();
      });
      client.on("message", (data, isBinary) => {
        if (isBinary) {
          if (dgOpen && dg.readyState === WebSocket.OPEN) dg.send(data);
          else backlog.push(data);
          return;
        }
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "CloseStream" && dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
      });
      client.on("close", () => {
        if (keepAlive) clearInterval(keepAlive);
        dg.close();
      });
      client.on("error", () => {
        if (keepAlive) clearInterval(keepAlive);
        dg.close();
      });
    });
    console.log("🔌 STT streaming WebSocket prêt sur /stt/stream");
  }

  return {
    sttMode: STT_MODE,
    mlxSttUrl: MLX_STT_URL,
    deepgramConfigured: isDeepgramAvailable(DEEPGRAM_API_KEY, licenseConfig),
    streamingAvailable: STREAMING_AVAILABLE,
    deepgramModel: DEEPGRAM_MODEL,
    deepgramLanguage: DEEPGRAM_LANGUAGE,
    deepgramKeywords: DEEPGRAM_KEYWORDS_ENABLED,
    openAITranscribeModel: OPENAI_TRANSCRIBE_MODEL,
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    whisperConfigured:
      WHISPER_MODE === "local" && Boolean(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL_PATH),
    whisperBeamSize: WHISPER_BEAM_SIZE,
    whisperModel: path.basename(WHISPER_MODEL_PATH),
    whisperPromptConfigured: Boolean(WHISPER_CPP_PROMPT),
    openaiTranscribeUsePrompt: OPENAI_TRANSCRIBE_USE_PROMPT,
    openaiTranscribePromptChars: OPENAI_TRANSCRIBE_PROMPT.length,
    whisperVad: WHISPER_USE_VAD,
    whisperNoGpu: WHISPER_NO_GPU,
    sttCloudReady:
      isDeepgramAvailable(DEEPGRAM_API_KEY, licenseConfig) ||
      (Boolean(process.env.OPENAI_API_KEY) && STT_MODE !== "local"),
    probeMlxStt,
    handleTranscribe,
    warmupMlx,
    correctBiblicalSpeech,
    attachSttStream,
    onBibleUpdated,
  };
}
