export {};

declare global {
  interface Window {
    versepilotDesktop?: {
      isDesktop?: boolean;
      [key: string]: unknown;
    };
  }
}
