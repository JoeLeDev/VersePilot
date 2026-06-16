export type Verse = {
  reference: string;
  text: string;
  book?: string;
  chapter?: number;
  verse?: number;
  version?: string;
  versionSlug?: string;
  score?: number;
  reason?: string;
  source?: string;
  semanticPercent?: number;
  tokenHits?: number;
  matchedText?: string;
  queuedAt?: number;
};

export type VerseRef = {
  book: string;
  chapter: number;
  verse: number;
};

export type ConfidenceTier = {
  key: "confirmed" | "probable" | "hypothesis";
  label: string;
};

export type SentHistoryEntry = {
  id: string;
  reference: string;
  text: string;
  version: string;
  at: number;
  mode: string;
  serviceName?: string;
};

export type AppConfig = {
  ip: string;
  // port et verseMaxChars transitent en string via les <input>, number par défaut
  port: number | string;
  dualMessages: boolean;
  dualMessageOrder: string;
  messageId: string;
  messageName: string;
  refMessageId: string;
  refMessageName: string;
  refTokenName: string;
  textTokenName: string;
  previewBeforeSend: boolean;
  verseMaxChars: number | string;
  detectionMinPercent: number;
  streaming: boolean;
  demoMode: boolean;
  liveMode: boolean;
  serviceName: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  inputGain: number;
};

export type PpMessage = {
  id: string;
  name?: string;
  tokenNames?: string[];
  theme?: string;
};

export type PpStatus = {
  ok: boolean;
  message: string;
  version?: string | null;
};

export type TranscribeJob = {
  wavBlob: Blob;
  sessionId: number;
  seq: number;
};

export type AudioOverlap = {
  samples: Float32Array;
  sampleRate: number;
};

export type LastSent = {
  ref: string;
  at: Date | number;
  mode: string;
};

export type Preview = {
  verse: Verse;
  pages: string[];
  pageIndex: number;
};

export type DemoDisplay = {
  verse: Verse;
  mode: string;
};

export type Detection = {
  id?: string;
  verse: Verse;
  detectedAt: number;
  source?: string;
  phrase?: string;
  score?: number;
};

export type TranscriptSegment = {
  id?: string;
  text: string;
  at: number;
};

export type BibleVersion = {
  slug: string;
  name: string;
  available?: boolean;
  verseCount?: number;
};

export type ContextVerse = {
  reference: string;
  text: string;
  book?: string;
  chapter?: number;
  verse: number;
  isCenter?: boolean;
};

export type BibleContext = {
  book?: string;
  chapter?: number;
  version?: string;
  versionName?: string;
  verses?: ContextVerse[];
};
