/**
 * firestore-listener.js
 * ─────────────────────
 * Subscribes to Firestore real-time snapshots for the active call session.
 * Pushes events to the UI via a custom EventTarget interface so that the
 * rest of the app stays decoupled from Firebase.
 *
 * Events emitted on `window.PhishGuardEvents`:
 *   "threatEvent"        — new threat event document added
 *   "sessionUpdate"      — session document changed (score, profile, etc.)
 *   "groundingResult"    — grounding result attached to an event
 */

import { initializeApp }           from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore,
         doc, collection,
         onSnapshot, query,
         orderBy, limit }          from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── Global Event Bus ──────────────────────────────────────────────────────────
window.PhishGuardEvents = new EventTarget();

let _db             = null;
let _sessionUnsub   = null;
let _eventsUnsub    = null;
let _currentSession = null;


// ── Initialise Firebase ───────────────────────────────────────────────────────

export function initFirebase(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  _db = getFirestore(app);
  console.log('[FirestoreListener] Firebase initialised');
}


// ── Subscribe to a call session ───────────────────────────────────────────────

export function subscribeToSession(sessionId) {
  if (!_db) {
    console.warn('[FirestoreListener] Firebase not initialised');
    return;
  }

  // Unsubscribe any previous listeners
  stopListening();
  _currentSession = sessionId;

  // ── Session document ──────────────────────────────────────────────────────
  const sessionRef = doc(_db, 'calls', sessionId);
  _sessionUnsub = onSnapshot(sessionRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();

    window.PhishGuardEvents.dispatchEvent(
      new CustomEvent('sessionUpdate', { detail: { sessionId, ...data } })
    );
  });

  // ── Events sub-collection ─────────────────────────────────────────────────
  const eventsRef = collection(_db, 'calls', sessionId, 'events');
  const eventsQuery = query(eventsRef, orderBy('timestamp', 'asc'), limit(200));

  const seen = new Set();

  _eventsUnsub = onSnapshot(eventsQuery, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const eventId = change.doc.id;
      if (seen.has(eventId)) return;
      seen.add(eventId);

      const data = change.doc.data();

      // Threat event
      window.PhishGuardEvents.dispatchEvent(
        new CustomEvent('threatEvent', {
          detail: {
            eventId,
            sessionId,
            category:          data.category        ?? 'UNKNOWN',
            severity:          data.severity         ?? 'LOW',
            evidence_snippet:  data.evidence_snippet ?? '',
            threat_score_delta:data.threat_score_delta ?? 0,
            grounding_query:   data.grounding_query  ?? null,
            grounding_result:  data.grounding_result ?? null,
            timestamp:         data.timestamp?.toMillis() ?? Date.now(),
          },
        })
      );

      // If grounding result already present at insert time
      if (data.grounding_result) {
        window.PhishGuardEvents.dispatchEvent(
          new CustomEvent('groundingResult', {
            detail: { eventId, sessionId, result: data.grounding_result },
          })
        );
      }
    });

    // Watch for grounding results added later (update events)
    snap.docChanges().forEach((change) => {
      if (change.type !== 'modified') return;
      const data = change.doc.data();
      if (data.grounding_result) {
        window.PhishGuardEvents.dispatchEvent(
          new CustomEvent('groundingResult', {
            detail: {
              eventId: change.doc.id,
              sessionId,
              result:  data.grounding_result,
            },
          })
        );
      }
    });
  });

  console.log('[FirestoreListener] Subscribed to session:', sessionId);
}


// ── Unsubscribe ───────────────────────────────────────────────────────────────

export function stopListening() {
  if (_sessionUnsub) { _sessionUnsub(); _sessionUnsub = null; }
  if (_eventsUnsub)  { _eventsUnsub();  _eventsUnsub  = null; }
  _currentSession = null;
}
