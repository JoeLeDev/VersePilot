import type { Verse } from "../types";

type VerseCardProps = {
  verse: Verse;
  index?: number;
  pinned?: boolean;
  sending?: boolean;
  onSend: (verse: Verse) => void;
  onDismiss?: (verse: Verse) => void;
};

export function VerseCard({
  verse,
  index,
  pinned,
  sending,
  onSend,
  onDismiss,
}: VerseCardProps) {
  return (
    <article
      className={`verse-card ${pinned ? "is-pinned" : ""}`}
      data-index={index}
    >
      <header className="verse-card-head">
        <strong>{verse.reference}</strong>
        {verse.version && <span className="verse-version">{verse.version}</span>}
        {index != null && (
          <kbd className="verse-shortcut" title={`Raccourci ${index + 1}`}>
            {index + 1}
          </kbd>
        )}
      </header>
      <p className="verse-card-text">{verse.text}</p>
      {verse.reason && <p className="verse-card-reason">{verse.reason}</p>}
      <div className="verse-card-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={Boolean(sending)}
          onClick={() => onSend(verse)}
        >
          {sending ? "Envoi…" : "Afficher"}
        </button>
        {onDismiss && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onDismiss(verse)}
          >
            Ignorer
          </button>
        )}
      </div>
    </article>
  );
}
