import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, PpMessage, PpStatus } from "../types";

type FieldProps = {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  full?: boolean;
};

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  full,
}: FieldProps) {
  return (
    <label className={`field ${full ? "field-full" : ""}`}>
      <span className="field-label">{label}</span>
      <input
        className={`field-input ${mono ? "mono" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

type ConfigPanelProps = {
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  ppStatus: PpStatus | null;
  ppStatusLoading: boolean;
  ppMessages: PpMessage[];
  ppMessagesLoading: boolean;
  onTestConnection: () => void;
  onLoadMessages: () => void;
  onClose: () => void;
};

export function ConfigPanel({
  config,
  setConfig,
  ppStatus,
  ppStatusLoading,
  ppMessages,
  ppMessagesLoading,
  onTestConnection,
  onLoadMessages,
  onClose,
}: ConfigPanelProps) {
  return (
    <div className="config-overlay" onClick={onClose}>
      <div className="config-panel" onClick={(e) => e.stopPropagation()}>
        <div className="config-header">
          <h3>Connexion ProPresenter</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <label className="config-toggle field-full">
          <input
            type="checkbox"
            checked={Boolean(config.dualMessages)}
            onChange={(e) =>
              setConfig({ ...config, dualMessages: e.target.checked })
            }
          />
          <span>Deux messages séparés (référence + verset)</span>
        </label>
        <label className="config-toggle field-full">
          <input
            type="checkbox"
            checked={Boolean(config.demoMode)}
            onChange={(e) =>
              setConfig({ ...config, demoMode: e.target.checked })
            }
          />
          <span>Mode démo (simule ProPresenter — portfolio / essai sans PP)</span>
        </label>
        <Field
          label="Nom du service / culte (historique)"
          value={config.serviceName || ""}
          onChange={(v) => setConfig({ ...config, serviceName: v })}
          placeholder="Culte du dimanche"
          full
        />
        <label className="config-toggle field-full">
          <input
            type="checkbox"
            checked={Boolean(config.previewBeforeSend)}
            onChange={(e) =>
              setConfig({ ...config, previewBeforeSend: e.target.checked })
            }
          />
          <span>Aperçu avant envoi (+ pagination des versets longs)</span>
        </label>
        <div className="config-grid">
          <Field
            label="Adresse IP"
            value={config.ip}
            onChange={(v) => setConfig({ ...config, ip: v })}
            placeholder="127.0.0.1"
            mono
          />
          <Field
            label="Port"
            value={config.port}
            onChange={(v) => setConfig({ ...config, port: v })}
            placeholder="50001"
            mono
          />
          {config.dualMessages ? (
            <>
              <Field
                label="Message référence"
                value={config.refMessageName}
                onChange={(v) => setConfig({ ...config, refMessageName: v })}
                placeholder="Reference"
              />
              <Field
                label="ID message réf. (opt.)"
                value={config.refMessageId}
                onChange={(v) => setConfig({ ...config, refMessageId: v })}
                placeholder="uuid"
                mono
              />
              <Field
                label="Message verset"
                value={config.messageName}
                onChange={(v) => setConfig({ ...config, messageName: v })}
                placeholder="Verset"
              />
              <Field
                label="ID message verset (opt.)"
                value={config.messageId}
                onChange={(v) => setConfig({ ...config, messageId: v })}
                placeholder="uuid"
                mono
              />
              <label className="field field-full">
                <span className="field-label">Ordre d&apos;affichage (dual)</span>
                <select
                  className="field-input"
                  value={config.dualMessageOrder || "verse-first"}
                  onChange={(e) =>
                    setConfig({ ...config, dualMessageOrder: e.target.value })
                  }
                >
                  <option value="verse-first">
                    Verset puis référence (réf. par-dessus)
                  </option>
                  <option value="reference-first">
                    Référence puis verset
                  </option>
                </select>
              </label>
            </>
          ) : (
            <>
              <Field
                label="Nom du message"
                value={config.messageName}
                onChange={(v) => setConfig({ ...config, messageName: v })}
                placeholder="Verset"
              />
              <Field
                label="Message ID (optionnel)"
                value={config.messageId}
                onChange={(v) => setConfig({ ...config, messageId: v })}
                placeholder="uuid du message"
                mono
              />
            </>
          )}
          <Field
            label="Token : référence"
            value={config.refTokenName}
            onChange={(v) => setConfig({ ...config, refTokenName: v })}
            placeholder="Reference"
            mono
          />
          <Field
            label="Token : verset"
            value={config.textTokenName}
            onChange={(v) => setConfig({ ...config, textTokenName: v })}
            placeholder="Verset"
            mono
          />
          <Field
            label="Longueur max / page"
            value={config.verseMaxChars}
            onChange={(v) =>
              setConfig({
                ...config,
                verseMaxChars: v.replace(/[^0-9]/g, "") || "",
              })
            }
            placeholder="220"
            mono
          />
        </div>
        <div className="config-actions">
          <button className="send-btn" onClick={onTestConnection}>
            {ppStatusLoading ? "Test..." : "Tester la connexion"}
          </button>
          <button className="send-btn" onClick={onLoadMessages}>
            {ppMessagesLoading ? "Chargement..." : "Charger les messages"}
          </button>
        </div>
        {ppStatus && (
          <p className={`config-debug ${ppStatus.ok ? "ok" : "ko"}`}>
            {ppStatus.ok ? "OK" : "KO"} - {ppStatus.message}
          </p>
        )}
        {ppMessages.length > 0 && (
          <div className="config-debug-list">
            <div className="config-debug-title">Messages disponibles</div>
            {ppMessages.map((m) => (
              <div key={m.id} className="message-pick-row">
                <div className="message-pick-main">
                  <span className="message-pick-name">{m.name || "Sans nom"}</span>
                  {(m.tokenNames?.length ?? 0) > 0 && (
                    <span className="message-pick-tokens">
                      jetons : {m.tokenNames!.join(", ")}
                      {m.theme ? ` · thème ${m.theme}` : ""}
                    </span>
                  )}
                  {config.dualMessages &&
                    m.name === config.messageName &&
                    m.tokenNames?.includes(config.refTokenName) && (
                      <span className="message-pick-warn">
                        Retire le jeton {config.refTokenName} de ce message en
                        mode dual.
                      </span>
                    )}
                </div>
                <code className="message-pick-id">{m.id}</code>
                {config.dualMessages ? (
                  <div className="message-pick-actions">
                    <button
                      type="button"
                      className="message-pick-btn"
                      onClick={() =>
                        setConfig({
                          ...config,
                          refMessageId: m.id,
                          refMessageName: m.name || config.refMessageName,
                        })
                      }
                    >
                      → Réf.
                    </button>
                    <button
                      type="button"
                      className="message-pick-btn"
                      onClick={() =>
                        setConfig({
                          ...config,
                          messageId: m.id,
                          messageName: m.name || config.messageName,
                        })
                      }
                    >
                      → Verset
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="message-pick-btn message-pick-btn-solo"
                    onClick={() =>
                      setConfig({
                        ...config,
                        messageId: m.id,
                        messageName: m.name || config.messageName,
                      })
                    }
                  >
                    Utiliser
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="config-help">
          {config.dualMessages ? (
            <>
              Mode <strong>deux messages</strong> : message{" "}
              <strong>{config.refMessageName}</strong> avec uniquement le jeton{" "}
              {config.refTokenName} (thème petit, ex. Scripture) et message{" "}
              <strong>{config.messageName}</strong> avec <em>uniquement</em> le
              jeton {config.textTokenName} (thème grand). Ne mets pas{" "}
              {config.refTokenName} dans le message verset si tu veux les
              séparer visuellement.
            </>
          ) : (
            <>
              Message unique <strong>{config.messageName}</strong> avec jetons{" "}
              {config.refTokenName} et {config.textTokenName}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
