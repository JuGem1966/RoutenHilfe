# Routenplaner & Live-Begleiter

## Projektziel
Eine eigenständige, komplett lokal im Browser laufende Website, mit der man eine
Google-Maps-Route mit mehreren Haltepunkten zeitlich durchplanen und dann während
der Fahrt begleiten lassen kann. Die App erinnert automatisch an geplante
Abfahrtszeiten und kommentiert Ankunftszeiten (früher/später als geplant).

Zusätzlich kann die Fahrzeit zwischen den Haltepunkten **automatisch berechnet**
werden – über die kostenlosen Open-Source-Dienste **Nominatim** (Geocoding) und
**OSRM** (Routing), ganz ohne API-Key.

## Aktuell umgesetzte Funktionen

1. **Route einlesen**
   - Einfügen eines vollständigen Google-Maps-Routen-Links (`.../maps/dir/...`)
   - Automatische Extraktion der Ortsnamen als Haltepunkte
   - Bei Kurzlinks (`maps.app.goo.gl`) oder nicht auswertbaren Links: klare
     Fehlermeldung, Haltepunkte können manuell hinzugefügt werden
   - Manuelles Hinzufügen/Entfernen/Umbenennen von Haltepunkten jederzeit möglich

2. **Zeitplanung je Haltepunkt**
   - **Geplante Gesamt-Abfahrt**: Eingabefeld ganz oben in der Planung, mit dem
     die generelle Startzeit der Route (z. B. 08:00 Uhr) festgelegt und per
     Klick auf den ersten Haltepunkt als geplante Abfahrt übertragen wird
   - Felder je Haltepunkt: geplante Ankunft, Aufenthaltsdauer (Minuten), geplante Abfahrt
   - Es müssen nicht alle Felder gefüllt werden – sobald zwei von drei Werten
     vorhanden sind, wird der dritte automatisch berechnet
   - **Durchgehende Zeitkette**: Ausgehend von der geplanten Gesamt-Abfahrt
     und den (manuell oder automatisch ermittelten) Fahrzeiten werden die
     Ankunfts-/Abfahrtszeiten **aller** Haltepunkte durchgehend berechnet –
     fehlt bei einem Zwischenhalt die Aufenthaltsdauer, wird für die
     Weiterrechnung "sofortige Weiterfahrt" (0 Min) angenommen, damit die
     Kette nicht abbricht. Trägst du danach eine Aufenthaltsdauer ein, werden
     automatisch alle nachfolgenden Haltepunkte neu durchgerechnet. Manuell
     eingetragene Ankunfts-/Abfahrtszeiten werden als fixiert behandelt und
     nicht mehr automatisch überschrieben (erst wenn das Feld geleert wird,
     übernimmt die Automatik wieder).
   - **Fahrzeiten automatisch berechnen (OSRM)**: Ein Klick auf den Button
     löst alle Haltepunkt-Namen per Nominatim in Koordinaten auf, berechnet
     anschließend über den öffentlichen OSRM-Server die Fahrzeit (Auto) und
     Distanz zwischen den Etappen und schlägt daraus fehlende Ankunftszeiten
     automatisch vor. Vorhandene manuelle Eingaben werden nicht überschrieben.
   - **Mehrstufige Adress-Erkennung**: Google-Maps-Haltepunkte sind oft sehr
     spezifische Adresszeilen (Name + Postleitzahl + Land), die der freie
     Nominatim-Dienst als Ganzes nicht immer findet. Die App probiert daher
     automatisch mehrere vereinfachte Varianten durch (z. B. nur Name + Land,
     nur der POI-Name, einzelne Adress-Bestandteile, zuletzt nur Postleitzahl
     + Land), bereinigt Sonderzeichen wie „|" und übersetzt gängige deutsche
     Länderbezeichnungen ins Englische. Wurde eine vereinfachte Variante
     verwendet, wird das in der Erfolgsmeldung transparent angezeigt.
   - Klare Fehlerunterscheidung: Netzwerk-/Blockade-Probleme (z. B. blockierte
     Vorschau-Umgebung) werden von „Adresse nicht gefunden" unterschieden.
   - Fahrzeiten können jederzeit auch manuell eingetragen/korrigiert werden
     (z. B. bei bekanntem Stau oder abweichender Einschätzung)
   - **Nicht gefundene Orte rot markiert + Position auf Karte wählen**: Konnte
     ein Haltepunkt auch nach allen Fallback-Varianten nicht automatisch
     gefunden werden, wird die Tabellenzeile rot markiert und ein Button
     „Auf Karte wählen“ angezeigt. Ein Klick öffnet einen Kartendialog
     (Leaflet + OpenStreetMap-Kacheln, kostenlos, kein API-Key), der sich
     automatisch in der Nähe eines bereits gefundenen Nachbar-Haltepunkts
     zentriert. Per Klick (oder Ziehen des Markers) wird die gewünschte
     Position markiert und mit „Position übernehmen“ gespeichert – die Zeile
     wechselt danach zu einem grünen Hinweis „Position manuell gesetzt“ mit
     der Möglichkeit, die Position jederzeit erneut zu ändern. Die so gesetzte
     Koordinate fließt normal in die OSRM-Fahrzeitberechnung ein und wird bei
     erneuter automatischer Berechnung nicht überschrieben.

