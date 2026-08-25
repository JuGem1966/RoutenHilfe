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

// ---------- Routenkarte ----------
let lastRouteGeometry = null; // Array von [lat, lon] entlang der von OSRM berechneten Fahrstrecke, oder null
let routeMapLeaflet = null;   // Leaflet-Kartenobjekt der Routenkarte (einmalig erzeugt, dann wiederverwendet)
let routeMapMarkers = [];     // aktuell auf der Routenkarte angezeigte Marker
let routeMapLine = null;      // aktuell angezeigte Routen-Linie (Polyline)

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
    geoFailed: false, // true = automatische Adress-Suche hat diesen Ort NICHT gefunden (Zeile wird rot markiert)
    geoManual: false, // true = Position wurde von Hand auf der Karte gewählt (wird bei erneuter Berechnung nicht überschrieben)
    geoSuspicious: false, // true = Ort wurde zwar gefunden, aber die berechnete Fahrzeit davor ist auffällig lang (Zeile wird orange markiert)
    resolvedName: null,      // aufgelöster Ortsname (Reverse-Geocoding), falls das Namensfeld nur eine Koordinate enthält
    resolvedNameFailed: false, // true = Reverse-Geocoding für die Koordinate im Namensfeld ist fehlgeschlagen
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
    if (stop.geoFailed) {
      tr.classList.add('stop-not-found');
    } else if (stop.geoSuspicious) {
      tr.classList.add('stop-suspicious');
    }
    // Kurzer Textstatus unter dem Namen (nur Hinweis, kein Button mehr - der
    // Karten-Zugriff ist jetzt über das kleine Karten-Icon in jeder Zeile
    // möglich, unabhängig vom Status).
    let nameCellExtra;
    if (stop.geoFailed) {
      nameCellExtra = `<div class="geo-fail-row">
           <span class="geo-fail-label"><i class="fa-solid fa-triangle-exclamation"></i> Ort nicht gefunden</span>
         </div>`;
    } else if (stop.geoSuspicious) {
      nameCellExtra = `<div class="geo-fail-row">
           <span class="geo-suspicious-label"><i class="fa-solid fa-triangle-exclamation"></i> Auffällig lange Fahrzeit – Position prüfen</span>
         </div>`;
    } else if (stop.geoManual) {
      nameCellExtra = `<div class="geo-fail-row">
               <span class="geo-manual-label"><i class="fa-solid fa-map-pin"></i> Position manuell gesetzt</span>
             </div>`;
    } else {
      nameCellExtra = '';
    }

    // Test-Spalte: zeigt die aktuell hinterlegte Koordinate im Klartext an,
    // damit sich Geocoding-Ergebnisse direkt in der Tabelle nachvollziehen lassen.
    let coordText;
    if (stop.geo && typeof stop.geo.lat === 'number' && typeof stop.geo.lon === 'number') {
      const src = stop.geoManual ? ' (manuell)' : '';
      const cls = stop.geoSuspicious ? 'suspicious' : 'ok';
      coordText = `<span class="coord-cell ${cls}">${stop.geo.lat.toFixed(5)}, ${stop.geo.lon.toFixed(5)}${src}</span>`;
    } else if (stop.geoFailed) {
      coordText = `<span class="coord-cell fail">– keine Koordinate –</span>`;
    } else {
      coordText = `<span class="coord-cell empty">– noch nicht berechnet –</span>`;
    }
    // Kleines Karten-Icon: IMMER anklickbar, unabhängig vom Status (normal,
    // orange, rot) - so lässt sich jede Position jederzeit von Hand prüfen
    // oder korrigieren, nicht nur bei einem erkannten Fehler.
    const coordCell = `${coordText} <button type="button" class="map-icon-btn" data-pick-map="${stop.id}" title="Position auf Karte prüfen/setzen"><i class="fa-solid fa-map-location-dot"></i></button>`;

    // Google-Maps-Links enthalten für frei gesetzte Pins oft nur "lat,lon"
    // statt eines Ortsnamens. Falls zutreffend, wird - unterhalb des
    // (unveränderten) Namensfelds - der per Reverse-Geocoding aufgelöste
    // Klartext-Ortsname eingeblendet.
    let resolvedNameRow = '';
    if (parseCoordName(stop.name)) {
      if (stop.resolvedName) {
        resolvedNameRow = `<div class="resolved-name-row"><span class="coord-cell ok"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(stop.resolvedName)}</span></div>`;
      } else if (stop.resolvedNameFailed) {
        resolvedNameRow = `<div class="resolved-name-row"><span class="coord-cell fail">– Ortsname nicht auflösbar –</span></div>`;
      } else {
        resolvedNameRow = `<div class="resolved-name-row"><span class="coord-cell empty">– Ortsname wird ermittelt … –</span></div>`;
      }
    }

    tr.innerHTML = `
      <td class="row-num">${i + 1}</td>
      <td class="col-stopname"><input type="text" data-field="name" data-id="${stop.id}" value="${escapeHtml(stop.name)}">${nameCellExtra}${resolvedNameRow}</td>
      <td>${coordCell}</td>
      <td class="travel-cell">${travelCell}</td>
      <td><input type="time" data-field="planArr" data-id="${stop.id}" value="${stop.planArr}"></td>
      <td><input type="text" inputmode="numeric" pattern="[0-9]*" data-field="planDur" data-id="${stop.id}" value="${stop.planDur}" placeholder="Min"></td>
      <td><input type="time" data-field="planDep" data-id="${stop.id}" value="${stop.planDep}"></td>
      <td><button class="remove-row-btn" data-remove="${stop.id}" title="Entfernen"><i class="fa-solid fa-trash"></i></button></td>
    `;
    tbody.appendChild(tr);
  });

  updateStopsTotalsRow();
}

