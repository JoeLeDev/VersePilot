import { Router } from "express";
import {
  sendVerseToProPresenter,
  checkProPresenterHealth,
  fetchMessages,
  summarizeMessage,
  buildProPresenterBaseUrl,
} from "../services/propresenterService.js";
import { safeError } from "../utils/safeLog.js";

export function createProPresenterRouter({ defaultPort = 50001 } = {}) {
  const router = Router();

  router.get("/propresenter/health", async (req, res) => {
    try {
      const ip = String(req.query.ip || "").trim();
      const port = Number(req.query.port) || defaultPort;
      const result = await checkProPresenterHealth(ip, port, defaultPort);
      return res.json(result);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({
        ok: false,
        error: safeError(err),
        details: err.details,
        baseUrl: err.baseUrl,
      });
    }
  });

  router.get("/propresenter/messages", async (req, res) => {
    try {
      const ip = String(req.query.ip || "").trim();
      const port = Number(req.query.port) || defaultPort;
      if (!ip) {
        return res.status(400).json({ error: "Paramètre 'ip' requis." });
      }
      const baseUrl = buildProPresenterBaseUrl(ip, port, defaultPort);
      const messages = await fetchMessages(baseUrl);
      return res.json({
        messages: messages.map(summarizeMessage),
      });
    } catch (err) {
      return res.status(500).json({ error: safeError(err) });
    }
  });

  router.post("/send-to-propresenter", async (req, res) => {
    try {
      const result = await sendVerseToProPresenter({
        ...req.body,
        defaultPort,
      });
      return res.json(result);
    } catch (err) {
      if (err.availableMessages) {
        return res.status(err.status || 404).json({
          error: err.message,
          availableMessages: err.availableMessages,
        });
      }
      if (err.url) {
        return res.status(502).json({
          error: err.message,
          details: err.details,
          url: err.url,
        });
      }
      const status = err.status || 500;
      console.error("send-to-propresenter:", safeError(err));
      return res.status(status).json({ error: safeError(err) });
    }
  });

  return router;
}
