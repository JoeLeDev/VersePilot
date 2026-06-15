#!/usr/bin/env python3
"""
Serveur d'embeddings local pour VersePilot Live.

Permet la recherche sémantique de versets SANS dépendre d'OpenAI :
tout tourne en local (hors-ligne), idéal en plein culte.

Modèle par défaut : intfloat/multilingual-e5-small (384 dim, multilingue, FR ok).
Les modèles e5 attendent des préfixes "query: " / "passage: " — gérés ici.

Endpoints :
  GET  /health          -> état + modèle
  POST /warmup          -> charge le modèle
  POST /embed           -> { texts: [...], type: "query"|"passage" } -> { embeddings, dimensions, model }

Usage :
  cd backend && npm run embed-server
"""

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

MODEL_ID = os.getenv("LOCAL_EMBED_MODEL", "intfloat/multilingual-e5-small")
SERVER_HOST = os.getenv("LOCAL_EMBED_HOST", "127.0.0.1")

# Les modèles e5 ont besoin de préfixes ; on les applique selon le type d'entrée.
USE_E5_PREFIX = "e5" in MODEL_ID.lower()


def find_available_port(start_port: int, max_attempts: int = 10) -> int:
    import socket
    for i in range(max_attempts):
        port = start_port + i
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    return start_port


try:
    start_port = int(os.getenv("LOCAL_EMBED_PORT", "8003"))
except ValueError:
    start_port = 8003

SERVER_PORT = find_available_port(start_port)

_model = None
_sentence_transformers = None
_load_error: Optional[str] = None
stats = {
    "model_id": MODEL_ID,
    "model_loaded": False,
    "dimensions": 0,
    "total_batches": 0,
    "total_texts": 0,
    "total_ms": 0,
}


def ensure_library() -> bool:
    global _sentence_transformers, _load_error
    if _sentence_transformers is not None:
        return True
    try:
        from sentence_transformers import SentenceTransformer
        _sentence_transformers = SentenceTransformer
        return True
    except ImportError as exc:
        _load_error = (
            f"sentence-transformers non installé : {exc}. "
            "Installe : pip install -r backend/scripts/embeddings/requirements.txt"
        )
        print(_load_error)
        return False


def load_model_sync():
    global _model, stats, _load_error
    if _model is not None:
        return
    if not ensure_library():
        raise RuntimeError(_load_error or "sentence-transformers indisponible")

    print(f"Chargement du modèle d'embeddings : {MODEL_ID}")
    start = time.perf_counter()
    model = _sentence_transformers(MODEL_ID)
    dim = model.get_sentence_embedding_dimension()
    elapsed = (time.perf_counter() - start) * 1000
    print(f"Modèle chargé en {elapsed:.0f}ms ({dim} dimensions)")
    _model = model
    stats["model_loaded"] = True
    stats["dimensions"] = dim


def _prefix(texts: List[str], kind: str) -> List[str]:
    if not USE_E5_PREFIX:
        return texts
    tag = "query: " if kind == "query" else "passage: "
    return [f"{tag}{t}" for t in texts]


class EmbedRequest(BaseModel):
    texts: List[str]
    type: str = "passage"  # "query" ou "passage"


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]
    dimensions: int
    model: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Serveur d'embeddings local sur {SERVER_HOST}:{SERVER_PORT}")
    print(f"Modèle : {MODEL_ID} (chargé à la première requête, ou via /warmup)")
    yield
    print("Serveur d'embeddings local arrêté")


app = FastAPI(title="VersePilot Local Embedding Server", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "degraded" if _load_error else "healthy",
        "model": MODEL_ID,
        "model_loaded": stats["model_loaded"],
        "dimensions": stats["dimensions"],
        "error": _load_error,
    }


@app.post("/warmup")
async def warmup():
    if stats["model_loaded"]:
        return {"status": "already_loaded", "model": MODEL_ID, "dimensions": stats["dimensions"]}
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, load_model_sync)
        return {"status": "loaded", "model": MODEL_ID, "dimensions": stats["dimensions"]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    if not request.texts:
        return EmbedResponse(embeddings=[], dimensions=stats["dimensions"], model=MODEL_ID)

    if not stats["model_loaded"]:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, load_model_sync)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Chargement du modèle impossible : {exc}")

    start = time.perf_counter()
    try:
        inputs = _prefix(request.texts, request.type)
        loop = asyncio.get_event_loop()
        vectors = await loop.run_in_executor(
            None,
            lambda: _model.encode(
                inputs,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ),
        )
        embeddings = vectors.tolist()
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        stats["total_batches"] += 1
        stats["total_texts"] += len(embeddings)
        stats["total_ms"] += elapsed_ms
        return EmbedResponse(
            embeddings=embeddings,
            dimensions=stats["dimensions"],
            model=MODEL_ID,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/stats")
async def get_stats():
    avg = stats["total_ms"] / stats["total_batches"] if stats["total_batches"] else 0
    return {**stats, "avg_batch_ms": avg, "use_e5_prefix": USE_E5_PREFIX}


if __name__ == "__main__":
    import uvicorn

    print(f"""
    ╔═══════════════════════════════════════════════════════════════╗
    ║  VersePilot — Serveur d'embeddings local                      ║
    ║  Recherche sémantique hors-ligne (sans OpenAI)                ║
    ║                                                               ║
    ║  Modèle : {MODEL_ID:<43} ║
    ║  Serveur: http://{SERVER_HOST}:{SERVER_PORT:<37} ║
    ╚═══════════════════════════════════════════════════════════════╝
    """)
    uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT, log_level="info")
