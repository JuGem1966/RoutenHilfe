/* ===========================================================
   Routenplaner & Live-Begleiter
   Komplett lokal im Browser (kein Server, keine Cloud-Sync).
   =========================================================== */

const STORAGE_KEY = 'routePlannerState_v1';

/** @type {{stops: Array, routeStarted: boolean, currentIndex: number, notified10min: Object, soundOn: boolean}} */
let state = {
  stops: [],
  routeStartTime: '', // geplante Gesamt-Abfahrt (HH:MM), wird auf den ersten Haltepunkt übertragen
  routeStarted: false,
  currentIndex: 0,
  notified10min: {},
  soundOn: true,
  gpsOn: false
};

let gpsWatchId = null;
let gpsLastSuggestedStopId = null; // verhindert wiederholtes Aufpoppen für denselben Halt nach "Noch nicht"

// ---------- Persistenz ----------

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = Object.assign(state, parsed);
    }
  } catch (e) { /* ignore */ }
}

// ---------- Zeit-Hilfsfunktionen ----------

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToTime(mins) {
  if (mins === null || mins === undefined || isNaN(mins)) return '';
  let m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ---------- Google Maps Link parsen ----------

function parseMapsUrl(url) {
  if (!url || !url.trim()) return { ok: false, message: 'Bitte einen Link einfügen.' };

  let cleaned = url.trim();

  if (cleaned.includes('goo.gl') || cleaned.includes('maps.app.goo.gl')) {
    return {
      ok: false,
      message: 'Das ist ein Kurzlink. Bitte in Google Maps auf "Link kopieren" für die volle Adresse (mit "/maps/dir/...") warten, oder die Haltepunkte unten manuell eintragen.'
    };
  }

  const marker = '/maps/dir/';
  const idx = cleaned.indexOf(marker);
  if (idx === -1) {
    return {
      ok: false,
      message: 'Konnte in diesem Link keine Route (mit mehreren Haltepunkten) finden. Bitte sicherstellen, dass es ein Routen-Link ist ("/maps/dir/...."), oder Haltepunkte manuell hinzufügen.'
    };
  }

  let rest = cleaned.substring(idx + marker.length);
  // Query-String abschneiden
  const qIdx = rest.indexOf('?');
  if (qIdx !== -1) rest = rest.substring(0, qIdx);

  const segments = rest.split('/');
  const names = [];
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.startsWith('@')) break; // Kartenansicht-Parameter, Ende der Stopps
    if (seg.startsWith('data=')) break;
    let decoded = seg;
    try { decoded = decodeURIComponent(seg.replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
    names.push(decoded);
  }

  if (names.length < 2) {
    return { ok: false, message: 'Es wurden weniger als zwei Haltepunkte gefunden. Bitte Haltepunkte manuell ergänzen.' };
  }

  return { ok: true, names };
}

function makeStop(name) {
  return {
    id: 'stop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name,
    travelMin: '',   // Fahrzeit von vorigem Halt (Minuten) - manuell oder automatisch berechnet
    travelKm: null,  // Distanz von vorigem Halt (km) - nur informativ, automatisch berechnet
    geo: null,       // {lat, lon, displayName} - Ergebnis der letzten Geokodierung
    planArr: '',
    planDur: '',
    planDep: '',
    arrAuto: true,   // true = Ankunft wird automatisch aus der Kette berechnet; false = manuell fixiert
    depAuto: true,   // true = Abfahrt wird automatisch aus Ankunft+Aufenthalt berechnet; false = manuell fixiert
    actualArr: null,
    actualDep: null,
    status: 'pending' // pending -> arrived -> departed
  };
}

// Rechnet die komplette Zeit-Kette durchgehend neu: ausgehend von der Abfahrt
// des jeweils vorigen Haltepunkts + Fahrzeit ergibt sich die Ankunft, daraus
// (mit Aufenthalt, ohne Angabe = 0 Min / sofortige Weiterfahrt) die Abfahrt -
// und so weiter für ALLE folgenden Haltepunkte. Manuell fixierte Werte
// (arrAuto/depAuto = false) werden dabei nicht überschrieben, wirken aber
// weiterhin als Startpunkt für die nachfolgenden Berechnungen.
function recalcChain() {
  // Erster Haltepunkt hat keine eingehende Fahrzeit (Start der Route) -
  // dort nur Ankunft/Aufenthalt/Abfahrt untereinander ergänzen, sofern zwei
  // der drei Werte bekannt sind und der jeweils dritte nicht manuell fixiert ist.
  if (state.stops.length > 0) {
    const first = state.stops[0];
    const arr = timeToMinutes(first.planArr);
    const dur = (first.planDur !== '' && first.planDur !== null && first.planDur !== undefined) ? parseInt(first.planDur, 10) : null;
    const dep = timeToMinutes(first.planDep);
    if (first.depAuto !== false && arr !== null && dur !== null && !isNaN(dur)) {
      first.planDep = minutesToTime(arr + dur);
    } else if (first.arrAuto !== false && dur !== null && dep !== null && !isNaN(dur)) {
      first.planArr = minutesToTime(dep - dur);
    } else if ((first.planDur === '' || first.planDur === null || first.planDur === undefined) && arr !== null && dep !== null) {
      let d = dep - arr;
      if (d < 0) d += 1440;
      first.planDur = String(d);
    }
  }

  for (let i = 1; i < state.stops.length; i++) {
    const prev = state.stops[i - 1];
    const cur = state.stops[i];
    const prevDep = timeToMinutes(prev.planDep);
    const travelMin = (cur.travelMin !== '' && cur.travelMin !== null && cur.travelMin !== undefined)
      ? parseInt(cur.travelMin, 10) : null;

    // 1) Ankunft: automatisch aus vorheriger Abfahrt + Fahrzeit, sofern nicht manuell fixiert
    if (cur.arrAuto !== false) {
      if (prevDep !== null && travelMin !== null && !isNaN(travelMin)) {
        cur.planArr = minutesToTime(prevDep + travelMin);
      }
    }

    // 2) Abfahrt: automatisch aus Ankunft + Aufenthalt (fehlender Aufenthalt = 0 Min), sofern nicht manuell fixiert
    if (cur.depAuto !== false) {
      const arrMin = timeToMinutes(cur.planArr);
      const dur = (cur.planDur !== '' && cur.planDur !== null && cur.planDur !== undefined) ? parseInt(cur.planDur, 10) : 0;
      if (arrMin !== null && !isNaN(dur)) {
        cur.planDep = minutesToTime(arrMin + dur);
      }
    } else {
      // Abfahrt ist manuell fixiert: fehlenden Aufenthalt daraus rückrechnen, sofern noch nicht gesetzt
      const arrMin = timeToMinutes(cur.planArr);
      const depMin = timeToMinutes(cur.planDep);
      if (arrMin !== null && depMin !== null && (cur.planDur === '' || cur.planDur === null || cur.planDur === undefined)) {
        let d = depMin - arrMin;
        if (d < 0) d += 1440;
        cur.planDur = String(d);
      }
    }
  }
}

// ---------- Planungs-Tabelle rendern ----------

function renderStopsTable() {
  const tbody = document.getElementById('stops-tbody');
  tbody.innerHTML = '';
  state.stops.forEach((stop, i) => {
    const tr = document.createElement('tr');
    let travelCell;
    if (i === 0) {
      travelCell = '<span class="hint-inline">– Start –</span>';
    } else {
      const distLabel = (stop.travelKm !== null && stop.travelKm !== undefined) ? `<span class="dist">${Math.round(stop.travelKm)} km</span>` : '';
      travelCell = `<input type="text" inputmode="numeric" pattern="[0-9]*" data-field="travelMin" data-id="${stop.id}" value="${stop.travelMin}" placeholder="Min">${distLabel}`;
    }
    tr.innerHTML = `
      <td class="row-num">${i + 1}</td>
      <td><input type="text" data-field="name" data-id="${stop.id}" value="${escapeHtml(stop.name)}"></td>
      <td class="travel-cell">${travelCell}</td>
      <td><input type="time" data-field="planArr" data-id="${stop.id}" value="${stop.planArr}"></td>
      <td><input type="text" inputmode="numeric" pattern="[0-9]*" data-field="planDur" data-id="${stop.id}" value="${stop.planDur}" placeholder="Min"></td>
      <td><input type="time" data-field="planDep" data-id="${stop.id}" value="${stop.planDep}"></td>
      <td><button class="remove-row-btn" data-remove="${stop.id}" title="Entfernen"><i class="fa-solid fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Event-Bindings Planung ----------

function bindPlanningEvents() {
  document.getElementById('parse-btn').addEventListener('click', () => {
    const url = document.getElementById('maps-url-input').value;
    const result = parseMapsUrl(url);
    const feedback = document.getElementById('parse-feedback');
    if (!result.ok) {
      feedback.textContent = result.message;
      feedback.className = 'feedback error';
      return;
    }
    result.names.forEach(name => state.stops.push(makeStop(name)));
    feedback.textContent = `${result.names.length} Haltepunkte übernommen. Bitte prüfen und ggf. Namen anpassen.`;
    feedback.className = 'feedback ok';
    renderStopsTable();
    saveState();
  });

  document.getElementById('add-stop-btn').addEventListener('click', () => {
    const input = document.getElementById('new-stop-name');
    const name = input.value.trim();
    if (!name) return;
    state.stops.push(makeStop(name));
    input.value = '';
    renderStopsTable();
    saveState();
  });

  document.getElementById('new-stop-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('add-stop-btn').click();
  });

  document.getElementById('stops-tbody').addEventListener('input', (e) => {
    const target = e.target;
    const id = target.getAttribute('data-id');
    const field = target.getAttribute('data-field');
    if (!id || !field) return;
    const idx = state.stops.findIndex(s => s.id === id);
    if (idx === -1) return;
    const stop = state.stops[idx];

    // Bei den reinen Minuten-Feldern (travelMin, planDur) nur Ziffern zulassen,
    // damit hier nicht versehentlich Buchstaben o.ä. landen können.
    let value = target.value;
    if (field === 'travelMin' || field === 'planDur') {
      value = value.replace(/[^0-9]/g, '');
      if (value !== target.value) target.value = value;
    }
    stop[field] = value;

    // Manuell bearbeitete Ankunft/Abfahrt gilt ab jetzt als fixiert (wird bei
    // der Kettenberechnung nicht mehr automatisch überschrieben) - außer das
    // Feld wurde geleert, dann übernimmt die Automatik wieder.
    if (field === 'planArr') {
      stop.arrAuto = (stop.planArr === '');
    }
    if (field === 'planDep') {
      stop.depAuto = (stop.planDep === '');
    }
    if (field === 'planDur') {
      // Neue Aufenthaltsdauer: die daraus berechnete Abfahrt soll wieder automatisch sein,
      // damit die komplette restliche Kette neu durchgerechnet wird.
      stop.depAuto = true;
    }

    // Cursor-Position vor dem Neuaufbau merken (bei Zahlen-Feldern zählt vor
    // allem: Cursor am Ende = weitere Ziffern werden hinten angehängt statt vorne).
    const caretPos = (typeof target.selectionStart === 'number') ? target.selectionStart : null;

    recalcChain();
    renderStopsTable();
    saveState();

    // Fokus + Cursor-Position nach Re-Render wiederherstellen
    const again = document.querySelector(`[data-id="${id}"][data-field="${field}"]`);
    if (again) {
      again.focus();
      if (caretPos !== null && typeof again.setSelectionRange === 'function') {
        const pos = Math.min(caretPos, again.value.length);
        again.setSelectionRange(pos, pos);
      }
    }
  });

  document.getElementById('stops-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const id = btn.getAttribute('data-remove');
    state.stops = state.stops.filter(s => s.id !== id);
    renderStopsTable();
    saveState();
  });

  document.getElementById('route-start-time').addEventListener('input', (e) => {
    state.routeStartTime = e.target.value;
    saveState();
  });

  document.getElementById('apply-start-time-btn').addEventListener('click', () => {
    const val = document.getElementById('route-start-time').value;
    if (!val) {
      alert('Bitte zuerst eine Uhrzeit für die Gesamt-Abfahrt eingeben.');
      return;
    }
    if (state.stops.length === 0) {
      alert('Bitte zuerst mindestens einen Haltepunkt anlegen.');
      return;
    }
    state.routeStartTime = val;
    const first = state.stops[0];
    first.planDep = val;
    first.depAuto = false; // manuell gesetzte Startzeit fixieren, damit sie nicht überschrieben wird
    recalcChain();
    renderStopsTable();
    saveState();
  });

  document.getElementById('auto-calc-btn').addEventListener('click', calcTravelTimes);

  document.getElementById('start-route-btn').addEventListener('click', startRoute);

  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('Wirklich alles zurücksetzen? Alle Haltepunkte und Zeiten gehen verloren.')) return;
    stopGpsWatch();
    state = { stops: [], routeStartTime: '', routeStarted: false, currentIndex: 0, notified10min: {}, soundOn: true, gpsOn: false };
    saveState();
    location.reload();
  });

  document.getElementById('sound-toggle').addEventListener('change', (e) => {
    state.soundOn = e.target.checked;
    saveState();
  });

  document.getElementById('gps-toggle').addEventListener('change', (e) => {
    state.gpsOn = e.target.checked;
    saveState();
  });

  document.getElementById('live-banner-close').addEventListener('click', () => {
    document.getElementById('live-banner').classList.add('hidden');
  });

  document.getElementById('save-json-btn').addEventListener('click', saveRouteToFile);

  document.getElementById('load-json-btn').addEventListener('click', () => {
    document.getElementById('load-json-input').click();
  });

  document.getElementById('load-json-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadRouteFromFile(file);
    e.target.value = ''; // erlaubt erneutes Laden derselben Datei
  });
}

// ---------- Route als JSON-Datei speichern / laden ----------

function saveRouteToFile() {
  const feedback = document.getElementById('save-load-feedback');
  try {
    const exportData = {
      appName: 'Routenplaner & Live-Begleiter',
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      state: state
    };
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    a.href = url;
    a.download = `route-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    feedback.textContent = 'Route wurde als Datei gespeichert (Download-Ordner deines Geräts).';
    feedback.className = 'feedback ok';
  } catch (e) {
    feedback.textContent = 'Speichern fehlgeschlagen: ' + e.message;
    feedback.className = 'feedback error';
  }
}

function loadRouteFromFile(file) {
  const feedback = document.getElementById('save-load-feedback');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const loadedState = parsed && parsed.state ? parsed.state : parsed; // auch rohe State-Objekte akzeptieren
      if (!loadedState || !Array.isArray(loadedState.stops)) {
        throw new Error('Datei enthält keine gültige Routen-Struktur.');
      }
      stopGpsWatch();
      state = Object.assign({
        stops: [], routeStartTime: '', routeStarted: false, currentIndex: 0,
        notified10min: {}, soundOn: true, gpsOn: false
      }, loadedState);
      saveState();
      const willJumpToLive = state.routeStarted && state.stops.length > 0;
      applyStateToUI();
      const msg = `Route mit ${state.stops.length} Haltepunkten erfolgreich geladen.`;
      if (willJumpToLive) {
        // Planungs-Bereich (und damit die Feedback-Zeile) wird sofort ausgeblendet -
        // daher stattdessen kurz sichtbar per Banner bestätigen.
        showBanner('✅ ' + msg);
      } else {
        feedback.textContent = msg;
        feedback.className = 'feedback ok';
      }
    } catch (err) {
      feedback.textContent = 'Datei konnte nicht geladen werden: ' + err.message + '. Bitte eine zuvor mit "Route als Datei speichern" erzeugte Datei verwenden.';
      feedback.className = 'feedback error';
    }
  };
  reader.onerror = () => {
    feedback.textContent = 'Datei konnte nicht gelesen werden.';
    feedback.className = 'feedback error';
  };
  reader.readAsText(file);
}

