/**
 * app.js
 * ──────
 * Main application controller for the PhishGuard Voice dashboard.
 *
 * Coordinates:
 *   • Config modal (Firebase + Backend URL setup)
 *   • Session creation / teardown via REST API
 *   • Audio stream start/stop (audio-stream.js)
 *   • Firestore real-time listener (firestore-listener.js)
 *   • UI rendering: threat feed, transcript, gauge, stats, alerts
 *   • Threat visualiser (threat-visualizer.js)
 */

import { initFirebase, subscribeToSession, stopListening }
  from './firestore-listener.js';

import { startStream, stopStream, isStreaming }
  from './audio-stream.js';

import {
  initWaveform, updateWaveform, startWaveformAnimation, stopWaveformAnimation,
  initGauge, setThreatScore,
  initParticles, burstParticles,
} from './threat-visualizer.js';


// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  sessionId:       null,
  backendUrl:      '',
  firebaseConfig:  null,
  callStartTime:   null,
  timerInterval:   null,
  threatScore:     0,
  totalEvents:     0,
  minutesWasted:   0,
  demoMode:        false,   // true = inject synthetic events without real backend
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  // Config modal
  configModal:      $('config-modal'),
  inputBackendUrl:  $('input-backend-url'),
  inputApiKey:      $('input-api-key'),
  inputProjectId:   $('input-project-id'),
  inputAppId:       $('input-app-id'),
  btnSaveConfig:    $('btn-save-config'),
  btnDemoMode:      $('btn-demo-mode'),

  // Controls
  btnIntercept:     $('btn-intercept'),
  btnEndCall:       $('btn-end-call'),
  btnSettings:      $('btn-settings'),

  // Status
  statusPill:       $('status-pill'),
  statusText:       $('status-text'),
  callTimer:        $('call-timer'),

  // Waveform
  waveformCanvas:   $('waveform-canvas'),

  // Gauge
  gaugeSvg:         $('gauge-svg'),
  gaugeNumber:      $('gauge-number'),
  gaugeBadge:       $('gauge-badge'),

  // Stats
  statWasted:       $('stat-wasted'),
  statEvents:       $('stat-events'),
  statScore:        $('stat-score'),

  // Caller profile
  profileOrg:       $('profile-org'),
  profileName:      $('profile-name'),
  profileScript:    $('profile-script'),
  profileCallback:  $('profile-callback'),

  // Transcript
  transcriptFeed:   $('transcript-feed'),

  // Threat feed
  threatFeed:       $('threat-feed'),
  groundingFeed:    $('grounding-feed'),

  // Particles
  particleCanvas:   $('particle-canvas'),

  // Alert banner
  alertBanner:      $('alert-banner'),
};


// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initWaveform(els.waveformCanvas);
  initGauge(els.gaugeSvg, els.gaugeNumber, els.gaugeBadge);
  initParticles(els.particleCanvas);

  _bindEvents();
  _loadSavedConfig();

  // Show config modal if no config saved
  const saved = _getSavedConfig();
  if (!saved) {
    els.configModal.classList.remove('hidden');
  }

  // Subscribe to PhishGuard event bus
  window.PhishGuardEvents.addEventListener('threatEvent',       _onThreatEvent);
  window.PhishGuardEvents.addEventListener('sessionUpdate',     _onSessionUpdate);
  window.PhishGuardEvents.addEventListener('groundingResult',   _onGroundingResult);
});


// ── Event Bindings ────────────────────────────────────────────────────────────

function _bindEvents() {
  els.btnSaveConfig.addEventListener('click',  _saveConfig);
  els.btnDemoMode.addEventListener('click',    _startDemoMode);
  els.btnIntercept.addEventListener('click',   _startCall);
  els.btnEndCall.addEventListener('click',     _endCall);
  els.btnSettings.addEventListener('click', () => {
    els.configModal.classList.remove('hidden');
  });
}


// ── Config ────────────────────────────────────────────────────────────────────

function _getSavedConfig() {
  try { return JSON.parse(localStorage.getItem('phishguard_config')); }
  catch { return null; }
}

