import type { AppConfig } from "../types";

type ProPresenterSettingsProps = {
  config: AppConfig;
  onToggleDemo: () => void;
  onToggleLive: () => void;
  onOpenConfig: () => void;
};

export function ProPresenterSettings({
  config,
  onToggleDemo,
  onToggleLive,
  onOpenConfig,
}: ProPresenterSettingsProps) {
  return (
    <>
      <button
        className={`icon-btn ${config.demoMode ? "is-active" : ""}`}
        onClick={onToggleDemo}
        title="Mode démo (simule ProPresenter sans connexion)"
      >
        Démo
      </button>
      <button
        className={`icon-btn ${config.liveMode ? "is-active" : ""}`}
        onClick={onToggleLive}
        title="Mode Live (interface agrandie) — raccourci ⌘L"
      >
        Live
      </button>
      <button
        className="icon-btn"
        onClick={onOpenConfig}
        aria-label="Configuration ProPresenter"
        title="Configuration ProPresenter"
      >
        ⚙
      </button>
    </>
  );
}