// ---------- Fahrzeiten automatisch berechnen (Nominatim + OSRM, Open Source) ----------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeName(name) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (networkErr) {
    // fetch() wirft hier bei Netzwerkfehler, CORS-Blockade o.ä. - nicht mit "nicht gefunden" verwechseln
    throw new Error('NETWORK: ' + networkErr.message);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' von Nominatim');
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), displayName: data[0].display_name };
}

// Deutsche Länderbezeichnungen, wie sie Google Maps oft in Adressen einsetzt,
// in international besser erkannte Varianten übersetzen (hilft Nominatim).
const COUNTRY_TRANSLATIONS = {
  'Vereinigtes Königreich': 'United Kingdom',
  'Österreich': 'Austria',
  'Schweiz': 'Switzerland',
  'Deutschland': 'Germany',
  'Italien': 'Italy',
  'Frankreich': 'France',
  'Spanien': 'Spain',
  'Niederlande': 'Netherlands',
  'Vereinigte Staaten': 'United States',
  'Tschechische Republik': 'Czech Republic',
  'Vereinigte Staaten von Amerika': 'United States'
};

function translateCountryNames(text) {
  let out = text;
  Object.keys(COUNTRY_TRANSLATIONS).forEach(de => {
    out = out.split(de).join(COUNTRY_TRANSLATIONS[de]);
  });
  return out;
}

