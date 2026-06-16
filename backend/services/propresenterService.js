import { normalize } from "../utils/text.js";

export function buildProPresenterBaseUrl(ip, port, defaultPort = 50001) {
  return `http://${ip}:${Number(port) || defaultPort}`;
}

export async function readResponseBody(response) {
  const bodyText = await response.text();
  try {
    return { bodyText, bodyJson: JSON.parse(bodyText) };
  } catch {
    return { bodyText, bodyJson: null };
  }
}

export function getMessageId(message) {
  const id = message?.id;
  if (id && typeof id === "object") {
    return id.uuid || (id.index != null ? String(id.index) : null);
  }
  if (id != null && id !== "") return String(id);
  return message?.uuid || null;
}

export function getMessageName(message) {
  const id = message?.id;
  if (id && typeof id === "object" && id.name) {
    return id.name;
  }
  return (
    message?.name ||
    message?.title ||
    message?.message_name ||
    (typeof id === "string" ? id : null) ||
    "Sans nom"
  );
}

export function resolveMessageIdParam(messageId) {
  if (messageId == null || messageId === "") return null;
  if (typeof messageId === "object") {
    return messageId.uuid || messageId.id || null;
  }
  const s = String(messageId).trim();
  if (!s || s === "[object Object]") return null;
  return s;
}

export function normalizeMessagesList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
    ? payload.messages
    : [];

  return list
    .map((m) => ({
      id: getMessageId(m),
      name: getMessageName(m),
      raw: m,
    }))
    .filter((m) => Boolean(m.id));
}

export function summarizeMessage(m) {
  const raw = m.raw || m;
  const template = String(raw.message || "");
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  return {
    id: m.id,
    name: m.name,
    template,
    tokenNames: tokens.map((t) => t.name).filter(Boolean),
    theme: raw.theme?.name || null,
    isActive: Boolean(raw.is_active),
  };
}