3. **Route starten & Live-Begleitung**
   - Ankunfts-Kommentar: „n Minuten früher/später als geplant"
   - Aufenthalts-Hinweis: „Du hast n Minuten Aufenthaltszeit geplant" bzw.
     „Du musst um [Zeit] abfahren, Du hast noch n Minuten Aufenthaltszeit"
   - Automatische Erinnerung 10 Minuten vor der geplanten Abfahrt
     (farbiges Banner + Ton + Browser-Benachrichtigung, sofern erlaubt)
   - Live-Countdown bis zur geplanten Abfahrt
   - Übersichtsliste mit Fortschritt über die gesamte Route
   - Fortschritt wird lokal im Browser gespeichert (`localStorage`) –
     ein Neuladen der Seite geht nicht verloren
   - **Optionale GPS-gestützte Ankunfts-Erkennung**: Über die Checkbox
     „Standort-Erkennung (GPS) nutzen“ kann der Browser-Standort während der
     Fahrt beobachtet werden. Befindet man sich im Umkreis von ca. 300 m um
     den nächsten (noch nicht erreichten) Haltepunkt, erscheint ein Banner
     mit der Frage „Bist du angekommen?“ inkl. Bestätigen/Ablehnen. Der
     Status wird **nie automatisch** umgeschaltet – die Bestätigung liegt
     bewusst beim Nutzer, um Fehlauslösungen (z. B. beim Vorbeifahren) zu
     vermeiden. Voraussetzung: Der Haltepunkt braucht hinterlegte
     Koordinaten (automatisch vorhanden nach Nutzung des OSRM-Buttons).

4. **Route speichern & laden (JSON-Datei)**
   - „Route als Datei speichern“ lädt den kompletten aktuellen Zustand
     (alle Haltepunkte, Namen, Fahrzeiten, geplante und tatsächliche Zeiten,
     Status, Fortschritt, Einstellungen) als `.json`-Datei auf das Gerät
     herunter.
   - „Route aus Datei laden“ liest eine solche Datei wieder ein und stellt
     den kompletten Zustand wieder her (Planung oder laufende Live-Route,
     je nachdem, in welchem Zustand gespeichert wurde).
   - Ergänzt den automatischen lokalen Speicher (`localStorage`) um eine
     Möglichkeit, Routen dauerhaft zu sichern, zwischen Geräten zu übertragen
     oder mehrere geplante Routen parallel als Dateien zu verwalten.

## Verwendete externe Dienste (alle kostenlos, ohne API-Key)

- **Nominatim** (`nominatim.openstreetmap.org`) – Geocoding der Ortsnamen
  in Koordinaten. Hinweis: öffentlicher Dienst mit Nutzungsrichtlinie
  (max. ca. 1 Anfrage/Sekunde), daher läuft die Auflösung der Haltepunkte
  in der App bewusst leicht verzögert nacheinander ab.
- **OSRM** (`router.project-osrm.org`) – Routing/Fahrzeitberechnung für
  Auto-Routen auf Basis von OpenStreetMap-Kartendaten.

**Wichtige Einschränkung:** Beide Dienste liefern Schätzungen auf Basis der
Straßenkarte, **ohne Live-Verkehrsdaten** (kein Stau, keine Echtzeit-Ereignisse)
wie sie Google Maps direkt anzeigt. Die berechneten Fahrzeiten können daher
von der tatsächlichen Google-Maps-Prognose abweichen und sollten insbesondere
bei stauanfälligen Strecken vor Fahrtbeginn geprüft werden.

