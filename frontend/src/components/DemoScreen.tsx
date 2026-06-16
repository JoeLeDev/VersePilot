import type { Verse } from "../types";

type DemoScreenProps = {
  verse: Verse;
  mode?: string;
  onClose: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export function DemoScreen({
  verse,
  mode = "demo",
  onClose,
  fullscreen = false,
  onToggleFullscreen,
}: DemoScreenProps) {
  return (
    <div
      className={`demo-screen-overlay ${fullscreen ? "is-fullscreen" : ""}`}
      role="dialog"
      aria-label="Aperçu démo ProPresenter"
      onClick={onClose}
    >
      <div
        className="demo-screen-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="demo-screen-badge">Mode démo — {mode}</div>
        <div className="demo-screen-ref">{verse.reference}</div>
        <div className="demo-screen-text">{verse.text}</div>
        <div className="demo-screen-actions">
          {onToggleFullscreen && (
            <button type="button" className="btn-ghost" onClick={onToggleFullscreen}>
              {fullscreen ? "Réduire" : "Plein écran"}
            </button>
          )}
          <button type="button" className="btn-primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
