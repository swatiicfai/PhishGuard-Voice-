/**
 * threat-visualizer.js
 * ─────────────────────
 * Canvas-based visual effects for the threat dashboard:
 *   1. Waveform oscilloscope (live microphone input level)
 *   2. Threat score radial arc gauge (SVG-driven)
 *   3. Particle burst effect on HIGH / CRITICAL threat detection
 */


// ── 1. WAVEFORM OSCILLOSCOPE ──────────────────────────────────────────────────

const WAVEFORM_HISTORY_SIZE = 120;
const waveHistory = new Array(WAVEFORM_HISTORY_SIZE).fill(0);
let   waveRaf    = null;
let   waveCanvas = null;
let   waveCtx2d  = null;
let   waveActive = false;

export function initWaveform(canvasEl) {
  waveCanvas = canvasEl;
  waveCtx2d  = canvasEl.getContext('2d');
  _resizeWaveCanvas();
  window.addEventListener('resize', _resizeWaveCanvas);
}

export function updateWaveform(rmsLevel) {
  waveHistory.push(rmsLevel);
  if (waveHistory.length > WAVEFORM_HISTORY_SIZE) waveHistory.shift();
}

export function startWaveformAnimation() {
  waveActive = true;
  _animateWaveform();
}

export function stopWaveformAnimation() {
  waveActive = false;
  if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null; }
  if (waveCtx2d && waveCanvas) {
    waveCtx2d.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  }
}

function _animateWaveform() {
  if (!waveActive) return;

  const ctx = waveCtx2d;
  const w   = waveCanvas.width;
  const h   = waveCanvas.height;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = 'rgba(3, 7, 18, 0.0)';
  ctx.fillRect(0, 0, w, h);

  // Draw the waveform bars
  const barWidth  = w / WAVEFORM_HISTORY_SIZE;
  const midY      = h / 2;

  waveHistory.forEach((level, i) => {
    const barH = Math.max(2, level * h * 2.5);
    const x    = i * barWidth;

    // Colour gradient by amplitude
    const intensity = Math.min(1, level * 4);
    const r = Math.round(79  + intensity * 160);
    const g = Math.round(143 + intensity * (-100));
    const b = Math.round(255 + intensity * (-210));

    ctx.fillStyle = `rgba(${r},${g},${b},${0.6 + intensity * 0.4})`;
    ctx.beginPath();
    ctx.roundRect(x + 1, midY - barH / 2, barWidth - 2, barH, 2);
    ctx.fill();
  });

  waveRaf = requestAnimationFrame(_animateWaveform);
}

function _resizeWaveCanvas() {
  if (!waveCanvas) return;
  const rect = waveCanvas.parentElement.getBoundingClientRect();
  waveCanvas.width  = rect.width;
  waveCanvas.height = rect.height;
}


// ── 2. THREAT SCORE RADIAL GAUGE ─────────────────────────────────────────────

const GAUGE_CONFIG = {
  cx: 100, cy: 110, r: 85,
  startAngle: Math.PI,          // left
  endAngle:   2 * Math.PI,      // right (semicircle)
  strokeWidth: 12,
};

let gaugeSvg    = null;
let gaugeArc    = null;
let gaugeTrack  = null;
let gaugeNumber = null;
let gaugeBadge  = null;
let _currentScore = 0;
let _targetScore  = 0;
let gaugeRaf      = null;

export function initGauge(svgEl, numberEl, badgeEl) {
  gaugeSvg    = svgEl;
  gaugeNumber = numberEl;
  gaugeBadge  = badgeEl;

  const { cx, cy, r, strokeWidth } = GAUGE_CONFIG;
  svgEl.setAttribute('viewBox', `0 0 200 120`);
  svgEl.setAttribute('width',  '200');
  svgEl.setAttribute('height', '120');

  // Track arc
  gaugeTrack = _makePath('rgba(99,135,255,0.12)', strokeWidth);
  gaugeTrack.setAttribute('d', _describeArc(cx, cy, r, 180, 360));
  svgEl.appendChild(gaugeTrack);

  // Value arc
  gaugeArc = _makePath(null, strokeWidth);
  gaugeArc.setAttribute('d', _describeArc(cx, cy, r, 180, 180)); // start empty
  gaugeArc.style.filter = 'drop-shadow(0 0 6px currentColor)';
  svgEl.appendChild(gaugeArc);

  _applyGaugeColour(0);
}