## Seitenstruktur / Dateien

```
index.html      Hauptseite (alle drei Schritte: Import, Planung, Live-Begleitung)
css/style.css   Gesamtes Styling
js/app.js       Gesamte Logik: Link-Parsing, Zeitrechnung, Geocoding/Routing,
                Live-Begleitung, Erinnerungen, lokale Speicherung
```

Es gibt keine weiteren Parameter/URLs – die Seite ist eine einzelne `index.html`
ohne Unterseiten oder URL-Parameter.

## Datenmodell (nur lokal im Browser, `localStorage`)

```js
{
  stops: [
    {
      id, name,
      travelMin,   // Fahrzeit von vorigem Halt (Min), manuell oder automatisch
      travelKm,    // Distanz von vorigem Halt (km), nur informativ
      geo,         // { lat, lon, displayName } – Ergebnis der letzten Geokodierung (auch bei manueller Kartenwahl)
      geoFailed,   // true = automatische Adress-Suche hat diesen Ort nicht gefunden (rote Zeile)
      geoManual,   // true = Position wurde von Hand auf der Karte gewählt
      planArr, planDur, planDep,   // geplante Zeiten
      actualArr, actualDep,        // tatsächliche Zeiten
      status       // 'pending' | 'arrived' | 'departed'
    }, ...
  ],
  routeStarted, currentIndex, notified10min, soundOn
}
```

Es wird keine serverseitige Datenbank / Table-API verwendet – alles läuft
ausschließlich lokal im Browser des Nutzers. Der komplette Zustand kann
zusätzlich jederzeit als JSON-Datei exportiert/importiert werden (siehe oben).

`makeStop()` legt zusätzlich `arrAuto`/`depAuto` (Kennzeichnung, ob Ankunft/
Abfahrt automatisch aus der Kette berechnet oder manuell fixiert ist) an;
der globale Zustand enthält zusätzlich `gpsOn` (GPS-Erkennung aktiviert/
deaktiviert).

## Nicht umgesetzt / bewusste Einschränkungen

- Kein Live-Zugriff auf eine geöffnete Google-Maps-Ansicht (technisch nicht
  möglich für eine statische Website) – der Routen-Link muss manuell eingefügt
  werden.
- Keine echte Google-Maps-Verkehrslage (Directions API benötigt kostenpflichtigen
  API-Key und ist nicht CORS-frei nutzbar) – stattdessen Open-Source-Schätzung
  ohne Live-Verkehr.
- Fuß-/Fahrrad-Routing ist über den öffentlichen OSRM-Server nicht zuverlässig
  verfügbar, ÖPNV-Routing gar nicht – aktuell ist nur das Auto-Profil eingebaut.
- Erinnerungen und die GPS-Erkennung funktionieren nur, solange der
  Browser-Tab geöffnet ist (Hintergrund-Tab reicht meist, ein komplett
  geschlossener Browser oder gesperrter Bildschirm auf dem Handy kann die
  Standort-Erkennung pausieren).
- Die GPS-Erkennung schlägt einen Ankunfts-Status nur **vor** und schaltet
  ihn nie automatisch um – das ist bewusst so gewählt (keine Fehlauslösung
  beim Vorbeifahren), bedeutet aber, dass ein manueller Klick zur Bestätigung
  weiterhin nötig ist.
- GPS-Erkennung setzt voraus, dass der Haltepunkt Koordinaten hat (über den
  OSRM-Button ermittelt); ohne das funktioniert für diesen Halt nur der
  manuelle „Angekommen“-Button.

## Empfohlene nächste Schritte

- Optional: Wahl des Reiseprofils (Auto/Fahrrad/Fuß) mit Fallback auf manuelle
  Eingabe, falls Fuß/Rad benötigt wird.
- Optional: Karten-Vorschau der **gesamten Route** direkt auf der Seite (aktuell
  gibt es die Karte nur für die manuelle Positions-Wahl einzelner Haltepunkte).
- Optional: Zusammenfassung/Export am Ende der Route (wo war man wie viel
  früher/später als geplant).

## Öffentliche URL

Aktuell nur als Projekt-Vorschau verfügbar. Für eine feste, öffentliche URL
bitte über den **Publish-Tab** veröffentlichen.
