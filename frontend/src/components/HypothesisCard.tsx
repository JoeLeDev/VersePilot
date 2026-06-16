import type { BibleVersion, Verse } from "../types";
import {
  confidenceTier,
  verseIdentityKey,
  verseScoreNumber,
  verseTags,
} from "../utils/verse";

export type HypothesisCardProps = {
  verse: Verse;
  listIndex: number;
  isPinnedSlot?: boolean;
  isLive?: boolean;
  sendingRef: string | null;
  bibleVersionLoading: boolean;
  bibleVersionOptions: BibleVersion[];
  onApplyVersion: (verse: Verse, slug: string) => void;
  onDismiss: (verse: Verse) => void;
  onUnpin: () => void;
  onAction: (
    verse: Verse,
    opts: { isPinnedSlot: boolean; isLive: boolean }
  ) => void;
  getVerseVersionSlug: (verse: Verse) => string;
};

export function HypothesisCard({
  verse,
  listIndex,
  isPinnedSlot = false,
  isLive = false,
  sendingRef,
  bibleVersionLoading,
  bibleVersionOptions,
  onApplyVersion,
  onDismiss,
  onUnpin,
  onAction,
  getVerseVersionSlug,
}: HypothesisCardProps) {
  const scoreNum = isLive ? 100 : verseScoreNumber(verse);
  const tier = confidenceTier(scoreNum);
  const verseSlug = getVerseVersionSlug(verse);

  return (
    <article
      key={`${verseIdentityKey(verse)}-${isPinnedSlot ? "pin" : listIndex}`}
      className={`hyp-card ${isPinnedSlot ? "is-pinned" : ""} ${
        isPinnedSlot && !isLive ? "is-pinned-grace" : ""
      } tier-${isLive ? "confirmed" : tier.key}`}
    >
      <div className="hyp-rank">{isPinnedSlot ? "▶" : listIndex + 1}</div>
      <div className="hyp-body">
        <div className="hyp-top">
          <div className="hyp-ref-block">
            <h2 className="hyp-ref">{verse.reference}</h2>
            <select
              className="hyp-version-select"
              value={verseSlug}
              disabled={bibleVersionLoading}
              onChange={(e) => onApplyVersion(verse, e.target.value)}
              title="Version biblique de ce verset"
            >
              {bibleVersionOptions.map((opt) => (
                <option key={opt.slug} value={opt.slug}>
                  {opt.name}
                </option>
              ))}
            </select>
          </div>
          <span className={`hyp-status tier-${isLive ? "confirmed" : tier.key}`}>
            {isLive ? "En direct" : isPinnedSlot ? "Récent" : tier.label}
            <strong>{scoreNum}/100</strong>
          </span>
        </div>
        <div className="hyp-score-track" aria-hidden="true">
          <div className="hyp-score-fill" style={{ width: `${scoreNum}%` }} />
        </div>
        <p className="hyp-text">{verse.text}</p>
        <div className="hyp-footer">
          <div className="hyp-tags">
            {verseTags(verse).map((t) => (
              <span key={t} className="hyp-tag">
                {t}
              </span>
            ))}
          </div>
          <div className="hyp-actions">
            {!isPinnedSlot && (
              <button
                className="hyp-reject"
                title="Rejeter cette hypothèse"
                type="button"
                onClick={() => onDismiss(verse)}
              >
                ✕
              </button>
            )}
            {isPinnedSlot && !isLive && (
              <button
                className="hyp-reject"
                title="Retirer maintenant"
                type="button"
                onClick={onUnpin}
              >
                ✕
              </button>
            )}
            <button
              className={`hyp-send ${isLive ? "is-live" : `tier-${tier.key}`}`}
              onClick={() => onAction(verse, { isPinnedSlot, isLive })}
              disabled={sendingRef === verse.reference}
              title={
                isLive
                  ? "Désépingler (le verset reste visible un moment)"
                  : "Afficher à l'écran"
              }
            >
              {sendingRef === verse.reference
                ? "Envoi…"
                : isLive
                  ? "Live"
                  : "Afficher"}
              <span className="arrow">→</span>
              {listIndex < 5 && <kbd className="send-kbd">{listIndex + 1}</kbd>}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
