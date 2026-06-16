import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type {
  AppConfig,
  DemoDisplay,
  LastSent,
  PpMessage,
  PpStatus,
  SentHistoryEntry,
  Verse,
} from "../types";
import { apiUrl } from "../utils/api";
import { errorMessage } from "../utils/errors";
import { ensureVerseCoords } from "../utils/verse";

type UseProPresenterOptions = {
  config: AppConfig;
  setError: (msg: string) => void;
  setPinnedVerse: (verse: Verse | null) => void;
  setPinActive: (active: boolean) => void;
  setLastSentVerse: (verse: Verse | null) => void;
  recordHistory: (entry: SentHistoryEntry) => void;
  loadBibleContext: (verse: Verse, slug?: string) => Promise<void>;
  getVerseVersionSlug: (verse: Verse | null | undefined) => string;
  unpinGraceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  onScreenCleared?: () => void;
};

export function useProPresenter({
  config,
  setError,
  setPinnedVerse,
  setPinActive,
  setLastSentVerse,
  recordHistory,
  loadBibleContext,
  getVerseVersionSlug,
  unpinGraceTimerRef,
  onScreenCleared,
}: UseProPresenterOptions) {
  const [ppConnected, setPpConnected] = useState<boolean | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const [lastSent, setLastSent] = useState<LastSent | null>(null);
  const [demoDisplay, setDemoDisplay] = useState<DemoDisplay | null>(null);
  const [sendToast, setSendToast] = useState<{ ref: string; at: number } | null>(
    null
  );
  const [ppStatus, setPpStatus] = useState<PpStatus | null>(null);
  const [ppStatusLoading, setPpStatusLoading] = useState(false);
  const [ppMessages, setPpMessages] = useState<PpMessage[]>([]);
  const [ppMessagesLoading, setPpMessagesLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      if (!config.ip || !config.port) {
        if (!cancelled) setPpConnected(null);
        return;
      }
      try {
        const params = new URLSearchParams({
          ip: config.ip,
          port: String(config.port),
        });
        const r = await fetch(apiUrl(`/propresenter/health?${params}`));
        const data = await r.json();
        if (!cancelled) setPpConnected(Boolean(r.ok && data.ok));
      } catch {
        if (!cancelled) setPpConnected(false);
      }
    }
    probe();
    const id = setInterval(probe, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.ip, config.port]);

  useEffect(() => {
    if (!sendToast) return undefined;
    const t = setTimeout(() => setSendToast(null), 2800);
    return () => clearTimeout(t);
  }, [sendToast]);

  async function sendToProPresenter(verse: Verse, overrideText?: string) {
    setSending(verse.reference);
    setError("");
    const textToSend = overrideText != null ? overrideText : verse.text;

    if (config.demoMode) {
      const sent = ensureVerseCoords({
        ...verse,
        text: textToSend,
        versionSlug: getVerseVersionSlug(verse),
      });
      setDemoDisplay({ verse: sent, mode: "demo" });
      setLastSent({ ref: verse.reference, at: new Date(), mode: "demo" });
      setLastSentVerse(sent);
      setPinnedVerse(sent);
      setPinActive(true);
      setSendToast({ ref: verse.reference, at: Date.now() });
      recordHistory({
        id: `${verse.reference}-${Date.now()}`,
        reference: verse.reference,
        version: verse.version || "",
        text: textToSend,
        at: Date.now(),
        mode: "demo",
        serviceName: config.serviceName || "",
      });
      setSending(null);
      return;
    }

    try {
      const r = await fetch(apiUrl("/send-to-propresenter"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          port: Number(config.port),
          dualMessages: Boolean(config.dualMessages),
          dualMessageOrder: config.dualMessageOrder || "verse-first",
          messageId: config.messageId || undefined,
          messageName: config.messageName,
          refMessageId: config.refMessageId || undefined,
          refMessageName: config.refMessageName,
          refTokenName: config.refTokenName,
          textTokenName: config.textTokenName,
          reference: verse.reference,
          text: textToSend,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Envoi impossible.");
      setLastSent({
        ref: verse.reference,
        at: new Date(),
        mode: data.mode || "single",
      });
      if (unpinGraceTimerRef.current) {
        clearTimeout(unpinGraceTimerRef.current);
        unpinGraceTimerRef.current = null;
      }
      const sent = ensureVerseCoords({
        ...verse,
        text: textToSend,
        versionSlug: getVerseVersionSlug(verse),
      });
      setLastSentVerse(sent);
      setPinnedVerse(sent);
      setPinActive(true);
      void loadBibleContext(sent, getVerseVersionSlug(sent));
      setPpConnected(true);
      setSendToast({ ref: verse.reference, at: Date.now() });
      recordHistory({
        id: `${verse.reference}-${Date.now()}`,
        reference: verse.reference,
        version: verse.version || "",
        text: textToSend,
        at: Date.now(),
        mode: data.mode || "single",
        serviceName: config.serviceName || "",
      });
    } catch (e) {
      setError(`ProPresenter : ${errorMessage(e)}`);
    } finally {
      setSending(null);
    }
  }

  async function hideProPresenter() {
    setHiding(true);
    setError("");
    try {
      const r = await fetch(apiUrl("/propresenter/clear"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: config.ip,
          port: Number(config.port),
          all: true,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Masquage impossible.");
      setPpConnected(true);
      setLastSent(null);
      setLastSentVerse(null);
      setPinnedVerse(null);
      setPinActive(false);
      if (unpinGraceTimerRef.current) {
        clearTimeout(unpinGraceTimerRef.current);
        unpinGraceTimerRef.current = null;
      }
      onScreenCleared?.();
    } catch (e) {
      setError(`ProPresenter : ${errorMessage(e)}`);
    } finally {
      setHiding(false);
    }
  }

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
      setPpStatus({ ok: false, message: errorMessage(e), version: null });
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
      setError(`ProPresenter : ${errorMessage(e)}`);
      setPpMessages([]);
    } finally {
      setPpMessagesLoading(false);
    }
  }

  return {
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
  };
}