// Aus einem oft sehr spezifischen Google-Maps-Adresstext (mit Postleitzahl,
// evtl. mehreren alternativen Namen getrennt durch "|") mehrere sinnvolle
// Such-Varianten ableiten - von "vollständig" bis "nur der Ortsname" -
// damit Nominatim auch bei sehr spezifischen POI-Adressen etwas findet.
const UK_POSTCODE_REGEX = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/i;

function buildQueryVariants(rawName) {
  let cleaned = rawName.replace(/\|/g, ', ');
  cleaned = cleaned.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  cleaned = translateCountryNames(cleaned);

  const segments = cleaned.split(',').map(s => s.trim()).filter(Boolean);
  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : '';
  const variants = [];
  const add = (v) => { if (v && !variants.includes(v)) variants.push(v); };

  add(cleaned); // 1) vollständige, bereinigte Adresse
  if (segments.length > 1) add(segments[0] + ', ' + lastSeg); // 2) Name + Land
  if (segments.length > 2) add(segments.slice(0, 2).join(', ')); // 3) Name + nächstes Segment (Ort/Region)
  add(segments[0]); // 4) nur der POI-/Ortsname

  // 5) andere mittlere Segmente einzeln + Land versuchen - manchmal ist nicht das
  //    erste Segment der bei Nominatim bekannte POI-Name, sondern ein späteres
  //    (z.B. "The Highland Club" statt "The Highland Club Official")
  for (let i = 1; i < segments.length - 1; i++) {
    add(segments[i] + (lastSeg ? ', ' + lastSeg : ''));
  }

  // 6) letzter Ausweg: nur Postleitzahl + Land - liefert zumindest eine
  //    ungefähre, aber ausreichend genaue Position für die Fahrzeit-Berechnung
  const pcMatch = cleaned.match(UK_POSTCODE_REGEX);
  if (pcMatch) {
    add(pcMatch[0] + (lastSeg && lastSeg !== pcMatch[0] ? ', ' + lastSeg : ''));
  }

  return variants;
}

