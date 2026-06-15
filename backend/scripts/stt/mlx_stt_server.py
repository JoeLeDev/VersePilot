#!/usr/bin/env python3
"""
MLX-Whisper STT Server for Pewbeam
FastAPI server for offline speech-to-text using mlx-whisper on Apple Silicon

Optimized for M3 Max: ~50ms inference for 3-5 second utterances
"""

# Load environment variables first
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("Loaded environment variables from .env file")
except ImportError:
    print("python-dotenv not available, using system environment variables")

import asyncio
import base64
import os
import re
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

mlx_whisper = None
MLX_WHISPER_AVAILABLE = None
MLX_WHISPER_ERROR = None


def _run_mlx_preflight() -> tuple[bool, str]:
    """
    Check MLX/Metal in a disposable process before importing mlx_whisper here.

    Some MLX/Metal failures abort the interpreter with an Objective-C exception
    instead of raising a Python exception. Running the probe in a child process
    keeps this FastAPI server alive so callers get a normal 503 response.
    """
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import mlx.core as mx; print(f'MLX device: {mx.default_device()}')",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False, "MLX/Metal preflight timed out"
    except Exception as exc:
        return False, f"MLX/Metal preflight failed to run: {exc}"

    if result.returncode == 0:
        output = (result.stdout or "").strip()
        print(f"MLX/Metal preflight passed: {output}")
        return True, output

    def summarize(value: str) -> str:
        lines = [line.strip() for line in value.splitlines() if line.strip()]
        summary = " | ".join(lines[:4])
        return summary[:800] + "..." if len(summary) > 800 else summary

    stderr = summarize(result.stderr or "")
    stdout = summarize(result.stdout or "")
    return (
        False,
        f"MLX/Metal preflight exited with {result.returncode}. stdout={stdout} stderr={stderr}",
    )


def ensure_mlx_whisper_available() -> bool:
    global mlx_whisper, MLX_WHISPER_AVAILABLE, MLX_WHISPER_ERROR

    if MLX_WHISPER_AVAILABLE is True:
        return True
    if MLX_WHISPER_AVAILABLE is False:
        return False

    ok, detail = _run_mlx_preflight()
    if not ok:
        MLX_WHISPER_AVAILABLE = False
        MLX_WHISPER_ERROR = detail
        print(f"mlx-whisper unavailable: {detail}")
        return False

    try:
        import mlx_whisper as imported_mlx_whisper
    except ImportError as exc:
        MLX_WHISPER_AVAILABLE = False
        MLX_WHISPER_ERROR = f"mlx-whisper not installed: {exc}"
        print("mlx-whisper NOT available - install with: pip install mlx-whisper")
        return False

    mlx_whisper = imported_mlx_whisper
    MLX_WHISPER_AVAILABLE = True
    MLX_WHISPER_ERROR = None
    print("mlx-whisper available")
    return True

