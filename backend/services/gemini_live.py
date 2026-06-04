"""
Gemini Live Service — Bidirectional Audio-to-Audio WebSocket Client
====================================================================
Wraps the Vertex AI `BidiGenerateContent` (Gemini Live) streaming API.

Responsibilities:
  • Open / manage the persistent bidirectional gRPC-over-WebSocket session
  • Send audio chunks from the caller in real-time
  • Receive model responses and split them into:
      - Audio PCM chunks  → forwarded back to the caller
      - Function calls    → dispatched to the event_handler callback
  • Handle turn detection, interruptions, and graceful session teardown
"""

import asyncio
import base64
import json
import logging
import os
import uuid
from collections.abc import AsyncGenerator, Callable, Awaitable
from typing import Any

import websockets
from google.auth import default as google_auth_default
from google.auth.transport.requests import Request as GoogleAuthRequest

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

PROJECT_ID   = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
LOCATION     = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
MODEL        = os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")

LIVE_API_HOST = f"{LOCATION}-aiplatform.googleapis.com"
LIVE_API_WS   = (
    f"wss://{LIVE_API_HOST}/ws/google.cloud.aiplatform.v1beta1"
    f".LlmBidiService/BidiGenerateContent"
)

# Audio format expected by Gemini Live: 16-bit PCM, 16 000 Hz, mono
AUDIO_SAMPLE_RATE = 16_000
AUDIO_ENCODING    = "LINEAR16"

# ── Token helper ──────────────────────────────────────────────────────────────

def _get_access_token() -> str:
    """Obtain a short-lived Google OAuth2 access token."""
    credentials, _ = google_auth_default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(GoogleAuthRequest())
    return credentials.token  # type: ignore[return-value]


# ── Session ───────────────────────────────────────────────────────────────────

class GeminiLiveSession:
    """
    Manages a single Gemini Live bidirectional streaming session.

    Parameters
    ----------
    system_prompt : str
        Merged system instruction (Time-Waster + Security Auditor).
    tools : list[dict]
        Gemini tool/function declarations for the Auditor agent.
    on_function_call : async callable
        Coroutine invoked whenever the model fires a function_call.
        Signature: async (name: str, args: dict) -> None
    on_audio_chunk : async callable
        Coroutine invoked with each PCM audio chunk from the model.
        Signature: async (pcm_bytes: bytes) -> None
    """

    def __init__(
        self,
        system_prompt: str,
        tools: list[dict[str, Any]],
        on_function_call: Callable[[str, dict], Awaitable[None]],
        on_audio_chunk: Callable[[bytes], Awaitable[None]],
    ):
        self.session_id      = str(uuid.uuid4())
        self._system_prompt  = system_prompt
        self._tools          = tools
        self._on_function_call = on_function_call
        self._on_audio_chunk   = on_audio_chunk
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._receive_task: asyncio.Task | None = None
        self._active = False

    # ── Connection ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Connect to Gemini Live and send the session setup message."""
        token = await asyncio.get_event_loop().run_in_executor(None, _get_access_token)
        headers = {"Authorization": f"Bearer {token}"}

        model_path = (
            f"projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{MODEL}"
        )

        self._ws = await websockets.connect(
            f"{LIVE_API_WS}?model={model_path}",
            additional_headers=headers,
            ping_interval=20,
            ping_timeout=30,
        )
        logger.info("Gemini Live WebSocket connected [session=%s]", self.session_id)

        # Send setup message
        setup_msg = {
            "setup": {
                "model": model_path,
                "generation_config": {
                    "response_modalities": ["AUDIO"],
                    "speech_config": {
                        "voice_config": {
                            "prebuilt_voice_config": {"voice_name": "Aoede"}
                        }
                    },
                },
                "system_instruction": {
                    "parts": [{"text": self._system_prompt}]
                },
                "tools": self._tools,
            }
        }
        await self._ws.send(json.dumps(setup_msg))

        # Wait for setup acknowledgement
        raw = await self._ws.recv()
        ack = json.loads(raw)
        if "setupComplete" not in ack:
            raise RuntimeError(f"Unexpected setup response: {ack}")
        logger.info("Gemini Live session setup complete [session=%s]", self.session_id)

        self._active = True
        # Start background receive loop
        self._receive_task = asyncio.create_task(self._receive_loop())

    async def stop(self) -> None:
        """Gracefully close the session."""
        self._active = False
        if self._receive_task:
            self._receive_task.cancel()
        if self._ws:
            await self._ws.close()
        logger.info("Gemini Live session closed [session=%s]", self.session_id)

    # ── Send audio ────────────────────────────────────────────────────────────

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Stream a chunk of caller audio to the model."""
        if not self._ws or not self._active:
            return
        msg = {
            "realtimeInput": {
                "mediaChunks": [
                    {
                        "mimeType": f"audio/pcm;rate={AUDIO_SAMPLE_RATE}",
                        "data": base64.b64encode(pcm_bytes).decode(),
                    }
                ]
            }
        }
        await self._ws.send(json.dumps(msg))

    # ── Receive loop ──────────────────────────────────────────────────────────

    async def _receive_loop(self) -> None:
        """Background task: parse all incoming server messages."""
        try:
            async for raw in self._ws:  # type: ignore[union-attr]
                if not self._active:
                    break
                await self._handle_server_message(json.loads(raw))
        except websockets.exceptions.ConnectionClosedOK:
            logger.info("Gemini Live connection closed normally.")
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("Error in Gemini Live receive loop: %s", exc)

    async def _handle_server_message(self, msg: dict) -> None:
        """Route an incoming server message to the appropriate handler."""
        # ── Audio response ────────────────────────────────────────────────────
        server_content = msg.get("serverContent", {})
        model_turn = server_content.get("modelTurn", {})
        for part in model_turn.get("parts", []):
            # Audio chunk
            if "inlineData" in part:
                audio_b64 = part["inlineData"].get("data", "")
                if audio_b64:
                    pcm = base64.b64decode(audio_b64)
                    await self._on_audio_chunk(pcm)

            # Text (transcript — for debugging only)
            if "text" in part:
                logger.debug("Model text: %s", part["text"][:120])

        # ── Function call (Security Auditor fires these) ───────────────────
        tool_call = msg.get("toolCall")
        if tool_call:
            for fc in tool_call.get("functionCalls", []):
                name = fc.get("name", "")
                args = fc.get("args", {})
                call_id = fc.get("id", "")
                logger.info("Function call: %s %s", name, args)
                await self._on_function_call(name, args)
                # Acknowledge the function call so the session continues
                await self._ack_function_call(call_id, name)

    async def _ack_function_call(self, call_id: str, name: str) -> None:
        """Send a function_response back to the model to unblock the session."""
        if not self._ws:
            return
        ack = {
            "toolResponse": {
                "functionResponses": [
                    {
                        "id": call_id,
                        "name": name,
                        "response": {"result": "logged"},
                    }
                ]
            }
        }
        await self._ws.send(json.dumps(ack))