// Versucht die Such-Varianten nacheinander, bis eine einen Treffer liefert.
// Gibt zusätzlich zurück, welche Variante erfolgreich war (für Transparenz).
async function geocodeWithFallback(rawName) {
  const variants = buildQueryVariants(rawName);
  let lastErr = null;
  for (let i = 0; i < variants.length; i++) {
    try {
      const geo = await geocodeName(variants[i]);
      if (geo) return { geo, usedQuery: variants[i], variantIndex: i, totalVariants: variants.length };
    } catch (e) {
      if (String(e.message).startsWith('NETWORK:')) throw e; // Netzwerkfehler sofort durchreichen
      lastErr = e;
    }
    if (i < variants.length - 1) await sleep(1100); // Nominatim-Nutzungsrichtlinie: max. ca. 1 Anfrage/Sekunde
  }
  return null; // keine Variante hat etwas gefunden
}

function applyTravelSuggestions() {
  // Fahrzeiten sind jetzt gesetzt - komplette Kette (Ankunft/Abfahrt aller
  // Haltepunkte) einmal durchgehend neu berechnen.
  recalcChain();
}

async function calcTravelTimes() {
  const btn = document.getElementById('auto-calc-btn');
  const feedback = document.getElementById('auto-calc-feedback');

  if (state.stops.length < 2) {
    feedback.textContent = 'Bitte mindestens zwei Haltepunkte anlegen, bevor Fahrzeiten berechnet werden können.';
    feedback.className = 'feedback error';
    return;
  }

  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  feedback.className = 'feedback';

  const coords = [];
  const failed = [];
  const simplified = [];
  let networkProblem = false;

  for (let i = 0; i < state.stops.length; i++) {
    const stop = state.stops[i];
    btn.innerHTML = `<span class="geo-spinner"></span> Löse Adresse ${i + 1}/${state.stops.length} auf …`;
    feedback.textContent = `Suche Position von "${stop.name}" …`;
    try {
      const result = await geocodeWithFallback(stop.name);
      if (!result) {
        failed.push(stop.name);
        coords.push(null);
      } else {
        stop.geo = result.geo;
        coords.push(result.geo);
        if (result.variantIndex > 0) {
          simplified.push(`${stop.name.split(',')[0].trim()} → "${result.usedQuery}"`);
        }
      }
    } catch (e) {
      if (String(e.message).startsWith('NETWORK:')) networkProblem = true;
      failed.push(stop.name + ' (' + e.message + ')');
      coords.push(null);
    }
    // Nominatim-Nutzungsrichtlinie: max. ca. 1 Anfrage/Sekunde
    if (i < state.stops.length - 1) await sleep(1100);
  }

  if (networkProblem) {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    feedback.textContent = 'Die Adress-Suche (nominatim.openstreetmap.org) konnte nicht erreicht werden – vermutlich blockiert diese Vorschau-Umgebung externe Netzwerk-Anfragen, oder es liegt ein Verbindungsproblem vor. Bitte auf der veröffentlichten/live Seite in einem normalen Browser-Tab erneut versuchen, oder Fahrzeiten manuell eintragen.';
    feedback.className = 'feedback error';
    return;
  }

  if (failed.length > 0) {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    feedback.textContent = `Adresse(n) nicht gefunden: ${failed.join(', ')}. Bitte Namen präzisieren (z. B. Stadt/Land ergänzen) und erneut versuchen.`;
    feedback.className = 'feedback error';
    return;
  }

  btn.innerHTML = '<span class="geo-spinner"></span> Berechne Fahrzeiten …';
  feedback.textContent = 'Berechne Fahrzeiten über OSRM (OpenStreetMap-Routing) …';

  try {
    const coordStr = coords.map(c => `${c.lon},${c.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=false`;
    let res;
    try {
      res = await fetch(url);
    } catch (networkErr) {
      throw new Error('NETWORK: Der Routenserver (router.project-osrm.org) war nicht erreichbar – ' + networkErr.message);
    }
    if (!res.ok) throw new Error('Routing-Anfrage fehlgeschlagen (HTTP ' + res.status + ')');
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
      throw new Error('Keine Route gefunden (Antwortcode: ' + data.code + ')');
    }
    const legs = data.routes[0].legs;
    let totalMin = 0, totalKm = 0;
    for (let i = 0; i < legs.length; i++) {
      const mins = Math.max(1, Math.round(legs[i].duration / 60));
      const km = legs[i].distance / 1000;
      state.stops[i + 1].travelMin = String(mins);
      state.stops[i + 1].travelKm = km;
      totalMin += mins;
      totalKm += km;
    }
    applyTravelSuggestions();
    renderStopsTable();
    saveState();
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    let msg = `Fertig: ca. ${Math.round(totalKm)} km, ${h > 0 ? h + ' Std ' : ''}${m} Min reine Fahrzeit (Schätzung ohne Live-Verkehr). Leere Ankunftszeiten wurden automatisch vorgeschlagen – bitte prüfen und bei Bedarf anpassen.`;
    if (simplified.length > 0) {
      msg += ` Hinweis: Bei folgenden Haltepunkten wurde die genaue Adresse nicht gefunden, stattdessen ein vereinfachter Suchbegriff verwendet (bitte Position bei Bedarf prüfen): ${simplified.join(' · ')}.`;
    }
    feedback.textContent = msg;
    feedback.className = 'feedback ok';
  } catch (e) {
    feedback.textContent = 'Fahrzeit-Berechnung fehlgeschlagen: ' + e.message + '. Bitte später erneut versuchen oder Fahrzeiten manuell eintragen.';
    feedback.className = 'feedback error';
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ---------- Route starten ----------

function startRoute() {
  if (state.stops.length < 2) {
    alert('Bitte mindestens zwei Haltepunkte anlegen, bevor die Route gestartet wird.');
    return;
  }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  state.routeStarted = true;
  state.currentIndex = 0;
  state.notified10min = {};
  saveState();

  document.getElementById('import-section').classList.add('hidden');
  document.getElementById('planning-section').classList.add('hidden');
  document.getElementById('execution-section').classList.remove('hidden');
  document.getElementById('overview-section').classList.remove('hidden');

  renderExecution();
  renderOverview();
  startReminderLoop();

  if (state.gpsOn) startGpsWatch();
}

// ---------- Ausführung / Live-Begleitung ----------

function getTargetDeparture(stop) {
  // Liefert { minutes, source } - geplanter Zielabfahrts-Zeitpunkt in Minuten (heute), oder null.
  const planArr = timeToMinutes(stop.planArr);
  const planDur = stop.planDur !== '' && stop.planDur !== null ? parseInt(stop.planDur, 10) : null;
  const planDep = timeToMinutes(stop.planDep);

  if (planDep !== null) {
    return { minutes: planDep, source: 'fixed' };
  }
  if (planArr !== null && planDur !== null) {
    return { minutes: planArr + planDur, source: 'fixed' };
  }
  if (planDur !== null && stop.actualArr !== null) {
    const actualArrMin = timeToMinutes(stop.actualArr);
    return { minutes: actualArrMin + planDur, source: 'relative' };
  }
  return null;
}

function renderExecution() {
  const container = document.getElementById('current-stop-card');
  const i = state.currentIndex;

  if (i >= state.stops.length) {
    container.innerHTML = `
      <h3><i class="fa-solid fa-flag-checkered"></i> Route abgeschlossen!</h3>
      <p class="status-line">Alle Haltepunkte wurden abgefahren. Gute Fahrt war's! 🎉</p>
    `;
    renderOverview();
    return;
  }

  const stop = state.stops[i];
  const isLast = i === state.stops.length - 1;
  let html = `<h3>${escapeHtml(stop.name)} <span style="font-size:.75rem;color:#64748b;font-weight:400;">(Halt ${i + 1} von ${state.stops.length})</span></h3>`;

  if (stop.status === 'pending') {
    html += `<p class="status-line info">Geplante Ankunft: ${stop.planArr || '– nicht geplant –'}</p>`;
    html += `<div class="actions"><button class="btn btn-primary" id="arrive-btn"><i class="fa-solid fa-location-dot"></i> Jetzt hier angekommen</button></div>`;
  } else if (stop.status === 'arrived') {
    // Ankunfts-Kommentar
    const planArrMin = timeToMinutes(stop.planArr);
    const actualArrMin = timeToMinutes(stop.actualArr);
    if (planArrMin !== null) {
      const diff = actualArrMin - planArrMin;
      if (diff === 0) {
        html += `<p class="status-line info">Ankunft ${stop.actualArr} Uhr – genau wie geplant.</p>`;
      } else if (diff < 0) {
        html += `<p class="status-line early">Ankunft ${stop.actualArr} Uhr – ${Math.abs(diff)} Minute${Math.abs(diff)===1?'':'n'} früher als geplant.</p>`;
      } else {
        html += `<p class="status-line late">Ankunft ${stop.actualArr} Uhr – ${diff} Minute${diff===1?'':'n'} später als geplant.</p>`;
      }
    } else {
      html += `<p class="status-line info">Ankunft ${stop.actualArr} Uhr – keine geplante Ankunftszeit hinterlegt.</p>`;
    }

    if (isLast) {
      html += `<p class="status-line info"><i class="fa-solid fa-flag-checkered"></i> Das ist der letzte Haltepunkt – Ziel erreicht!</p>`;
      html += `<div class="actions"><button class="btn btn-success" id="finish-btn"><i class="fa-solid fa-check"></i> Route beenden</button></div>`;
    } else {
      const target = getTargetDeparture(stop);
      if (target) {
        const stayMin = target.minutes - actualArrMin;
        const depTimeStr = minutesToTime(target.minutes);
        if (target.source === 'fixed') {
          html += `<p class="status-line">Du musst um <strong>${depTimeStr} Uhr</strong> abfahren – das sind noch ca. <strong>${stayMin >= 0 ? stayMin : 0} Minuten</strong> Aufenthaltszeit ab jetzt.</p>`;
        } else {
          html += `<p class="status-line">Du hast <strong>${stop.planDur} Minuten</strong> Aufenthaltszeit geplant – das ergibt eine Abfahrt um ca. <strong>${depTimeStr} Uhr</strong>.</p>`;
        }
        html += `<p class="countdown" id="countdown-text"></p>`;
      } else {
        html += `<p class="status-line info">Für diesen Halt ist keine Aufenthaltszeit geplant.</p>`;
      }
      html += `<div class="actions"><button class="btn btn-success" id="depart-btn"><i class="fa-solid fa-car-side"></i> Jetzt losfahren</button></div>`;
    }
  }

  container.innerHTML = html;

  const arriveBtn = document.getElementById('arrive-btn');
  if (arriveBtn) arriveBtn.addEventListener('click', () => {
    stop.actualArr = nowHHMM();
    stop.status = 'arrived';
    saveState();
    hideGpsSuggestion();
    renderExecution();
    renderOverview();
  });

  const departBtn = document.getElementById('depart-btn');
  if (departBtn) departBtn.addEventListener('click', () => {
    stop.actualDep = nowHHMM();
    stop.status = 'departed';
    saveState();
    state.currentIndex++;
    saveState();
    gpsLastSuggestedStopId = null;
    hideGpsSuggestion();
    renderExecution();
    renderOverview();
  });

  const finishBtn = document.getElementById('finish-btn');
  if (finishBtn) finishBtn.addEventListener('click', () => {
    state.currentIndex = state.stops.length;
    saveState();
    renderExecution();
    renderOverview();
  });

  updateCountdown();
}

function updateCountdown() {
  const el = document.getElementById('countdown-text');
  if (!el) return;
  const i = state.currentIndex;
  const stop = state.stops[i];
  if (!stop || stop.status !== 'arrived') return;
  const target = getTargetDeparture(stop);
  if (!target) return;
  const remaining = target.minutes - nowMinutes();
  if (remaining > 0) {
    el.textContent = `Noch ca. ${remaining} Minute${remaining===1?'':'n'} bis zur geplanten Abfahrt.`;
  } else if (remaining === 0) {
    el.textContent = `Geplante Abfahrtszeit ist jetzt!`;
  } else {
    el.textContent = `Geplante Abfahrtszeit ist ${Math.abs(remaining)} Minute${Math.abs(remaining)===1?'':'n'} überschritten.`;
  }
}

// ---------- Übersicht ----------

function renderOverview() {
  const list = document.getElementById('overview-list');
  list.innerHTML = '';
  state.stops.forEach((stop, i) => {
    const li = document.createElement('li');
    let icon = '<i class="fa-regular fa-circle"></i>';
    let cls = '';
    if (stop.status === 'departed' || i < state.currentIndex) {
      icon = '<i class="fa-solid fa-circle-check" style="color:#16a34a;"></i>';
      cls = 'done';
    } else if (i === state.currentIndex && state.routeStarted) {
      icon = '<i class="fa-solid fa-location-dot" style="color:#2563eb;"></i>';
      cls = 'current';
    }
    li.className = cls;
    const times = [
      stop.planArr ? `Ankunft geplant ${stop.planArr}` : '',
      stop.planDep ? `Abfahrt geplant ${stop.planDep}` : '',
      stop.actualArr ? `an: ${stop.actualArr}` : '',
      stop.actualDep ? `ab: ${stop.actualDep}` : ''
    ].filter(Boolean).join(' · ');
    li.innerHTML = `<span class="ov-icon">${icon}</span><span class="ov-name">${escapeHtml(stop.name)}</span><span class="ov-times">${times}</span>`;
    list.appendChild(li);
  });
}

// ---------- Erinnerung 10 Minuten vor Abfahrt ----------

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 350);
  } catch (e) { /* ignore */ }
}