// Summiert die reine Fahrzeit (travelMin, ohne den Start-Haltepunkt) sowie die
// geplante Aufenthaltszeit (planDur) über alle Haltepunkte und zeigt beides in
// der Fußzeile der Tabelle im Format hh:mm an.
function updateStopsTotalsRow() {
  const travelEl = document.getElementById('totals-travel');
  const stayEl = document.getElementById('totals-stay');
  if (!travelEl || !stayEl) return;

  let totalTravel = 0;
  let totalStay = 0;
  state.stops.forEach(stop => {
    const t = parseInt(stop.travelMin, 10);
    if (!isNaN(t)) totalTravel += t;
    const d = parseInt(stop.planDur, 10);
    if (!isNaN(d)) totalStay += d;
  });

  travelEl.textContent = totalTravel > 0 ? formatMinAsHHMM(totalTravel) : '–';
  stayEl.textContent = totalStay > 0 ? formatMinAsHHMM(totalStay) : '–';
}

// ---------- Routenkarte (Anzeige nach erfolgreicher Fahrzeitberechnung) ----------
//
// Zeigt die komplette Route mit nummerierten Markern (in Haltepunkt-
// Reihenfolge) und der von OSRM berechneten Fahrstrecke direkt zwischen der
// Start-Zeit-Zeile und der Haltepunkt-Tabelle. Nutzt Leaflet + OpenStreetMap-
// Kacheln (kostenlos, kein API-Key), genauso wie der Karten-Auswahl-Dialog.
function renderRouteMap() {
  const section = document.getElementById('route-map-section');
  if (!section) return;

  const stopsWithGeo = state.stops.filter(s => s.geo && typeof s.geo.lat === 'number' && typeof s.geo.lon === 'number');
  if (stopsWithGeo.length < 2) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  // Karte erst beim ersten Anzeigen erzeugen (vorher war der Container
  // "hidden" - eine Leaflet-Karte in einem unsichtbaren Container würde
  // falsche Kachel-Maße berechnen).
  if (!routeMapLeaflet) {
    routeMapLeaflet = L.map('route-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
    }).addTo(routeMapLeaflet);
  }
  setTimeout(() => { if (routeMapLeaflet) routeMapLeaflet.invalidateSize(); }, 50);

  // Bisherige Marker/Route entfernen, dann neu aufbauen.
  routeMapMarkers.forEach(m => routeMapLeaflet.removeLayer(m));
  routeMapMarkers = [];
  if (routeMapLine) {
    routeMapLeaflet.removeLayer(routeMapLine);
    routeMapLine = null;
  }

  // Nummerierte Marker entsprechend der Reihenfolge in state.stops (nicht
  // nur der gefilterten Liste), damit die Nummer immer der Zeilennummer in
  // der Tabelle entspricht.
  const bounds = [];
  state.stops.forEach((stop, i) => {
    if (!stop.geo || typeof stop.geo.lat !== 'number' || typeof stop.geo.lon !== 'number') return;
    const color = stop.geoFailed ? '#dc2626' : (stop.geoSuspicious ? '#f59e0b' : '#2563eb');
    const icon = L.divIcon({
      className: 'route-map-num-icon',
      html: `<span style="background:${color};">${i + 1}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    const marker = L.marker([stop.geo.lat, stop.geo.lon], { icon }).addTo(routeMapLeaflet);
    marker.bindPopup(`<strong>${i + 1}. ${escapeHtml(stop.name)}</strong>`);
    routeMapMarkers.push(marker);
    bounds.push([stop.geo.lat, stop.geo.lon]);
  });

  // Fahrstrecke: wenn OSRM eine Geometrie geliefert hat, die tatsächliche
  // Straßenroute zeichnen - sonst als Ersatz eine gerade Verbindungslinie
  // zwischen den Haltepunkten.
  const lineCoords = (lastRouteGeometry && lastRouteGeometry.length > 0) ? lastRouteGeometry : bounds;
  routeMapLine = L.polyline(lineCoords, { color: '#2563eb', weight: 4, opacity: 0.75 }).addTo(routeMapLeaflet);

  if (bounds.length > 0) {
    routeMapLeaflet.fitBounds(bounds, { padding: [30, 30] });
  }
}

// Wandelt eine Minutenzahl in "hh:mm" um (z. B. 125 -> "2:05").
function formatMinAsHHMM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
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
    // Falls Google Maps für einzelne Haltepunkte nur "lat,lon" statt eines
    // Ortsnamens geliefert hat (frei gesetzte Pins), im Hintergrund den
    // zugehörigen Ortsnamen per Reverse-Geocoding auflösen (nur zur Anzeige).
    resolveCoordNames();
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
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const id = removeBtn.getAttribute('data-remove');
      state.stops = state.stops.filter(s => s.id !== id);
      renderStopsTable();
      saveState();
      return;
    }
    const pickBtn = e.target.closest('[data-pick-map]');
    if (pickBtn) {
      const id = pickBtn.getAttribute('data-pick-map');
      const stop = state.stops.find(s => s.id === id);
      if (stop) openMapPicker(stop);
      return;
    }
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

// Schwelle für die Plausibilitätsprüfung: Ist die berechnete Fahrzeit zu einem
// Haltepunkt länger als dieser Wert, wird die Zeile orange markiert - auch
// wenn eine Koordinate gefunden wurde, kann diese (z. B. bei gleichnamigen
// Straßen/Orten) trotzdem völlig neben der eigentlichen Route liegen. Eine
// unplausibel lange Fahrzeit ist dafür ein guter Hinweis.
const SUSPICIOUS_TRAVEL_MIN = 120; // 2 Stunden

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

// ---------- Erkennung "Name ist eigentlich nur eine Koordinate" + Reverse-Geocoding ----------
//
// Google-Maps-Routenlinks enthalten für Haltepunkte ohne eigenen POI-Namen
// (z. B. ein frei auf der Karte gesetzter Pin) nur die Koordinate als Text,
// z. B. "56.4802236,-5.8082249". Das lässt sich klar von einem echten
// Ortsnamen unterscheiden (zwei Zahlen mit Komma, kein Buchstabe).

const COORD_NAME_REGEX = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function parseCoordName(name) {
  if (!name) return null;
  const m = String(name).match(COORD_NAME_REGEX);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Reverse-Geocoding: aus einer Koordinate einen lesbaren Ortsnamen ermitteln
// (Nominatim, derselbe kostenlose Dienst wie beim normalen Geocoding - nur
// mit umgekehrter Richtung).
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (networkErr) {
    throw new Error('NETWORK: ' + networkErr.message);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' von Nominatim');
  const data = await res.json();
  if (!data || !data.display_name) return null;
  return data.display_name;
}

// Löst für alle Haltepunkte, deren Namensfeld nur eine Koordinate enthält,
// per Reverse-Geocoding einen lesbaren Ortsnamen auf (füllt "resolvedName").
// Das Namensfeld selbst bleibt dabei unverändert - der aufgelöste Name wird
// zusätzlich in einer eigenen Tabellenspalte angezeigt.
async function resolveCoordNames() {
  const feedback = document.getElementById('auto-calc-feedback');
  const candidates = state.stops.filter(s => parseCoordName(s.name) && !s.resolvedName);
  if (candidates.length === 0) return;

  for (let i = 0; i < candidates.length; i++) {
    const stop = candidates[i];
    const coord = parseCoordName(stop.name);
    if (feedback) feedback.textContent = `Löse Ortsnamen für Koordinate ${i + 1}/${candidates.length} auf …`;
    try {
      const displayName = await reverseGeocode(coord.lat, coord.lon);
      if (displayName) {
        stop.resolvedName = displayName;
        stop.resolvedNameFailed = false;
      } else {
        stop.resolvedNameFailed = true;
      }
    } catch (e) {
      stop.resolvedNameFailed = true;
    }
    renderStopsTable();
    saveState();
    // Nominatim-Nutzungsrichtlinie: max. ca. 1 Anfrage/Sekunde
    if (i < candidates.length - 1) await sleep(1100);
  }
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

    // Manuell auf der Karte gesetzte Positionen nicht erneut automatisch
    // suchen/überschreiben - die Koordinate bleibt bestehen.
    if (stop.geoManual && stop.geo) {
      stop.geoFailed = false;
      stop.geoSuspicious = false; // manuell gesetzte Positionen gelten als geprüft
      coords.push(stop.geo);
      continue;
    }

    // Google-Maps-Links liefern für frei gesetzte Pins (statt benannter Orte)
    // oft nur "lat,lon" als Namen. Eine Text-Suche danach bei Nominatim ist
    // unzuverlässig - stattdessen die Koordinate direkt verwenden.
    const directCoord = parseCoordName(stop.name);
    if (directCoord) {
      stop.geo = directCoord;
      stop.geoFailed = false;
      stop.geoSuspicious = false;
      coords.push(directCoord);
      continue;
    }

    btn.innerHTML = `<span class="geo-spinner"></span> Löse Adresse ${i + 1}/${state.stops.length} auf …`;
    feedback.textContent = `Suche Position von "${stop.name}" …`;
    try {
      const result = await geocodeWithFallback(stop.name);
      if (!result) {
        stop.geoFailed = true;
        stop.geoSuspicious = false;
        failed.push(stop.name);
        coords.push(null);
      } else {
        stop.geo = result.geo;
        stop.geoFailed = false;
        stop.geoSuspicious = false; // wird unten nach der Fahrzeit-Berechnung ggf. neu gesetzt
        coords.push(result.geo);
        if (result.variantIndex > 0) {
          simplified.push(`${stop.name.split(',')[0].trim()} → "${result.usedQuery}"`);
        }
      }
    } catch (e) {
      if (String(e.message).startsWith('NETWORK:')) networkProblem = true;
      stop.geoFailed = true;
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
    renderStopsTable();
    saveState();
    feedback.textContent = `Adresse(n) nicht gefunden (rot markiert): ${failed.join(', ')}. Bitte Namen präzisieren (z. B. Stadt/Land ergänzen), oder die Position direkt über "Auf Karte wählen" bei der betroffenen Zeile setzen und danach erneut berechnen.`;
    feedback.className = 'feedback error';
    return;
  }

  btn.innerHTML = '<span class="geo-spinner"></span> Berechne Fahrzeiten …';
  feedback.textContent = 'Berechne Fahrzeiten über OSRM (OpenStreetMap-Routing) …';

  try {
    const coordStr = coords.map(c => `${c.lon},${c.lat}`).join(';');
    // overview=full + geometries=geojson liefert zusätzlich die komplette
    // Straßen-Geometrie der Route (für die Kartenanzeige unten), nicht nur
    // die Fahrzeiten/Distanzen je Etappe.
    const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
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
    const suspicious = [];
    for (let i = 0; i < legs.length; i++) {
      const mins = Math.max(1, Math.round(legs[i].duration / 60));
      const km = legs[i].distance / 1000;
      const targetStop = state.stops[i + 1];
      targetStop.travelMin = String(mins);
      targetStop.travelKm = km;
      // Plausibilitätsprüfung: Auch eine "gefundene" Koordinate kann komplett
      // neben der eigentlichen Route liegen (z. B. gleichnamige Adresse in
      // einer anderen Stadt) - eine unplausibel lange Fahrzeit davor ist
      // dafür ein deutliches Warnsignal, unabhängig vom geoFailed-Status.
      targetStop.geoSuspicious = !targetStop.geoManual && mins > SUSPICIOUS_TRAVEL_MIN;
      if (targetStop.geoSuspicious) suspicious.push(targetStop.name);
      totalMin += mins;
      totalKm += km;
    }
    applyTravelSuggestions();
    renderStopsTable();
    saveState();

    // Route-Geometrie (Straßenverlauf) + Haltepunkt-Koordinaten für die
    // Kartenanzeige unterhalb der Start-Zeit merken und Karte aktualisieren.
    // Bewusst in einem eigenen try/catch: Falls die Geometrie aus irgendeinem
    // Grund unerwartet aufgebaut ist, soll das die bereits erfolgreich
    // berechneten Fahrzeiten/Ankünfte nicht nachträglich als "Fehler" melden -
    // die Karte fällt dann einfach auf gerade Verbindungslinien zurück.
    try {
      const geom = data.routes[0].geometry;
      lastRouteGeometry = (geom && geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0)
        ? geom.coordinates.map(c => [c[1], c[0]]) // GeoJSON liefert [lon,lat] -> Leaflet will [lat,lon]
        : null;
    } catch (geomErr) {
      lastRouteGeometry = null;
    }
    renderRouteMap();

    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    let msg = `Fertig: ca. ${Math.round(totalKm)} km, ${h > 0 ? h + ' Std ' : ''}${m} Min reine Fahrzeit (Schätzung ohne Live-Verkehr). Leere Ankunftszeiten wurden automatisch vorgeschlagen – bitte prüfen und bei Bedarf anpassen.`;
    if (simplified.length > 0) {
      msg += ` Hinweis: Bei folgenden Haltepunkten wurde die genaue Adresse nicht gefunden, stattdessen ein vereinfachter Suchbegriff verwendet (bitte Position bei Bedarf prüfen): ${simplified.join(' · ')}.`;
    }
    if (suspicious.length > 0) {
      msg += ` ⚠️ Auffällig lange Fahrzeit (über ${SUSPICIOUS_TRAVEL_MIN / 60} Std, orange markiert) vor: ${suspicious.join(', ')} – die gefundene Position liegt hier vermutlich neben der eigentlichen Route. Bitte über "Auf Karte wählen" prüfen/korrigieren.`;
      feedback.className = 'feedback warn';
    } else {
      feedback.className = 'feedback ok';
    }
    feedback.textContent = msg;
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

// ---------- Karten-Auswahl: Position von Hand markieren ----------
//
// Kommt zum Einsatz, wenn die automatische Adress-Suche (Nominatim) einen
// Ort nicht finden konnte (rot markierte Zeile), oder wenn eine bereits
// gefundene Position von Hand korrigiert werden soll. Nutzt Leaflet mit
// OpenStreetMap-Kartenkacheln (Open Source, kein API-Key nötig) - die so
// gewählte Koordinate fließt danach ganz normal in die OSRM-Fahrzeit-
// berechnung ein, genau wie eine automatisch gefundene Position.

let mapPickerLeaflet = null;   // Leaflet-Kartenobjekt (wird bei Bedarf einmalig erzeugt)
let mapPickerMarker = null;    // aktuell gesetzter Marker
let mapPickerStop = null;      // der Haltepunkt, für den gerade eine Position gewählt wird
let mapPickerCoords = null;    // {lat, lon} der aktuell im Dialog gewählten Position

function findNearestKnownGeo(stop) {
  // Sucht in der Stop-Liste einen Nachbarn mit bekannter Position, um die
  // Karte sinnvoll zu zentrieren (z. B. den vorigen oder nächsten Haltepunkt).
  const idx = state.stops.findIndex(s => s.id === stop.id);
  for (let offset = 1; offset < state.stops.length; offset++) {
    const before = state.stops[idx - offset];
    if (before && before.geo) return before.geo;
    const after = state.stops[idx + offset];
    if (after && after.geo) return after.geo;
  }
  return null;
}

function openMapPicker(stop) {
  mapPickerStop = stop;
  mapPickerCoords = (stop.geo && typeof stop.geo.lat === 'number') ? { lat: stop.geo.lat, lon: stop.geo.lon } : null;

  document.getElementById('map-picker-stop-name').textContent = stop.name;
  document.getElementById('map-picker-feedback').textContent = '';
  document.getElementById('map-picker-feedback').className = 'feedback';
  document.getElementById('map-picker-save-btn').disabled = !mapPickerCoords;
  document.getElementById('map-picker-overlay').classList.remove('hidden');

  // Sucheingabe zurücksetzen - mit dem Namen des Haltepunkts vorbefüllen,
  // damit man direkt "Suchen" klicken kann, ohne den Namen erneut eintippen zu müssen.
  const searchInput = document.getElementById('map-picker-search-input');
  searchInput.value = stop.name || '';
  const searchFeedback = document.getElementById('map-picker-search-feedback');
  searchFeedback.textContent = '';
  searchFeedback.className = 'feedback';

  // Start-Ansicht: vorhandene Position > Position eines Nachbar-Haltepunkts > Europa-Übersicht
  const fallback = findNearestKnownGeo(stop);
  const startLat = mapPickerCoords ? mapPickerCoords.lat : (fallback ? fallback.lat : 47.0);
  const startLon = mapPickerCoords ? mapPickerCoords.lon : (fallback ? fallback.lon : 10.0);
  const startZoom = mapPickerCoords ? 14 : (fallback ? 11 : 5);

  // Leaflet-Karte erst beim ersten Öffnen erzeugen (das Overlay ist vorher
  // "display:none", eine Karte in einem unsichtbaren Container würde
  // falsche Kachel-Maße berechnen).
  if (!mapPickerLeaflet) {
    mapPickerLeaflet = L.map('map-picker-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende'
    }).addTo(mapPickerLeaflet);
    mapPickerLeaflet.on('click', (ev) => {
      setMapPickerPosition(ev.latlng.lat, ev.latlng.lng);
    });
  }

  mapPickerLeaflet.setView([startLat, startLon], startZoom);
  // Nach dem Sichtbar-Werden des Overlays muss Leaflet seine Kachel-Größe neu berechnen.
  setTimeout(() => { if (mapPickerLeaflet) mapPickerLeaflet.invalidateSize(); }, 50);

  if (mapPickerMarker) {
    mapPickerLeaflet.removeLayer(mapPickerMarker);
    mapPickerMarker = null;
  }
  if (mapPickerCoords) {
    setMapPickerPosition(mapPickerCoords.lat, mapPickerCoords.lon);
  }
}

function setMapPickerPosition(lat, lon) {
  mapPickerCoords = { lat, lon };
  if (mapPickerMarker) {
    mapPickerMarker.setLatLng([lat, lon]);
  } else {
    mapPickerMarker = L.marker([lat, lon], { draggable: true }).addTo(mapPickerLeaflet);
    mapPickerMarker.on('dragend', () => {
      const p = mapPickerMarker.getLatLng();
      mapPickerCoords = { lat: p.lat, lon: p.lng };
      document.getElementById('map-picker-save-btn').disabled = false;
    });
  }
  document.getElementById('map-picker-save-btn').disabled = false;
}

function closeMapPicker() {
  document.getElementById('map-picker-overlay').classList.add('hidden');
  mapPickerStop = null;
  mapPickerCoords = null;
}

// Sucht einen Ort/eine Adresse über Nominatim und springt im Karten-Dialog
// dorthin, damit die Feinjustierung (Klick/Marker verschieben) auf einem
// bereits sinnvoll zentrierten Kartenausschnitt stattfinden kann - nützlich
// z. B. um von einem falsch gefundenen Ort zunächst zur richtigen Stadt/
// Region zu springen und dann die genaue Position exakt zu setzen.
async function searchMapPickerLocation() {
  const input = document.getElementById('map-picker-search-input');
  const searchFeedback = document.getElementById('map-picker-search-feedback');
  const searchBtn = document.getElementById('map-picker-search-btn');
  const query = input.value.trim();
  if (!query) {
    searchFeedback.textContent = 'Bitte einen Suchbegriff eingeben.';
    searchFeedback.className = 'feedback error';
    return;
  }

  const originalHtml = searchBtn.innerHTML;
  searchBtn.disabled = true;
  searchBtn.innerHTML = '<span class="geo-spinner"></span> Suche …';
  searchFeedback.textContent = '';
  searchFeedback.className = 'feedback';

  try {
    const geo = await geocodeName(query);
    if (!geo) {
      searchFeedback.textContent = `„${query}“ wurde nicht gefunden. Bitte anders formulieren (z. B. Ort/Land ergänzen) oder direkt auf die Karte klicken.`;
      searchFeedback.className = 'feedback error';
      return;
    }
    mapPickerLeaflet.setView([geo.lat, geo.lon], 14);
    setMapPickerPosition(geo.lat, geo.lon);
    searchFeedback.textContent = `Gefunden: ${geo.displayName}. Bitte prüfen und bei Bedarf den Marker noch feinjustieren, dann „Position übernehmen“ klicken.`;
    searchFeedback.className = 'feedback ok';
  } catch (e) {
    const isNetwork = String(e.message).startsWith('NETWORK:');
    searchFeedback.textContent = isNetwork
      ? 'Die Adress-Suche konnte nicht erreicht werden (Netzwerkproblem). Bitte später erneut versuchen oder direkt auf die Karte klicken.'
      : 'Suche fehlgeschlagen: ' + e.message;
    searchFeedback.className = 'feedback error';
  } finally {
    searchBtn.disabled = false;
    searchBtn.innerHTML = originalHtml;
  }
}

function bindMapPickerEvents() {
  document.getElementById('map-picker-close-btn').addEventListener('click', closeMapPicker);
  document.getElementById('map-picker-cancel-btn').addEventListener('click', closeMapPicker);

  document.getElementById('map-picker-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'map-picker-overlay') closeMapPicker(); // Klick auf den dunklen Hintergrund
  });

  document.getElementById('map-picker-search-btn').addEventListener('click', searchMapPickerLocation);
  document.getElementById('map-picker-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchMapPickerLocation();
    }
  });

  document.getElementById('map-picker-save-btn').addEventListener('click', () => {
    if (!mapPickerStop || !mapPickerCoords) return;
    const stopName = mapPickerStop.name;
    mapPickerStop.geo = {
      lat: mapPickerCoords.lat,
      lon: mapPickerCoords.lon,
      displayName: 'Manuell auf Karte gewählt'
    };
    mapPickerStop.geoFailed = false;
    mapPickerStop.geoSuspicious = false;
    mapPickerStop.geoManual = true;
    saveState();
    renderStopsTable();
    closeMapPicker();
    const feedback = document.getElementById('auto-calc-feedback');
    feedback.textContent = `Position für "${stopName}" wurde von Hand gesetzt. Bitte "Fahrzeiten automatisch berechnen" erneut ausführen, damit die Fahrzeiten mit der neuen Position aktualisiert werden.`;
    feedback.className = 'feedback ok';
    // Die zuvor berechnete Fahrstrecken-Geometrie passt nicht mehr genau zur
    // neuen Position - Karte trotzdem aktualisieren (Marker-Position stimmt
    // sofort, die Linie fällt bis zur nächsten Berechnung auf eine gerade
    // Verbindung zwischen den Haltepunkten zurück).
    lastRouteGeometry = null;
    renderRouteMap();
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
    // Die genaue Straßen-Geometrie wird nicht dauerhaft gespeichert - nach
    // einem Neuladen der Seite zeigt die Karte (falls bereits Koordinaten
    // vorhanden sind) daher zunächst gerade Verbindungslinien zwischen den
    // Haltepunkten, bis erneut "Fahrzeiten automatisch berechnen" genutzt wird.
    renderRouteMap();
  }
}

function init() {
  loadState();
  bindPlanningEvents();
  bindGpsSuggestionEvents();
  bindMapPickerEvents();
  applyStateToUI();
}

document.addEventListener('DOMContentLoaded', init);
