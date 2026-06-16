import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, TranscriptSegment } from "../types";
import { canUseSystemAudio } from "../utils/audio";
import { formatDetectionTime } from "../utils/verse";

const MIC_LEVEL_MIN_SPEECH = 8;

type LiveTranscriptionProps = {
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  isListening: boolean;
  speechSupported: boolean;
  liveTranscript: string;
  fullTranscript: string;
  showInterimStatus: boolean;
  streamInterim: string;
  transcriptSegments: TranscriptSegment[];
  streamingAvailable: boolean;
  sttMode: string;
  sttEngine: string;
  bibleVersionName: string;
  sttConfidence: number | null;
  isTranscribing: boolean;
  pendingTranscriptions: number;
  liveSearching: boolean;
  autoVoiceSearch: boolean;
  lastPhrase: string;
  audioSource: string;
  selectedDeviceId: string;
  audioInputDevices: MediaDeviceInfo[];
  micLevelPct: number;
  onToggleLive: () => void;
  onClear: () => void;
  onAudioSourceChange: (source: "mic" | "system") => void;
  onDeviceChange: (deviceId: string) => void;
  onAutoVoiceSearchChange: (enabled: boolean) => void;
};

export function LiveTranscription({
  config,
  setConfig,
  isListening,
  speechSupported,
  liveTranscript,
  fullTranscript,
  showInterimStatus,
  streamInterim,
  transcriptSegments,
  streamingAvailable,
  sttMode,
  sttEngine,
  bibleVersionName,
  sttConfidence,
  isTranscribing,
  pendingTranscriptions,
  liveSearching,
  autoVoiceSearch,
  lastPhrase,
  audioSource,
  selectedDeviceId,
  audioInputDevices,
  micLevelPct,
  onToggleLive,
  onClear,
  onAudioSourceChange,
  onDeviceChange,
  onAutoVoiceSearchChange,
}: LiveTranscriptionProps) {
  return (
    <section className="panel live-panel">
      <div className="panel-head">
        <span className="panel-hint">Transcription live</span>
        {streamingAvailable && config.streaming && (
          <span className="live-stream-tag">
            <span className="live-stream-dot" /> streaming
          </span>
        )}
      </div>

      <button
        className={`live-start-btn ${isListening ? "is-live" : ""}`}
        onClick={onToggleLive}
        disabled={!speechSupported}
        type="button"
      >
        {isListening ? "■ Arrêter le live" : "▶ Démarrer le live"}
      </button>
      <div className="live-engine-row">
        <span className="live-engine-name">
          {config.streaming && streamingAvailable ? "Deepgram" : `STT ${sttMode}`}
          {bibleVersionName ? ` · ${bibleVersionName}` : ""}
          {sttEngine ? ` · ${sttEngine}` : ""}
        </span>
        <button
          type="button"
          className="panel-link-btn"
          onClick={onClear}
          disabled={!fullTranscript.trim() && !liveTranscript.trim()}
          title="Réinitialiser la transcription"
        >
          Réinitialiser
        </button>
      </div>

      <details className="audio-controls audio-settings">
        <summary>Réglages audio &amp; moteur</summary>
        <div className="audio-source-row">
          <span className="audio-controls-label">Source audio</span>
          <label className="audio-source-option">
            <input
              type="radio"
              name="audio-source"
              value="mic"
              checked={audioSource === "mic"}
              disabled={isListening}
              onChange={() => onAudioSourceChange("mic")}
            />
            Micro
          </label>
          <label
            className={`audio-source-option ${!canUseSystemAudio() ? "is-disabled" : ""}`}
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
              onChange={() => onAudioSourceChange("system")}
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
              onChange={(e) => onDeviceChange(e.target.value)}
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
            Clique <strong>Dicter</strong> → dialogue macOS :{" "}
            <strong>Écran entier</strong> + <strong>« Partager l’audio du Mac »</strong>.
            Lance une vidéo ou Zoom pour tester : la barre verte doit bouger. Plan B :{" "}
            <strong>Micro</strong> + BlackHole.
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
            className={`stt-stream-toggle ${!streamingAvailable ? "is-disabled" : ""}`}
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
                setConfig((c) => ({ ...c, streaming: e.target.checked }))
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
                setConfig((c) => ({ ...c, inputGain: Number(e.target.value) }))
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
                  setConfig((c) => ({ ...c, noiseSuppression: e.target.checked }))
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
                  setConfig((c) => ({ ...c, echoCancellation: e.target.checked }))
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
                  setConfig((c) => ({ ...c, autoGainControl: e.target.checked }))
                }
              />
              Gain auto
            </label>
          </div>
        </div>
      </details>

      <div className="live-transcript-box">
        {transcriptSegments.length === 0 &&
        !streamInterim &&
        !(showInterimStatus && liveTranscript) ? (
          <p className="live-transcript-placeholder">
            Démarre le live pour transcrire la prédication en direct.
          </p>
        ) : (
          <div className="transcript-feed">
            {transcriptSegments.map((seg) => (
              <div key={seg.id} className="transcript-line">
                <span className="transcript-time">
                  {formatDetectionTime(seg.at)}
                </span>
                <span className="transcript-said">{seg.text}</span>
              </div>
            ))}
            {(streamInterim || (showInterimStatus && liveTranscript)) && (
              <div className="transcript-line is-pending">
                <span className="transcript-time">live</span>
                <span className="transcript-said">
                  {streamInterim || liveTranscript}
                </span>
              </div>
            )}
          </div>
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
                onChange={(e) => onAutoVoiceSearchChange(e.target.checked)}
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
          Dernière phrase analysée : <em>&ldquo;{lastPhrase}&rdquo;</em>
        </p>
      )}
    </section>
  );
}
