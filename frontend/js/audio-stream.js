/**
 * audio-stream.js
 * ───────────────
 * Handles browser-side audio:
 *   1. Captures microphone input via getUserMedia
 *   2. Encodes it as PCM16 and streams over a WebSocket to the backend
 *   3. Receives PCM16 audio from Gemini Live (Doris's voice) and plays it back
 *
 * Audio formats:
 *   Microphone capture : 16 kHz, mono, PCM16 (resampled from browser default)
 *   Playback output    : 24 kHz, mono, PCM16 (Gemini Live native output)
 */

const CAPTURE_SAMPLE_RATE  = 16_000;   // Required by Gemini Live input
const PLAYBACK_SAMPLE_RATE = 24_000;   // Gemini Live native audio output
const CHUNK_DURATION_MS    = 100;       // Send audio every 100ms

let _ws               = null;
let _audioCtx         = null;
let _captureStream    = null;
let _scriptProcessor  = null;
let _playbackCtx      = null;
let _nextPlayTime     = 0;
let _isStreaming       = false;

// Callbacks
let _onAudioLevel  = null;   // (rmsLevel: 0.0–1.0) → void
let _onConnected   = null;   // () → void
let _onDisconnected= null;   // (reason: str) → void
let _onError       = null;   // (msg: str) → void


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start streaming microphone audio to the backend WebSocket.
 *
 * @param {string}   wsUrl       - Backend WebSocket URL (wss://host/ws/call/{id})
 * @param {object}   callbacks   - { onAudioLevel, onConnected, onDisconnected, onError }
 */
export async function startStream(wsUrl, callbacks = {}) {
  _onAudioLevel   = callbacks.onAudioLevel   ?? null;
  _onConnected    = callbacks.onConnected    ?? null;
  _onDisconnected = callbacks.onDisconnected ?? null;
  _onError        = callbacks.onError        ?? null;

  if (_isStreaming) {
    console.warn('[AudioStream] Already streaming. Call stopStream() first.');
    return;
  }

  // 1. Request microphone access
  try {
    _captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       CAPTURE_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
      video: false,
    });
  } catch (err) {
    _onError?.(`Microphone access denied: ${err.message}`);
    return;
  }

  // 2. Connect WebSocket
  _ws = new WebSocket(wsUrl);
  _ws.binaryType = 'arraybuffer';

  _ws.onopen = () => {
    console.log('[AudioStream] WebSocket connected:', wsUrl);
    _startMicrophoneCapture();
    _startPlaybackContext();
    _isStreaming = true;
    _onConnected?.();
  };

  _ws.onmessage = (evt) => {
    // Binary frame = PCM16 audio from Gemini (Doris's voice)
    if (evt.data instanceof ArrayBuffer) {
      _schedulePcmPlayback(evt.data);
    }
  };

  _ws.onclose = (evt) => {
    console.log('[AudioStream] WebSocket closed:', evt.code, evt.reason);
    _cleanup();
    _onDisconnected?.(evt.reason || 'Connection closed');
  };

  _ws.onerror = (err) => {
    console.error('[AudioStream] WebSocket error:', err);
    _onError?.('WebSocket connection error');
  };
}


/**
 * Stop the audio stream and close the WebSocket.
 */
export function stopStream() {
  if (!_isStreaming) return;

  // Signal backend to end the call
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: 'end_call' }));
  }

  _cleanup();
}


export function isStreaming() { return _isStreaming; }


// ── Microphone Capture ────────────────────────────────────────────────────────

function _startMicrophoneCapture() {
  _audioCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  const source = _audioCtx.createMediaStreamSource(_captureStream);

  // ScriptProcessor for raw PCM access (deprecated but universally supported)
  // TODO: migrate to AudioWorklet for production
  const bufferSize = Math.floor(CAPTURE_SAMPLE_RATE * CHUNK_DURATION_MS / 1000);
  _scriptProcessor = _audioCtx.createScriptProcessor(bufferSize, 1, 1);

  _scriptProcessor.onaudioprocess = (evt) => {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;

    const float32 = evt.inputBuffer.getChannelData(0);
    const pcm16   = _float32ToPcm16(float32);

    // Compute RMS for waveform visualiser
    if (_onAudioLevel) {
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      _onAudioLevel(Math.sqrt(sum / float32.length));
    }

    _ws.send(pcm16.buffer);
  };

  source.connect(_scriptProcessor);
  _scriptProcessor.connect(_audioCtx.destination);
}


// ── Playback (Doris's voice from Gemini) ─────────────────────────────────────

function _startPlaybackContext() {
  _playbackCtx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
  _nextPlayTime = _playbackCtx.currentTime;
}

function _schedulePcmPlayback(arrayBuffer) {
  if (!_playbackCtx) return;

  const pcm16    = new Int16Array(arrayBuffer);
  const float32  = _pcm16ToFloat32(pcm16);
  const duration = float32.length / PLAYBACK_SAMPLE_RATE;

  const audioBuffer = _playbackCtx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
  audioBuffer.getChannelData(0).set(float32);

  const source = _playbackCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(_playbackCtx.destination);

  const startAt = Math.max(_nextPlayTime, _playbackCtx.currentTime);
  source.start(startAt);
  _nextPlayTime = startAt + duration;
}


// ── PCM conversion helpers ────────────────────────────────────────────────────

function _float32ToPcm16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function _pcm16ToFloat32(pcm16Array) {
  const out = new Float32Array(pcm16Array.length);
  for (let i = 0; i < pcm16Array.length; i++) {
    out[i] = pcm16Array[i] / (pcm16Array[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return out;
}


// ── Cleanup ───────────────────────────────────────────────────────────────────

function _cleanup() {
  _isStreaming = false;

  if (_scriptProcessor) { _scriptProcessor.disconnect(); _scriptProcessor = null; }
  if (_audioCtx)        { _audioCtx.close();             _audioCtx         = null; }
  if (_captureStream)   { _captureStream.getTracks().forEach(t => t.stop()); _captureStream = null; }
  if (_playbackCtx)     { _playbackCtx.close();           _playbackCtx      = null; }
  if (_ws && _ws.readyState !== WebSocket.CLOSED) { _ws.close(); }
  _ws = null;
  _nextPlayTime = 0;
}