function showBanner(text) {
  const banner = document.getElementById('live-banner');
  document.getElementById('live-banner-text').textContent = text;
  banner.classList.remove('hidden');
  if (state.soundOn) playBeep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Routenplaner', { body: text });
  }
}

function startReminderLoop() {
  setInterval(() => {
    updateCountdown();

    const i = state.currentIndex;
    const stop = state.stops[i];
    if (!stop || stop.status !== 'arrived') return;
    const isLast = i === state.stops.length - 1;
    if (isLast) return;

    const target = getTargetDeparture(stop);
    if (!target) return;

    const remaining = target.minutes - nowMinutes();
    const key = stop.id;
    if (remaining <= 10 && remaining > 0 && !state.notified10min[key]) {
      state.notified10min[key] = true;
      saveState();
      showBanner(`⏰ ${stop.name}: Du musst um ${minutesToTime(target.minutes)} Uhr abfahren – noch ${remaining} Minuten Aufenthaltszeit!`);
    }
    if (remaining <= 0 && !state.notified10min[key + '_due']) {
      state.notified10min[key + '_due'] = true;
      saveState();
      showBanner(`🚗 ${stop.name}: Die geplante Abfahrtszeit ist jetzt erreicht!`);
    }
  }, 15000);
}

// ---------- GPS-gestützte Ankunfts-Erkennung (Vorschlag mit Bestätigung) ----------
//
// Nutzt die Browser-Geolocation-API (funktioniert nur, solange dieser Tab
// offen ist; bei manchen Mobilgeräten pausiert die Ortung bei gesperrtem
// Bildschirm oder im Hintergrund). Es wird NIE automatisch der Status auf
// "angekommen" gesetzt - stattdessen erscheint ein Vorschlag, den man
// bestätigen oder ablehnen kann. Das verhindert Fehlauslösungen (z. B. beim
// bloßen Vorbeifahren) und lässt dich die Kontrolle behalten.

