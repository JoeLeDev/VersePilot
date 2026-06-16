import type { KeyboardEvent, RefObject } from "react";
import type { BibleVersion } from "../types";

type SearchPanelProps = {
  query: string;
  loading: boolean;
  bibleVersion: string;
  bibleVersionLoading: boolean;
  bibleVersionOptions: BibleVersion[];
  inputRef: RefObject<HTMLTextAreaElement>;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBibleVersionChange: (slug: string) => void;
};

export function SearchPanel({
  query,
  loading,
  bibleVersion,
  bibleVersionLoading,
  bibleVersionOptions,
  inputRef,
  onQueryChange,
  onSearch,
  onKeyDown,
  onBibleVersionChange,
}: SearchPanelProps) {
  return (
    <div className="search-block col-search">
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
            onChange={(e) => onBibleVersionChange(e.target.value)}
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
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button
          className="search-btn"
          onClick={() => void onSearch()}
          disabled={loading || !query.trim()}
          type="button"
        >
          {loading ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <>
              Rechercher <span className="arrow">→</span>
            </>
          )}
        </button>
      </div>
      <div className="hint-row">
        <kbd>↵</kbd> pour lancer · <kbd>⇧</kbd> + <kbd>↵</kbd> nouvelle ligne
      </div>
    </div>
  );
}
