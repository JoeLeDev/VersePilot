import { Router } from "express";
import { safeError } from "../utils/safeLog.js";

export function createSttRouter(sttService) {
  const router = Router();

  router.post("/transcribe", async (req, res) => {
    try {
      const data = await sttService.handleTranscribe(req);
      return res.json(data);
    } catch (err) {
      return res.status(err.status || 500).json({
        ok: false,
        error: safeError(err) || "Transcription impossible.",
      });
    }
  });

  router.post("/transcribe-offline", async (req, res) => {
    try {
      const data = await sttService.handleTranscribe(req, "local");
      return res.json(data);
    } catch (err) {
      return res.status(err.status || 500).json({
        ok: false,
        error: safeError(err) || "Transcription offline impossible.",
      });
    }
  });

  router.post("/stt/warmup", async (_req, res) => {
    try {
      const { status, data } = await sttService.warmupMlx();
      return res.status(status).json(data);
    } catch (err) {
      return res.status(503).json({
        error: safeError(err) || "Serveur MLX STT indisponible.",
      });
    }
  });

  return router;
}