const GPS_ARRIVAL_RADIUS_METERS = 300; // Umkreis, ab dem ein Ankunfts-Vorschlag erscheint

// Haversine-Formel: Entfernung zwischen zwei Koordinaten in Metern
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function setGpsStatus(text, cls) {
  const el = document.getElementById('gps-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint-inline gps-status' + (cls ? ' ' + cls : '');
}

function startGpsWatch() {
  if (!('geolocation' in navigator)) {
    setGpsStatus('⚠️ Dieses Gerät/Browser unterstützt keine Standort-Erkennung.', 'error');
    return;
  }
  if (gpsWatchId !== null) return; // läuft schon

  setGpsStatus('📍 Standort-Erkennung aktiv – suche Signal …', '');

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      setGpsStatus('📍 Standort-Erkennung aktiv.', 'active');
      handleGpsPosition(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      let msg = 'Standort-Erkennung fehlgeschlagen: ' + err.message;
      if (err.code === 1) msg = '⚠️ Standortzugriff wurde verweigert. Bitte in den Browser-Einstellungen erlauben, falls gewünscht.';
      setGpsStatus(msg, 'error');
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function stopGpsWatch() {
  if (gpsWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = null;
  const el = document.getElementById('gps-status');
  if (el) { el.textContent = ''; el.className = 'hint-inline gps-status'; }
  hideGpsSuggestion();
}

function handleGpsPosition(lat, lon) {
  if (!state.routeStarted) return;
  const i = state.currentIndex;
  const stop = state.stops[i];
  if (!stop || stop.status !== 'pending') return; // nur relevant, solange man noch "auf dem Weg" zu diesem Halt ist
  if (!stop.geo || typeof stop.geo.lat !== 'number' || typeof stop.geo.lon !== 'number') return; // keine Koordinaten bekannt

  const dist = distanceMeters(lat, lon, stop.geo.lat, stop.geo.lon);

  if (dist <= GPS_ARRIVAL_RADIUS_METERS) {
    if (gpsLastSuggestedStopId !== stop.id) {
      showGpsSuggestion(stop, dist);
    }
  } else {
    // Deutlich außerhalb des Radius: Vorschlag für diesen Halt zurücksetzen,
    // damit bei erneuter Annäherung wieder ein Vorschlag erscheinen kann.
    if (dist > GPS_ARRIVAL_RADIUS_METERS * 2 && gpsLastSuggestedStopId === stop.id) {
      gpsLastSuggestedStopId = null;
    }
  }
}

function showGpsSuggestion(stop, distMeters) {
  gpsLastSuggestedStopId = stop.id;
  const box = document.getElementById('gps-suggestion');
  const text = document.getElementById('gps-suggestion-text');
  text.textContent = `📍 Dein Standort ist nur noch ca. ${Math.round(distMeters)} m von "${stop.name}" entfernt – bist du angekommen?`;
  box.classList.remove('hidden');
  if (state.soundOn) playBeep();
}

function hideGpsSuggestion() {
  document.getElementById('gps-suggestion').classList.add('hidden');
}

function bindGpsSuggestionEvents() {
  document.getElementById('gps-confirm-btn').addEventListener('click', () => {
    const i = state.currentIndex;
    const stop = state.stops[i];
    if (stop && stop.status === 'pending') {
      stop.actualArr = nowHHMM();
      stop.status = 'arrived';
      saveState();
      renderExecution();
      renderOverview();
    }
    hideGpsSuggestion();
  });

  document.getElementById('gps-dismiss-btn').addEventListener('click', () => {
    hideGpsSuggestion();
    // gpsLastSuggestedStopId bleibt gesetzt, damit nicht sofort wieder nachgefragt wird -
    // wird erst zurückgesetzt, wenn man sich wieder deutlich entfernt (siehe handleGpsPosition).
  });
}

// ---------- Init ----------

// Wendet den aktuellen `state` komplett auf die UI an (Planungsansicht oder
// Live-Ansicht je nach routeStarted). Wird beim initialen Laden der Seite
// UND nach dem Einlesen einer JSON-Datei verwendet (ohne Seiten-Reload).
function applyStateToUI() {
  document.getElementById('sound-toggle').checked = state.soundOn;
  document.getElementById('gps-toggle').checked = !!state.gpsOn;
  document.getElementById('route-start-time').value = state.routeStartTime || '';

  stopGpsWatch();

  if (state.routeStarted && state.stops.length > 0) {
    document.getElementById('import-section').classList.add('hidden');
    document.getElementById('planning-section').classList.add('hidden');
    document.getElementById('execution-section').classList.remove('hidden');
    document.getElementById('overview-section').classList.remove('hidden');
    document.getElementById('gps-suggestion').classList.add('hidden');
    renderExecution();
    renderOverview();
    startReminderLoop();
    if (state.gpsOn) startGpsWatch();
  } else {
    document.getElementById('import-section').classList.remove('hidden');
    document.getElementById('planning-section').classList.remove('hidden');
    document.getElementById('execution-section').classList.add('hidden');
    document.getElementById('overview-section').classList.add('hidden');
    document.getElementById('gps-suggestion').classList.add('hidden');
    renderStopsTable();
  }
}

function init() {
  loadState();
  bindPlanningEvents();
  bindGpsSuggestionEvents();
  applyStateToUI();
}

document.addEventListener('DOMContentLoaded', init);
