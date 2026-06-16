import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, Preview, Verse } from "../types";
import { verseIdentityKey } from "../utils/verse";

type UseKeyboardShortcutsOptions = {
  results: Verse[];
  pinnedVerse: Verse | null;
  pinActive: boolean;
  preview: Preview | null;
  setPreview: (preview: Preview | null) => void;
  requestSend: (verse: Verse) => void;
  hideProPresenter: () => Promise<void>;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
};

export function useKeyboardShortcuts({
  results,
  pinnedVerse,
  pinActive,
  preview,
  setPreview,
  requestSend,
  hideProPresenter,
  setConfig,
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
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

      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        const idx = Number(e.key) - 1;
        const hotList: Verse[] = [];
        if (pinnedVerse && pinActive) hotList.push(pinnedVerse);
        const pinKey =
          pinnedVerse && pinActive ? verseIdentityKey(pinnedVerse) : null;
        for (const r of results) {
          if (verseIdentityKey(r) !== pinKey) hotList.push(r);
        }
        const verse = hotList[idx];
        if (verse) {
          e.preventDefault();
          requestSend(verse);
        }
        return;
      }

      if (e.key === "l" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setConfig((c) => ({ ...c, liveMode: !c.liveMode }));
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    results,
    pinnedVerse,
    pinActive,
    preview,
    setPreview,
    requestSend,
    hideProPresenter,
    setConfig,
  ]);
}