# Configuration
# Pewbeam : whisper-large-v3-turbo via MLX (pas ggml-small whisper.cpp)
MODEL_ID = os.getenv("MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
SERVER_HOST = os.getenv("MLX_STT_HOST", "127.0.0.1")

def find_available_port(start_port: int, max_attempts: int = 10) -> int:
    """Find an available port starting from start_port."""
    import socket
    for i in range(max_attempts):
        port = start_port + i
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', port))
                return port
        except OSError:
            if i == 0:
                print(f"⚠️ Port {start_port} is in use, looking for available port...")
            continue
    # Fallback: return 0 to let uvicorn find a port
    print(f"⚠️ Could not find available port in range {start_port}-{start_port + max_attempts - 1}")
    return 0

try:
    start_port = int(os.getenv("MLX_STT_PORT", "8002"))
except ValueError:
    start_port = 8002

SERVER_PORT = find_available_port(start_port)
if SERVER_PORT != start_port:
    print(f"✅ Using port {SERVER_PORT} (configured port {start_port} was in use)")
    # Write port to stdout so parent process can discover it
    print(f"PEWBEAM_MLX_PORT={SERVER_PORT}", flush=True)


def resolve_model_path() -> str:
    """
    Resolve the MLX-Whisper model path.

    Priority:
    1. Bundled model in resources/mlx-whisper-model/ (for packaged app)
    2. Environment variable MLX_MODEL_PATH (explicit override)
    3. HuggingFace model ID (will download on first use)
    """
    script_dir = Path(__file__).resolve().parent

    # Check for bundled model (development: relative to scripts/)
    bundled_dev = script_dir.parent / "resources" / "mlx-whisper-model"
    if bundled_dev.exists() and _is_valid_model_dir(bundled_dev):
        print(f"Using bundled model (dev): {bundled_dev}")
        return str(bundled_dev)

    # Check for PEWBEAM_BUNDLED env var (packaged app)
    if os.getenv("PEWBEAM_BUNDLED") == "1":
        # In bundled app, resources are at different relative paths
        # Try multiple possible locations
        possible_paths = [
            script_dir / ".." / ".." / "resources" / "mlx-whisper-model",
            script_dir / ".." / "resources" / "mlx-whisper-model",
            Path(os.getenv("MLX_MODEL_PATH", "")) if os.getenv("MLX_MODEL_PATH") else None,
        ]

        for path in possible_paths:
            if path and path.exists() and _is_valid_model_dir(path):
                resolved = path.resolve()
                print(f"Using bundled model (packaged): {resolved}")
                return str(resolved)

    # Check for explicit MLX_MODEL_PATH env var
    env_path = os.getenv("MLX_MODEL_PATH")
    if env_path:
        path = Path(env_path)
        if path.exists() and _is_valid_model_dir(path):
            print(f"Using model from MLX_MODEL_PATH: {path}")
            return str(path)

    # Fallback to HuggingFace model ID (will download on first use)
    print(f"Using HuggingFace model ID: {MODEL_ID} (will download if not cached)")
    return MODEL_ID


def _is_valid_model_dir(path: Path) -> bool:
    """Check if a directory contains valid MLX-Whisper model files."""
    if not path.is_dir():
        return False
    # Check for essential model files
    has_config = (path / "config.json").exists()
    has_weights = any(path.glob("*.safetensors")) or any(path.glob("*.npz"))
    return has_config and has_weights


# Resolve model path at module load time
RESOLVED_MODEL_PATH = resolve_model_path()

# Biblical vocabulary hints for improved accuracy
BIBLICAL_PROMPT = (
    "Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, "
    "Samuel, Kings, Chronicles, Ezra, Nehemiah, Esther, Job, Psalms, Proverbs, "
    "Ecclesiastes, Song of Solomon, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, "
    "Hosea, Joel, Amos, Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, "
    "Zechariah, Malachi, Matthew, Mark, Luke, John, Acts, Romans, Corinthians, "
    "Galatians, Ephesians, Philippians, Colossians, Thessalonians, Timothy, Titus, "
    "Philemon, Hebrews, James, Peter, Jude, Revelation. "
    "Jesus Christ, Holy Spirit, Lord God, righteousness, sanctification, redemption, "
    "salvation, propitiation, justification, hallelujah, amen."
)

# Global state
model = None
stats = {
    "total_transcriptions": 0,
    "total_audio_seconds": 0.0,
    "total_inference_ms": 0,
    "model_loaded": False,
    "model_id": MODEL_ID,
    "resolved_model_path": RESOLVED_MODEL_PATH,
}


def _is_repetitive(text: Optional[str]) -> bool:
    """Detect Whisper hallucination loops (e.g. "dad dad dad ...").

    Returns True if the text is dominated by a single repeating token, which
    means we must not feed it back as a prompt and must not emit it.
    """
    if not text:
        return False
    tokens = text.lower().split()
    n = len(tokens)
    # Last-8 identical: classic stuck-decoder signature.
    if n >= 8 and len(set(tokens[-8:])) == 1:
        return True
    # Low diversity overall: catches "dad dad x dad dad dad ..." cases.
    if n >= 12 and (len(set(tokens)) / n) < 0.2:
        return True

    if _has_repeated_token_run(text):
        return True

    compact = [ch for ch in text if not ch.isspace() and ch != "\ufffd"]
    if len(compact) < 12:
        return False

    for width in range(1, 7):
        if len(compact) < width * 4:
            continue
        pattern = compact[:width]
        matching = sum(1 for idx, ch in enumerate(compact) if ch == pattern[idx % width])
        if matching / len(compact) >= 0.85:
            return True

    return False


def _has_repeated_token_run(text: str) -> bool:
    """Catch loops embedded in otherwise Bible-like text, e.g. James 5-6-9-9-9."""
    tokens = re.findall(r"[0-9A-Za-z]+", text.lower())
    if len(tokens) < 6:
        return False

    previous = None
    run_len = 0
    for token in tokens:
        if token == previous:
            run_len += 1
        else:
            previous = token
            run_len = 1
        if run_len >= 6:
            return True

    return False


HALLUCINATION_PHRASES = {
    "sous-titrage société radio-canada",
    "sous-titrage societe radio-canada",
    "sous-titrage st' 501",
    "sous-titrage st'501",
    "merci d'avoir regardé",
    "merci d'avoir regarde",
    "amen",
    "amen.",
    "thank you.",
    "thanks for watching.",
    "thanks for watching!",
    "thank you for watching.",
    "thank you for watching!",
    "we'll see what he's doing.",
    "we will see what he's doing.",
    "let's see what he's doing.",
    "please subscribe.",
    "subscribe to my channel.",
    "jesus, holy spirit, lord,",
    "jesus, lord.",
    "in",
    "in.",
    "you",
    "bye.",
    "bye-bye.",
    ".",
    "...",
}


def _is_blocklisted(text: Optional[str]) -> bool:
    if not text:
        return False
    lowered = text.strip().lower()
    if lowered in HALLUCINATION_PHRASES:
        return True
    if "sous-titrage" in lowered and "radio-canada" in lowered:
        return True
    if "sous-titrage" in lowered and len(lowered) < 80:
        return True
    return False


class TranscribeRequest(BaseModel):
    """Request model for transcription"""
    audio_b64: str  # Base64 encoded i16 PCM audio
    sample_rate: int = 16000
    language: Optional[str] = None
    use_biblical_hints: bool = True
    previous_text: Optional[str] = None  # Context from prior segment to reduce hallucinations


class TranscribeResponse(BaseModel):
    """Response model for transcription"""
    text: str
    confidence: float
    language: str
    inference_ms: int


class HealthResponse(BaseModel):
    """Response model for health check"""
    status: str
    model_id: str
    model_loaded: bool
    total_transcriptions: int
    avg_inference_ms: float


def load_model_sync():
    """Load MLX-Whisper model (synchronous)"""
    global model, stats

    if not MLX_WHISPER_AVAILABLE:
        raise RuntimeError(MLX_WHISPER_ERROR or "mlx-whisper not available")

    print(f"Loading MLX-Whisper model: {RESOLVED_MODEL_PATH}")
    start = time.perf_counter()

    # MLX-Whisper downloads and caches models automatically if given a HF repo ID
    # If given a local path, it loads directly from disk
    try:
        # Generate 1 second of silence to warm up the model
        silence = np.zeros(16000, dtype=np.float32)
        _ = mlx_whisper.transcribe(
            silence,
            path_or_hf_repo=RESOLVED_MODEL_PATH,
            language="en",
        )
        elapsed = (time.perf_counter() - start) * 1000
        print(f"Model loaded in {elapsed:.0f}ms")
        stats["model_loaded"] = True
        model = RESOLVED_MODEL_PATH  # Store the resolved path
    except Exception as e:
        print(f"Failed to load model: {e}")
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan event handler for FastAPI"""
    # Startup - DO NOT block on model loading
    # Model will be loaded on first /warmup or /transcribe request
    print(f"Starting MLX-Whisper STT Server on {SERVER_HOST}:{SERVER_PORT}")
    print(f"Model ID: {MODEL_ID}")
    print(f"Resolved path: {RESOLVED_MODEL_PATH}")
    print("NOTE: Model will be loaded on first request (use /warmup to pre-load)")

    yield

    # Shutdown
    print("MLX-Whisper STT Server shutting down")


app = FastAPI(
    title="Pewbeam MLX-Whisper STT Server",
    description="Offline speech-to-text for Apple Silicon using MLX-Whisper",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "MLX-Whisper STT Server",
        "model": MODEL_ID,
        "resolved_path": RESOLVED_MODEL_PATH,
        "status": "ready" if stats["model_loaded"] else "loading",
    }


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    avg_inference = 0.0
    if stats["total_transcriptions"] > 0:
        avg_inference = stats["total_inference_ms"] / stats["total_transcriptions"]

    return HealthResponse(
        status="degraded" if MLX_WHISPER_AVAILABLE is False else "healthy",
        model_id=MODEL_ID,
        model_loaded=stats["model_loaded"],
        total_transcriptions=stats["total_transcriptions"],
        avg_inference_ms=avg_inference,
    )


@app.post("/warmup")
async def warmup():
    """Pre-load model for instant first inference"""
    if not ensure_mlx_whisper_available():
        raise HTTPException(
            status_code=503,
            detail=MLX_WHISPER_ERROR or "mlx-whisper not available",
        )

    if stats["model_loaded"]:
        return {"status": "already_loaded", "model": MODEL_ID}

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, load_model_sync)
        return {"status": "loaded", "model": MODEL_ID}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(request: TranscribeRequest):
    """
    Transcribe audio to text using MLX-Whisper

    Audio format: i16 PCM, base64 encoded
    Sample rate: 16000 Hz (default)
    """
    if not ensure_mlx_whisper_available():
        raise HTTPException(
            status_code=503,
            detail=MLX_WHISPER_ERROR or "mlx-whisper not available",
        )

    # Load model if not already loaded
    if not stats["model_loaded"]:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, load_model_sync)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Failed to load model: {e}")

    start = time.perf_counter()

    try:
        # Decode base64 audio
        audio_bytes = base64.b64decode(request.audio_b64)

        # Convert i16 PCM to float32 (what Whisper expects)
        audio_i16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_f32 = audio_i16.astype(np.float32) / 32768.0

        audio_duration = len(audio_f32) / request.sample_rate

        # Build initial prompt with context from previous segment
        prompt_parts = []

        if request.use_biblical_hints and request.language:
            prompt_parts.append(BIBLICAL_PROMPT)

        # Match v1.1.7 behavior: append previous segment text as context
        # (last ~200 chars), but only if it is not a hallucination loop.
        if request.previous_text and not _is_repetitive(request.previous_text):
            context = request.previous_text[-200:].strip()
            if context:
                prompt_parts.append(context)

        initial_prompt = " ".join(prompt_parts) if prompt_parts else None

        # Run transcription. Explicit thresholds + temperature fallback let mlx-whisper
        # detect and retry/drop degenerate windows instead of emitting them. We also
        # disable Whisper's internal previous-text conditioning since we manage prompts
        # ourselves and want hallucination loops to not self-perpetuate.
        transcribe_kwargs = {
            "path_or_hf_repo": RESOLVED_MODEL_PATH,
            "initial_prompt": initial_prompt,
            "condition_on_previous_text": False,
            "compression_ratio_threshold": 2.4,
            "logprob_threshold": -1.0,
            "no_speech_threshold": 0.6,
            "temperature": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        }
        if request.language:
            transcribe_kwargs["language"] = request.language

        result = mlx_whisper.transcribe(audio_f32, **transcribe_kwargs)

        elapsed_ms = int((time.perf_counter() - start) * 1000)

        # Extract text from result. Drop hallucination loops so the client doesn't
        # store them as previous_text and propagate the stuck state.
        text = result.get("text", "").strip()
        if _is_repetitive(text) or _is_blocklisted(text):
            print(f"Dropped hallucinated output ({len(text.split())} tokens): \"{text[:80]}\"")
            text = ""

        # Estimate confidence (mlx-whisper doesn't return confidence directly)
        # Use a heuristic based on text length vs audio duration
        confidence = 0.95 if len(text) > 0 else 0.0

        # Update stats
        stats["total_transcriptions"] += 1
        stats["total_audio_seconds"] += audio_duration
        stats["total_inference_ms"] += elapsed_ms
        stats["model_loaded"] = True

        print(f"Transcribed {audio_duration:.1f}s audio in {elapsed_ms}ms: \"{text[:50]}...\"" if len(text) > 50 else f"Transcribed {audio_duration:.1f}s audio in {elapsed_ms}ms: \"{text}\"")

        return TranscribeResponse(
            text=text,
            confidence=confidence,
            language=result.get("language") or request.language or "auto",
            inference_ms=elapsed_ms,
        )

    except Exception as e:
        print(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
async def get_stats():
    """Get server statistics"""
    avg_inference = 0.0
    if stats["total_transcriptions"] > 0:
        avg_inference = stats["total_inference_ms"] / stats["total_transcriptions"]

    return {
        **stats,
        "avg_inference_ms": avg_inference,
        "mlx_whisper_available": MLX_WHISPER_AVAILABLE,
    }


if __name__ == "__main__":
    import uvicorn

    # If port is 0, uvicorn will auto-assign - we need to handle this
    if SERVER_PORT == 0:
        # Let uvicorn find a port, but we'll need to detect it from logs
        # For now, try to find a port ourselves
        SERVER_PORT = find_available_port(8002, 10)
        print(f"✅ Found available port: {SERVER_PORT}")

    if SERVER_PORT != int(os.getenv("MLX_STT_PORT", "8002")):
        print(f"✅ Using port {SERVER_PORT} (configured port {os.getenv('MLX_STT_PORT', '8002')} was in use)")
        # Write port to stdout so parent process can discover it
        print(f"PEWBEAM_MLX_PORT={SERVER_PORT}", flush=True)

    print(f"""
    ╔═══════════════════════════════════════════════════════════════╗
    ║  MLX-Whisper STT Server for Pewbeam                          ║
    ║  Optimized for Apple Silicon (M3 Max)                        ║
    ║                                                               ║
    ║  Model: {MODEL_ID:<45} ║
    ║  Server: http://{SERVER_HOST}:{SERVER_PORT:<38} ║
    ╚═══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=SERVER_PORT,
        log_level="info",
    )