function _loadSavedConfig() {
  const cfg = _getSavedConfig();
  if (!cfg) return;
  if (els.inputBackendUrl) els.inputBackendUrl.value = cfg.backendUrl || '';
  if (els.inputApiKey)     els.inputApiKey.value     = cfg.apiKey     || '';
  if (els.inputProjectId)  els.inputProjectId.value  = cfg.projectId  || '';
  if (els.inputAppId)      els.inputAppId.value       = cfg.appId      || '';
}

function _saveConfig() {
  const cfg = {
    backendUrl: els.inputBackendUrl.value.trim(),
    apiKey:     els.inputApiKey.value.trim(),
    projectId:  els.inputProjectId.value.trim(),
    appId:      els.inputAppId.value.trim(),
  };
  localStorage.setItem('phishguard_config', JSON.stringify(cfg));
  state.backendUrl    = cfg.backendUrl;
  state.firebaseConfig = cfg.apiKey ? {
    apiKey:    cfg.apiKey,
    projectId: cfg.projectId,
    appId:     cfg.appId,
    authDomain:    `${cfg.projectId}.firebaseapp.com`,
    storageBucket: `${cfg.projectId}.appspot.com`,
    messagingSenderId: '',
  } : null;

  if (state.firebaseConfig) {
    initFirebase(state.firebaseConfig);
  }

  els.configModal.classList.add('hidden');
  _showAlert('✅ Configuration saved', 'info');
}


// ── Call Lifecycle ────────────────────────────────────────────────────────────