export function setThreatScore(score) {
  _targetScore = Math.max(0, Math.min(100, score));
  if (!gaugeRaf) _animateGauge();
}

function _animateGauge() {
  const diff = _targetScore - _currentScore;
  if (Math.abs(diff) < 0.5) {
    _currentScore = _targetScore;
    gaugeRaf = null;
    _renderGauge(_currentScore);
    return;
  }
  _currentScore += diff * 0.1;
  _renderGauge(_currentScore);
  gaugeRaf = requestAnimationFrame(_animateGauge);
}

function _renderGauge(score) {
  if (!gaugeArc) return;
  const endDeg = 180 + (score / 100) * 180;
  gaugeArc.setAttribute('d', _describeArc(
    GAUGE_CONFIG.cx, GAUGE_CONFIG.cy, GAUGE_CONFIG.r, 180, endDeg
  ));
  _applyGaugeColour(score);
  if (gaugeNumber) gaugeNumber.textContent = Math.round(score);
}

function _applyGaugeColour(score) {
  let colour, level, levelClass;
  if      (score < 20)  { colour='#22c55e'; level='SAFE';     levelClass='safe'; }
  else if (score < 45)  { colour='#84cc16'; level='LOW';      levelClass='low'; }
  else if (score < 65)  { colour='#f59e0b'; level='MODERATE'; levelClass='medium'; }
  else if (score < 85)  { colour='#f97316'; level='HIGH';     levelClass='high'; }
  else                  { colour='#ef4444'; level='CRITICAL';  levelClass='critical'; }

  if (gaugeArc)    { gaugeArc.style.stroke = colour; gaugeArc.style.color = colour; }
  if (gaugeNumber) { gaugeNumber.style.color = colour; }
  if (gaugeBadge) {
    gaugeBadge.textContent = level;
    gaugeBadge.className   = `threat-level-badge ${levelClass}`;
  }
}

function _makePath(stroke, width) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke-width', String(width));
  p.setAttribute('stroke-linecap', 'round');
  if (stroke) p.setAttribute('stroke', stroke);
  return p;
}

function _describeArc(cx, cy, r, startDeg, endDeg) {
  const s = _polar(cx, cy, r, startDeg);
  const e = _polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

function _polar(cx, cy, r, deg) {
  const rad = (deg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}


// ── 3. PARTICLE BURST ─────────────────────────────────────────────────────────

let particleCanvas = null;
let particleCtx    = null;
const particles    = [];
let   particleRaf  = null;

export function initParticles(canvasEl) {
  particleCanvas = canvasEl;
  particleCtx    = canvasEl.getContext('2d');
  _resizeParticleCanvas();
  window.addEventListener('resize', _resizeParticleCanvas);
  _animateParticles();
}

export function burstParticles(severity) {
  if (!particleCanvas) return;
  const w = particleCanvas.width;
  const h = particleCanvas.height;

  const count  = severity === 'CRITICAL' ? 60 : severity === 'HIGH' ? 35 : 20;
  const colour = severity === 'CRITICAL' ? '#ef4444'
               : severity === 'HIGH'     ? '#f97316'
               : '#f59e0b';

  // Emit from a random point near the centre-right (threat panel area)
  const ox = w * 0.80 + (Math.random() - 0.5) * 80;
  const oy = h * 0.20 + Math.random() * 40;

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 4;
    particles.push({
      x: ox, y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      life: 1.0,
      decay: 0.018 + Math.random() * 0.02,
      radius: 2 + Math.random() * 3,
      colour,
    });
  }
}

function _animateParticles() {
  particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x    += p.vx;
    p.y    += p.vy;
    p.vy   += 0.12;          // gravity
    p.life -= p.decay;

    if (p.life <= 0) { particles.splice(i, 1); continue; }

    particleCtx.globalAlpha = p.life;
    particleCtx.fillStyle   = p.colour;
    particleCtx.shadowColor = p.colour;
    particleCtx.shadowBlur  = 6;
    particleCtx.beginPath();
    particleCtx.arc(p.x, p.y, p.radius * p.life, 0, Math.PI * 2);
    particleCtx.fill();
  }

  particleCtx.globalAlpha = 1;
  particleCtx.shadowBlur  = 0;
  particleRaf = requestAnimationFrame(_animateParticles);
}

function _resizeParticleCanvas() {
  if (!particleCanvas) return;
  particleCanvas.width  = window.innerWidth;
  particleCanvas.height = window.innerHeight;
}