export function messageIncludesToken(raw, tokenName) {
  if (!raw || !tokenName) return false;
  const target = normalize(tokenName);
  const template = String(raw.message || "");
  if (template.includes(`{${tokenName}}`)) return true;
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  return tokens.some((t) => normalize(t.name) === target);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchMessages(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/messages`);
  const { bodyText, bodyJson } = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `GET /v1/messages a répondu ${response.status}${
        bodyText ? ` : ${bodyText}` : ""
      }`
    );
  }

  return normalizeMessagesList(bodyJson);
}

export async function resolveMessageByName(baseUrl, messageName, messageIdParam) {
  const presetId = resolveMessageIdParam(messageIdParam);
  if (presetId) {
    return { id: presetId, name: messageName };
  }

  const messages = await fetchMessages(baseUrl);
  const normalizedTarget = normalize(messageName);
  const found = messages.find(
    (m) =>
      normalize(m.name) === normalizedTarget ||
      normalize(m.name).includes(normalizedTarget)
  );

  if (!found) {
    const err = new Error(`Message "${messageName}" introuvable dans ProPresenter.`);
    err.availableMessages = messages.map((m) => ({ id: m.id, name: m.name }));
    throw err;
  }

  return { id: found.id, name: found.name };
}

export async function triggerProPresenterMessage(baseUrl, messageId, tokens) {
  const url = `${baseUrl}/v1/message/${encodeURIComponent(
    String(messageId)
  )}/trigger`;

  const ppResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokens),
  });

  const { bodyText } = await readResponseBody(ppResponse);

  if (!ppResponse.ok) {
    const err = new Error(`ProPresenter a répondu ${ppResponse.status}`);
    err.status = ppResponse.status;
    err.details = bodyText;
    err.url = url;
    throw err;
  }

  return { url, response: bodyText };
}

export async function checkProPresenterHealth(ip, port, defaultPort = 50001) {
  if (!ip) {
    throw new Error("Paramètre 'ip' requis.");
  }
  const baseUrl = buildProPresenterBaseUrl(ip, port, defaultPort);
  const response = await fetch(`${baseUrl}/version`);
  const { bodyText, bodyJson } = await readResponseBody(response);

  if (!response.ok) {
    const err = new Error(`ProPresenter a répondu ${response.status}`);
    err.status = 502;
    err.details = bodyText;
    err.baseUrl = baseUrl;
    throw err;
  }

  return {
    ok: true,
    baseUrl,
    version: bodyJson || bodyText || null,
  };
}

export async function sendVerseToProPresenter(options) {
  const {
    ip,
    port,
    dualMessages = false,
    messageName = "Verset",
    messageId,
    refMessageName = "Reference",
    refMessageId,
    refTokenName = "Reference",
    textTokenName = "Verset",
    reference,
    text,
    dualMessageOrder = "verse-first",
    dualDelayMs = 220,
    defaultPort = 50001,
  } = options;

  if (!ip || !port || !reference || !text) {
    const err = new Error("Champs requis : ip, port, reference, text.");
    err.status = 400;
    throw err;
  }

  const baseUrl = buildProPresenterBaseUrl(ip, port, defaultPort);

  if (dualMessages) {
    const delay = Math.min(800, Math.max(0, Number(dualDelayMs) || 220));
    const order = String(dualMessageOrder).toLowerCase();

    let refMsg;
    let verseMsg;
    let allMessages;
    try {
      allMessages = await fetchMessages(baseUrl);
      refMsg = await resolveMessageByName(baseUrl, refMessageName, refMessageId);
      verseMsg = await resolveMessageByName(baseUrl, messageName, messageId);
    } catch (err) {
      if (err.availableMessages) {
        const e = new Error(err.message);
        e.status = 404;
        e.availableMessages = err.availableMessages;
        throw e;
      }
      throw err;
    }

    const verseRaw =
      allMessages.find((m) => m.id === verseMsg.id)?.raw || null;
    const refRaw = allMessages.find((m) => m.id === refMsg.id)?.raw || null;

    const refTokens = [{ name: refTokenName, text: { text: reference } }];
    const verseTokens = [{ name: textTokenName, text: { text } }];

    if (messageIncludesToken(verseRaw, refTokenName)) {
      verseTokens.push({ name: refTokenName, text: { text: "" } });
    }
    if (messageIncludesToken(refRaw, textTokenName)) {
      refTokens.push({ name: textTokenName, text: { text: "" } });
    }

    const triggerRef = () =>
      triggerProPresenterMessage(baseUrl, refMsg.id, refTokens);
    const triggerVerse = () =>
      triggerProPresenterMessage(baseUrl, verseMsg.id, verseTokens);

    let refTrigger;
    let verseTrigger;
    if (order === "reference-first") {
      refTrigger = await triggerRef();
      if (delay) await sleep(delay);
      verseTrigger = await triggerVerse();
    } else {
      verseTrigger = await triggerVerse();
      if (delay) await sleep(delay);
      refTrigger = await triggerRef();
    }

    const setupHints = [];
    if (messageIncludesToken(verseRaw, refTokenName)) {
      setupHints.push(
        `Le message « ${verseMsg.name} » contient aussi le jeton {${refTokenName}} : retire-le du modèle ProPresenter pour un affichage séparé propre.`
      );
    }

    return {
      ok: true,
      mode: "dual",
      dualMessageOrder: order,
      setupHints: setupHints.length ? setupHints : undefined,
      triggers: [
        {
          role: "reference",
          messageName: refMsg.name,
          messageId: refMsg.id,
          ...refTrigger,
        },
        {
          role: "verse",
          messageName: verseMsg.name,
          messageId: verseMsg.id,
          ...verseTrigger,
        },
      ],
    };
  }

  const verseMsg = await resolveMessageByName(baseUrl, messageName, messageId);
  const single = await triggerProPresenterMessage(baseUrl, verseMsg.id, [
    { name: refTokenName, text: { text: reference } },
    { name: textTokenName, text: { text } },
  ]);

  return {
    ok: true,
    mode: "single",
    url: single.url,
    messageId: verseMsg.id,
    messageName: verseMsg.name,
    response: single.response,
  };
}
