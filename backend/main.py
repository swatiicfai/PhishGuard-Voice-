"""
PhishGuard Voice — FastAPI WebSocket Backend
============================================
Entry point for the Cloud Run container.

Endpoints
---------
GET  /healthz                 — Health check (Cloud Run / load balancer)
POST /api/sessions            — Create a new call session, return session_id
DELETE /api/sessions/{id}     — End a call session
WS   /ws/call/{session_id}    — Bidirectional audio stream (browser ↔ Gemini Live)
WS   /ws/monitor/{session_id} — Optional: raw event stream to dashboard (SSE alternative)

Audio Protocol (binary WebSocket frames)
-----------------------------------------
Browser → Server : raw PCM16 chunks at 16 kHz, mono
Server  → Browser: raw PCM16 chunks at 24 kHz, mono (Gemini Live native output)
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

# Local imports
from agents.time_waster import get_time_waster_prompt
from agents.security_auditor import get_auditor_prompt, get_auditor_tools
from services.gemini_live import GeminiLiveSession
from services.firestore_client import (
    create_session,
    close_session,
    log_threat_event,
    update_caller_profile,
    attach_grounding_result,
)
from services.search_grounding import search_and_verify

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Active session registry ───────────────────────────────────────────────────
# Maps session_id → { "gemini": GeminiLiveSession, "threat_score": int,
#                      "monitor_queues": list[asyncio.Queue] }
_sessions: dict[str, dict] = {}

# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("PhishGuard Voice backend starting up…")
    yield
    logger.info("PhishGuard Voice backend shutting down…")
    # Close any lingering sessions
    for sid, data in list(_sessions.items()):
        await data["gemini"].stop()
    _sessions.clear()


app = FastAPI(
    title="PhishGuard Voice API",
    version="1.0.0",
    description="Reverse-Scammer Sandbox & Real-Time Threat Intelligence",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────

_allowed_origins_raw = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:5000,http://localhost:3000",
)
_allowed_origins = [o.strip() for o in _allowed_origins_raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Helper: merged system prompt ──────────────────────────────────────────────

def _build_system_prompt() -> str:
    return (
        get_time_waster_prompt()
        + "\n\n"
        + "---\n\n"
        + get_auditor_prompt()
    )

# ── Helper: function call router ──────────────────────────────────────────────

async def _handle_function_call(
    session_id: str,
    name: str,
    args: dict,
) -> None:
    """
    Dispatch Auditor function calls to Firestore and search grounding.
    Called from the GeminiLiveSession receive loop (background task).
    """
    session_data = _sessions.get(session_id)
    if not session_data:
        return

    if name == "log_threat_event":
        delta    = int(args.get("threat_score_delta", 5))
        new_score = min(100, session_data["threat_score"] + delta)
        session_data["threat_score"] = new_score

        event_id = await log_threat_event(
            session_id=session_id,
            event={
                "category":           args.get("category", "UNKNOWN"),
                "severity":           args.get("severity", "LOW"),
                "evidence_snippet":   args.get("evidence_snippet", ""),
                "threat_score_delta": delta,
                "grounding_query":    args.get("grounding_query"),
                "grounding_result":   None,
            },
            new_score=new_score,
        )

        # Push to monitor WebSocket subscribers
        monitor_event = {
            "type":            "threat_event",
            "session_id":      session_id,
            "event_id":        event_id,
            "category":        args.get("category", "UNKNOWN"),
            "severity":        args.get("severity", "LOW"),
            "evidence_snippet": args.get("evidence_snippet", ""),
            "threat_score":    new_score,
            "timestamp":       int(time.time() * 1000),
        }
        await _broadcast_monitor(session_id, monitor_event)

        # Kick off background search grounding if a query was provided
        grounding_query = args.get("grounding_query", "")
        if grounding_query:
            asyncio.create_task(
                _do_grounding(session_id, event_id, grounding_query)
            )

    elif name == "update_caller_profile":
        await update_caller_profile(session_id, args)
        await _broadcast_monitor(
            session_id,
            {"type": "caller_profile_update", "session_id": session_id, **args},
        )


async def _do_grounding(
    session_id: str,
    event_id: str,
    query: str,
) -> None:
    """Background task: perform search grounding and attach result."""
    try:
        result = await search_and_verify(query)
        await attach_grounding_result(session_id, event_id, result)
        await _broadcast_monitor(
            session_id,
            {
                "type":       "grounding_result",
                "session_id": session_id,
                "event_id":   event_id,
                "result":     result,
            },
        )
    except Exception as exc:
        logger.warning("Grounding task failed: %s", exc)


async def _broadcast_monitor(session_id: str, payload: dict) -> None:
    """Push a JSON event to all active monitor WebSocket subscribers."""
    session_data = _sessions.get(session_id)
    if not session_data:
        return
    dead = []
    for q in session_data.get("monitor_queues", []):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        session_data["monitor_queues"].remove(q)


# ── REST Endpoints ────────────────────────────────────────────────────────────

@app.get("/healthz", tags=["infra"])
async def health_check():
    return {"status": "ok", "service": "phishguard-voice"}


class SessionCreateResponse(BaseModel):
    session_id: str


@app.post("/api/sessions", response_model=SessionCreateResponse, tags=["sessions"])
async def create_new_session():
    """Initialise a Gemini Live session and Firestore document."""
    system_prompt = _build_system_prompt()
    tools         = get_auditor_tools()

    # Placeholder Gemini session (actual WS connects on /ws/call)
    import uuid
    session_id = str(uuid.uuid4())

    _sessions[session_id] = {
        "gemini":         None,      # populated when WS connects
        "threat_score":   0,
        "monitor_queues": [],
        "system_prompt":  system_prompt,
        "tools":          tools,
    }

    await create_session(session_id)
    logger.info("Session created: %s", session_id)
    return {"session_id": session_id}


@app.delete("/api/sessions/{session_id}", tags=["sessions"])
async def end_session(session_id: str):
    """End a call session and close Gemini Live connection."""
    data = _sessions.pop(session_id, None)
    if not data:
        raise HTTPException(status_code=404, detail="Session not found")

    gemini: GeminiLiveSession | None = data.get("gemini")
    if gemini:
        await gemini.stop()

    final_score = data.get("threat_score", 0)
    await close_session(session_id, final_score)
    logger.info("Session ended: %s (final score=%d)", session_id, final_score)
    return {"status": "closed", "session_id": session_id, "final_threat_score": final_score}


# ── WebSocket: Audio Call ─────────────────────────────────────────────────────

@app.websocket("/ws/call/{session_id}")
async def websocket_call(websocket: WebSocket, session_id: str):
    """
    Bidirectional audio relay between the browser and Gemini Live.

    Binary frames (browser → server) : PCM16 audio at 16 kHz
    Binary frames (server → browser) : PCM16 audio at 24 kHz (Gemini output)
    Text frames (browser → server)   : JSON control messages
    """
    session_data = _sessions.get(session_id)
    if not session_data:
        await websocket.close(code=4404, reason="Session not found")
        return

    await websocket.accept()
    logger.info("Audio WebSocket connected [session=%s]", session_id)

    # Callback: send Gemini audio back to the browser
    async def on_audio_chunk(pcm: bytes) -> None:
        try:
            await websocket.send_bytes(pcm)
        except Exception:
            pass

    # Callback: route Auditor function calls
    async def on_function_call(name: str, args: dict) -> None:
        await _handle_function_call(session_id, name, args)

    # Start the Gemini Live session
    gemini = GeminiLiveSession(
        system_prompt    = session_data["system_prompt"],
        tools            = session_data["tools"],
        on_function_call = on_function_call,
        on_audio_chunk   = on_audio_chunk,
    )
    session_data["gemini"] = gemini

    try:
        await gemini.start()

        # Relay browser audio to Gemini
        while True:
            message = await websocket.receive()

            if "bytes" in message:
                # Raw PCM audio chunk from the browser
                await gemini.send_audio(message["bytes"])

            elif "text" in message:
                # JSON control message
                try:
                    ctrl = json.loads(message["text"])
                    if ctrl.get("type") == "end_call":
                        break
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        logger.info("Audio WebSocket disconnected [session=%s]", session_id)
    except Exception as exc:
        logger.exception("Audio WebSocket error [session=%s]: %s", session_id, exc)
    finally:
        await gemini.stop()
        logger.info("Audio WebSocket cleanup done [session=%s]", session_id)


# ── WebSocket: Monitor Feed ───────────────────────────────────────────────────

@app.websocket("/ws/monitor/{session_id}")
async def websocket_monitor(websocket: WebSocket, session_id: str):
    """
    Real-time threat event feed for the dashboard (alternative to Firestore
    onSnapshot for environments without Firebase JS SDK).

    Sends JSON text frames with structured threat events.
    """
    session_data = _sessions.get(session_id)
    if not session_data:
        await websocket.close(code=4404, reason="Session not found")
        return

    await websocket.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    session_data["monitor_queues"].append(q)
    logger.info("Monitor WebSocket connected [session=%s]", session_id)

    try:
        while True:
            event = await q.get()
            await websocket.send_text(json.dumps(event))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("Monitor WebSocket error: %s", exc)
    finally:
        if q in session_data.get("monitor_queues", []):
            session_data["monitor_queues"].remove(q)
        logger.info("Monitor WebSocket disconnected [session=%s]", session_id)