async function _startCall() {
  const cfg = _getSavedConfig();
  if (!cfg?.backendUrl && !state.demoMode) {
    els.configModal.classList.remove('hidden');
    return;
  }

  state.backendUrl    = cfg?.backendUrl || '';
  state.firebaseConfig = cfg?.apiKey ? {
    apiKey:    cfg.apiKey,
    projectId: cfg.projectId,
    appId:     cfg.appId,
    authDomain:    `${cfg.projectId}.firebaseapp.com`,
    storageBucket: `${cfg.projectId}.appspot.com`,
    messagingSenderId: '',
  } : null;

  if (state.firebaseConfig && !state.demoMode) {
    initFirebase(state.firebaseConfig);
  }

  // Reset UI state
  _resetUI();
  _setStatus('active', 'INTERCEPTING');
  els.btnIntercept.disabled = true;
  els.btnEndCall.disabled   = false;

  if (state.demoMode) {
    state.sessionId   = 'demo-' + Date.now();
    state.callStartTime = Date.now();
    _startTimer();
    startWaveformAnimation();
    _runDemoSimulation();
    return;
  }

  try {
    // 1. Create session on backend
    const resp = await fetch(`${state.backendUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { session_id } = await resp.json();
    state.sessionId = session_id;

    // 2. Subscribe Firestore listener
    if (state.firebaseConfig) {
      subscribeToSession(session_id);
    }

    // 3. Start audio stream
    const wsUrl = state.backendUrl
      .replace(/^http/, 'ws')
      .replace(/^https/, 'wss')
      + `/ws/call/${session_id}`;

    await startStream(wsUrl, {
      onAudioLevel:    (lvl) => updateWaveform(lvl),
      onConnected:     ()    => { state.callStartTime = Date.now(); _startTimer(); startWaveformAnimation(); },
      onDisconnected:  ()    => _endCall(),
      onError:         (msg) => _showAlert(`⚠️ ${msg}`, 'error'),
    });

    _addTranscriptBubble('doris', 'Hello? …Hello? Oh yes, I can hear you now. Who is this calling please, dear?');

  } catch (err) {
    console.error('Failed to start call:', err);
    _showAlert(`❌ Failed to start: ${err.message}`, 'error');
    _setStatus('idle', 'STANDBY');
    els.btnIntercept.disabled = false;
    els.btnEndCall.disabled   = true;
  }
}


async function _endCall() {
  if (!state.sessionId) return;

  stopStream();
  stopWaveformAnimation();
  stopListening();
  _stopTimer();

  if (!state.demoMode && state.backendUrl) {
    try {
      await fetch(`${state.backendUrl}/api/sessions/${state.sessionId}`, {
        method: 'DELETE',
      });
    } catch (e) { /* best-effort */ }
  }

  _setStatus('idle', 'STANDBY');
  els.btnIntercept.disabled = false;
  els.btnEndCall.disabled   = true;
  _showAlert(`📞 Call ended — ${state.totalEvents} threats detected, score: ${state.threatScore}`, 'info');

  state.sessionId   = null;
  state.demoMode    = false;
}


// ── Firestore Event Handlers ──────────────────────────────────────────────────

function _onThreatEvent(evt) {
  const e = evt.detail;
  _renderThreatCard(e);

  state.totalEvents++;
  els.statEvents.textContent = state.totalEvents;

  // Particle burst
  if (e.severity === 'CRITICAL' || e.severity === 'HIGH') {
    burstParticles(e.severity);
    _showAlert(
      `🚨 ${e.severity}: ${e.category.replace(/_/g, ' ')} — "${e.evidence_snippet.slice(0, 60)}…"`,
      'critical'
    );
  }

  // Inject into transcript as scammer turn
  _addTranscriptBubble('scammer', e.evidence_snippet, _highlightFraud(e.evidence_snippet));
}

function _onSessionUpdate(evt) {
  const d = evt.detail;

  if (typeof d.threat_score === 'number') {
    state.threatScore = d.threat_score;
    setThreatScore(d.threat_score);
    els.statScore.textContent = d.threat_score;
  }

  if (d.caller_profile) {
    _updateCallerProfile(d.caller_profile);
  }
}

function _onGroundingResult(evt) {
  _renderGroundingCard(evt.detail);
}


// ── UI Rendering ──────────────────────────────────────────────────────────────

function _renderThreatCard(e) {
  // Remove empty state placeholder
  const empty = els.threatFeed.querySelector('.transcript-empty');
  if (empty) empty.remove();

  const time = new Date(e.timestamp).toLocaleTimeString();
  const card = document.createElement('div');
  card.className = `threat-event-card ${e.severity}`;
  card.innerHTML = `
    <div class="threat-event-header">
      <span class="threat-category-badge badge-${e.category}">${e.category.replace(/_/g, ' ')}</span>
      <span class="severity-chip chip-${e.severity}">+${e.threat_score_delta}</span>
    </div>
    <p class="threat-evidence">${_escapeHtml(e.evidence_snippet)}</p>
    <div class="threat-timestamp">⏱ ${time}</div>
  `;
  els.threatFeed.prepend(card);
}

function _renderGroundingCard(detail) {
  const r = detail.result;
  if (!r) return;

  const card = document.createElement('div');
  card.className = 'grounding-card';
  card.innerHTML = `
    <div class="grounding-header">
      <span class="grounding-risk-badge risk-${r.risk_level}">${r.risk_level}</span>
      <span style="font-size:11px;color:var(--clr-text-muted)">Search Verified</span>
    </div>
    <div class="grounding-query">🔍 ${_escapeHtml(r.query)}</div>
    ${r.snippet ? `<div class="grounding-snippet">${_escapeHtml(r.snippet.slice(0, 140))}</div>` : ''}
    ${r.source_url ? `<div class="grounding-source">${_escapeHtml(r.source_url)}</div>` : ''}
  `;
  els.groundingFeed.prepend(card);
}

function _addTranscriptBubble(speaker, rawText, highlightedHtml) {
  // Remove placeholder
  const empty = els.transcriptFeed.querySelector('.transcript-empty');
  if (empty) empty.remove();

  const time  = new Date().toLocaleTimeString();
  const label = speaker === 'doris' ? '🛡️ Doris' : '🎭 Caller';
  const bubble = document.createElement('div');
  bubble.className = `transcript-bubble ${speaker === 'scammer' ? 'scammer' : ''}`;
  bubble.innerHTML = `
    <div class="bubble-avatar ${speaker === 'doris' ? 'doris' : 'scammer'}">${speaker === 'doris' ? '🧓' : '☠️'}</div>
    <div class="bubble-content">
      <div class="bubble-meta"><span>${label}</span><span>${time}</span></div>
      <div class="bubble-text">${highlightedHtml || _escapeHtml(rawText)}</div>
    </div>
  `;
  els.transcriptFeed.appendChild(bubble);
  els.transcriptFeed.scrollTop = els.transcriptFeed.scrollHeight;
}

function _updateCallerProfile(profile) {
  if (profile.claimed_organization) {
    els.profileOrg.textContent  = profile.claimed_organization;
    els.profileOrg.classList.remove('empty');
  }
  if (profile.claimed_agent_name) {
    els.profileName.textContent = profile.claimed_agent_name;
    els.profileName.classList.remove('empty');
  }
  if (profile.scam_script_type) {
    els.profileScript.textContent = profile.scam_script_type.replace(/_/g, ' ').toUpperCase();
    els.profileScript.classList.remove('empty');
  }
  if (profile.callback_number) {
    els.profileCallback.textContent = profile.callback_number;
    els.profileCallback.classList.remove('empty');
  }
}


// ── Timer ─────────────────────────────────────────────────────────────────────

function _startTimer() {
  state.timerInterval = setInterval(() => {
    if (!state.callStartTime) return;
    const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    els.callTimer.textContent = `${m}:${s}`;
    state.minutesWasted = Math.floor(elapsed / 60);
    els.statWasted.textContent = `${m}:${s}`;
  }, 1000);
}

function _stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}


// ── Status ────────────────────────────────────────────────────────────────────

function _setStatus(mode, text) {
  els.statusPill.className = `status-pill ${mode}`;
  els.statusText.textContent = text;
}


// ── Alerts ────────────────────────────────────────────────────────────────────

function _showAlert(message, type = 'info') {
  const alert = document.createElement('div');
  alert.className = `alert${type === 'critical' ? ' critical' : ''}`;
  alert.innerHTML = `<span>${message}</span>`;
  els.alertBanner.prepend(alert);
  setTimeout(() => alert.remove(), type === 'critical' ? 8000 : 4000);
}


// ── Reset ─────────────────────────────────────────────────────────────────────

function _resetUI() {
  els.threatFeed.innerHTML = `
    <div class="transcript-empty">
      <div class="transcript-empty-icon">🛡️</div>
      <span>Threat events will appear here in real-time</span>
    </div>`;
  els.transcriptFeed.innerHTML = `
    <div class="transcript-empty">
      <div class="transcript-empty-icon">🎙️</div>
      <span>Transcript will appear as the call progresses</span>
    </div>`;
  els.groundingFeed.innerHTML = '';
  state.threatScore = 0; state.totalEvents = 0;
  els.statEvents.textContent = '0';
  els.statWasted.textContent = '00:00';
  els.statScore.textContent  = '0';
  els.callTimer.textContent  = '00:00';
  setThreatScore(0);
  _resetCallerProfile();
}

function _resetCallerProfile() {
  [els.profileOrg, els.profileName, els.profileScript, els.profileCallback].forEach(el => {
    el.textContent = '—';
    el.classList.add('empty');
  });
}


// ── Utilities ─────────────────────────────────────────────────────────────────

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _highlightFraud(text) {
  const keywords = [
    'IRS','Social Security','Microsoft','Amazon','Apple','FBI','DEA',
    'arrest','warrant','wire transfer','Bitcoin','gift card','AnyDesk',
    'TeamViewer','remote access','account suspended','lawsuit','federal',
    'immediately','right now','do not hang up','do not tell',
  ];
  let out = _escapeHtml(text);
  keywords.forEach(kw => {
    const re = new RegExp(`(${kw})`, 'gi');
    out = out.replace(re, `<span class="fraud-highlight">$1</span>`);
  });
  return out;
}


// ── Demo Mode ─────────────────────────────────────────────────────────────────

function _startDemoMode() {
  state.demoMode = true;
  els.configModal.classList.add('hidden');
  _startCall();
}

const DEMO_EVENTS = [
  { delay: 2000,  speaker:'scammer', text:'This is Officer David Johnson calling from the Social Security Administration. We have suspended your Social Security Number due to suspicious activity.' },
  { delay: 5000,  category:'IMPERSONATION', severity:'HIGH', evidence:'Officer David Johnson calling from the Social Security Administration', delta:18, score:18 },
  { delay: 7000,  speaker:'doris', text:'Oh my goodness! Suspended? Oh dear, oh dear… now hold on, I need to get my reading glasses, just one moment sweetheart…' },
  { delay: 11000, speaker:'scammer', text:'Ma\'am, this is urgent. You will be arrested by federal marshals within 24 hours unless you pay the fine of $2,400 immediately using Google Play gift cards.' },
  { delay: 14000, category:'LEGAL_THREAT',     severity:'CRITICAL', evidence:'arrested by federal marshals within 24 hours', delta:28, score:46 },
  { delay: 14500, category:'GIFT_CARD',         severity:'CRITICAL', evidence:'pay the fine using Google Play gift cards', delta:30, score:76 },
  { delay: 14700, category:'URGENCY_PRESSURE',  severity:'HIGH',     evidence:'You will be arrested unless you pay immediately', delta:12, score:88 },
  { delay: 16000, speaker:'doris', text:'Gift cards? Oh my, I've never bought one of those. Now what was it called again? Google Play? Is that a card you get at the grocery store? Let me ask my neighbor Ethel, she might know…' },
  { delay: 21000, speaker:'scammer', text:'Do NOT hang up! Do NOT tell anyone about this call. To access your computer to clear the virus we need you to download AnyDesk.' },
  { delay: 23000, category:'REMOTE_ACCESS',    severity:'CRITICAL', evidence:'download AnyDesk to access your computer', delta:10, score:98 },
  { delay: 23200, category:'URGENCY_PRESSURE', severity:'HIGH',     evidence:'Do NOT hang up! Do NOT tell anyone', delta:2,  score:100 },
  { delay: 26000, speaker:'doris', text:'AnyDesk? Oh that sounds complicated. You know, I think my son Gerald could help with all this. He's just at Costco, should be back in about 40 minutes… can you hold on dear?' },
];

function _runDemoSimulation() {
  DEMO_EVENTS.forEach(ev => {
    setTimeout(() => {
      if (!state.sessionId) return;

      if (ev.speaker) {
        _addTranscriptBubble(ev.speaker, ev.text, ev.speaker === 'scammer' ? _highlightFraud(ev.text) : undefined);
        if (ev.speaker === 'scammer') {
          updateWaveform(0.4 + Math.random() * 0.3);
        }
      }

      if (ev.category) {
        window.PhishGuardEvents.dispatchEvent(new CustomEvent('threatEvent', { detail: {
          eventId: 'demo-' + Date.now(),
          sessionId: state.sessionId,
          category: ev.category,
          severity: ev.severity,
          evidence_snippet: ev.evidence,
          threat_score_delta: ev.delta,
          timestamp: Date.now(),
        }}));
        window.PhishGuardEvents.dispatchEvent(new CustomEvent('sessionUpdate', { detail: {
          sessionId: state.sessionId,
          threat_score: ev.score,
          total_events: state.totalEvents,
          caller_profile: {
            claimed_organization: 'Social Security Administration',
            claimed_agent_name: 'Officer David Johnson',
            scam_script_type: 'social_security',
            callback_number: '+1 (202) 555-0147',
          },
        }}));
      }
    }, ev.delay);
  });

  // Demo grounding result after 15s
  setTimeout(() => {
    if (!state.sessionId) return;
    window.PhishGuardEvents.dispatchEvent(new CustomEvent('groundingResult', { detail: {
      eventId: 'demo-gr-1',
      sessionId: state.sessionId,
      result: {
        query: 'is 202-555-0147 a scam phone number Social Security',
        verified: false,
        risk_level: 'HIGH_RISK',
        source_url: 'https://800notes.com/Phone.aspx/1-202-555-0147',
        snippet: 'This number has been reported 147 times as a Social Security Administration impersonation scam. Do not engage with callers from this number.',
        raw_results: [],
      },
    }}));
  }, 15000);
}
