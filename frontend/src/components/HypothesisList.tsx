import type { BibleVersion, Verse } from "../types";
import { HypothesisCard } from "./HypothesisCard";

type HypothesisListProps = {
  pinnedVerse: Verse | null;
  pinActive: boolean;
  resultsBelow: Verse[];
  loading: boolean;
  liveSearching: boolean;
  error: string;
  isListening: boolean;
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

export function HypothesisList({
  pinnedVerse,
  pinActive,
  resultsBelow,
  loading,
  liveSearching,
  error,
  isListening,
  sendingRef,
  bibleVersionLoading,
  bibleVersionOptions,
  onApplyVersion,
  onDismiss,
  onUnpin,
  onAction,
  getVerseVersionSlug,
}: HypothesisListProps) {
  const resultCount = resultsBelow.length + (pinnedVerse ? 1 : 0);

  return (
    <section className="results panel-suggestions col-hyp">
      <div className="results-header">
        <span className="results-hint">Hypothèses</span>
        <span className="results-count">
          {liveSearching
            ? "détection…"
            : `${resultCount} résultat${resultCount > 1 ? "s" : ""}`}
        </span>
      </div>

      <div className="results-list">
        {pinnedVerse && (
          <HypothesisCard
            verse={pinnedVerse}
            listIndex={0}
            isPinnedSlot
            isLive={pinActive}
            sendingRef={sendingRef}
            bibleVersionLoading={bibleVersionLoading}
            bibleVersionOptions={bibleVersionOptions}
            onApplyVersion={onApplyVersion}
            onDismiss={onDismiss}
            onUnpin={onUnpin}
            onAction={onAction}
            getVerseVersionSlug={getVerseVersionSlug}
          />
        )}
        {resultsBelow.map((verse, idx) => (
          <HypothesisCard
            key={verse.reference}
            verse={verse}
            listIndex={pinnedVerse ? idx + 1 : idx}
            sendingRef={sendingRef}
            bibleVersionLoading={bibleVersionLoading}
            bibleVersionOptions={bibleVersionOptions}
            onApplyVersion={onApplyVersion}
            onDismiss={onDismiss}
            onUnpin={onUnpin}
            onAction={onAction}
            getVerseVersionSlug={getVerseVersionSlug}
          />
        ))}

        {!loading &&
          !liveSearching &&
          !pinnedVerse &&
          resultsBelow.length === 0 &&
          !error && (
            <div className="empty">
              <div className="empty-mark">⌖</div>
              <p>
                {isListening
                  ? "En attente de la prochaine phrase détectée…"
                  : "En attente d'une recherche."}
              </p>
            </div>
          )}
      </div>
    </section>
  );
}
