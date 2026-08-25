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
   - **Position jederzeit auf der Karte prüfen/korrigieren**: Neben der
     Koordinaten-Anzeige jedes Haltepunkts gibt es ein kleines Karten-Icon
     (📍), das **immer** anklickbar ist – unabhängig davon, ob die Zeile
     normal, orange oder rot markiert ist. So lässt sich auch ein Ort
     korrigieren, der zwar „normal“ aussieht, aber in Wirklichkeit falsch
     platziert ist (z. B. wenn erst ein späterer Haltepunkt durch eine
     unplausible Fahrzeit auffällt, tatsächlich aber ein früherer Ort falsch
     lag). Ein Klick öffnet einen Kartendialog (Leaflet + OpenStreetMap-
     Kacheln, kostenlos, kein API-Key), der sich automatisch in der Nähe
     einer bereits bekannten Position zentriert. Im Dialog steht zusätzlich
     ein **Suchfeld** zur Verfügung (vorbefüllt mit dem Namen des
     Haltepunkts): Eingabe eines Orts/einer Adresse + „Suchen“ springt die
     Karte automatisch zur gefundenen Position (per Nominatim) – die genaue
     Stelle lässt sich danach durch Klick oder Ziehen des Markers noch
     feinjustieren. Mit „Position übernehmen“ wird die Koordinate
     gespeichert – die Zeile wechselt danach zu einem grünen Hinweis
     „Position manuell gesetzt“. Die so gesetzte Koordinate fließt normal in
     die OSRM-Fahrzeitberechnung ein und wird bei erneuter automatischer
     Berechnung nicht überschrieben.
   - **Test-Spalte „Koordinate (Test)“**: Zeigt zu Diagnose-Zwecken direkt in
     der Tabelle die aktuell hinterlegte Koordinate jedes Haltepunkts im
     Klartext an (grün = gefunden, orange = gefunden, aber auffällig lange
     Fahrzeit (siehe unten), rot = keine Koordinate/Ort nicht gefunden,
     grau = noch nicht berechnet). Damit lässt sich sofort nachvollziehen,
     was Schritt 2 (Geocoding) tatsächlich ermittelt hat, bevor Schritt 3
     (Routing) darauf aufbaut.
   - **Plausibilitätsprüfung „auffällig lange Fahrzeit“ (orange markiert)**:
     Ein Ort kann von Nominatim technisch „gefunden“ werden, aber trotzdem
     komplett neben der eigentlichen Route liegen – z. B. wenn eine
     Adresse ohne Ortsangabe (nur Straßenname) mehrdeutig ist und in einer
     völlig anderen Stadt/Region aufgelöst wird. Das lässt sich am
     Geocoding-Ergebnis allein nicht erkennen, wohl aber an der daraus
     berechneten Fahrzeit: Ist die Fahrzeit zu einem Haltepunkt länger als
     2 Stunden, wird die Zeile orange markiert (Warnhinweis „Auffällig
     lange Fahrzeit – Position prüfen“) – die Position lässt sich wie bei
     jedem anderen Haltepunkt über das Karten-Icon direkt korrigieren.
     Diese Prüfung läuft automatisch nach jeder Fahrzeitberechnung,
     zusätzlich zur bereits bestehenden „nicht gefunden“-Erkennung.
   - **Aufgelöster Ortsname bei reinen Koordinaten**: Manche Google-Maps-
     Routen enthalten für frei auf der Karte gesetzte Pins (statt benannter
     Orte) im Link nur eine reine Koordinate (z. B. „56.4802236,-5.8082249“)
     statt eines Namens – obwohl die Routenliste in Google Maps selbst
     einen Namen anzeigt. Beim Einlesen landet dann diese Koordinate
     unverändert im Namensfeld. Damit trotzdem klar ist, wo sich der Ort
     befindet, wird direkt **unterhalb** des (unveränderten) Namensfelds
     automatisch der per **Reverse-Geocoding** (Nominatim) ermittelte
     Klartext-Ortsname eingeblendet (grün), sobald das Namensfeld als reine
     Koordinate erkannt wird. Ist die Auflösung (noch) nicht möglich,
     erscheint „– Ortsname nicht auflösbar –“ (rot) bzw. „– Ortsname wird
     ermittelt … –“ (grau) während der Anfrage läuft. Bei „normalen“ Namen
     erscheint gar kein Zusatztext. Zusätzlich wird eine solche Koordinate
     direkt als Position verwendet (keine unzuverlässige Text-Suche danach
     nötig), was die Genauigkeit dieser Haltepunkte sogar verbessert.
   - **Spaltenbreite „Haltepunkt“**: Die Haltepunkt-Spalte ist deutlich
     breiter als die übrigen Spalten (ca. doppelt so breit), damit Name und
     ggf. aufgelöster Ortsname gut lesbar untereinander Platz haben.
   - **Summenzeile am Tabellenende**: Am Ende der Haltepunkt-Tabelle zeigt
     eine „Total“-Fußzeile die Summe der reinen Fahrzeit (alle „Fahrzeit
     davor“-Werte) sowie die Summe der geplanten Aufenthaltszeiten – jeweils
     im Format hh:mm (z. B. „5:05“ für 305 Minuten). So lässt sich auf einen
     Blick erkennen, wie viel der Gesamtreise auf reines Fahren bzw. auf
     Aufenthalte entfällt.
   - **Route auf der Karte**: Direkt zwischen der „Geplante Gesamt-Abfahrt“-
     Zeile und der Haltepunkt-Tabelle erscheint automatisch eine Karte
     (Leaflet + OpenStreetMap-Kacheln, kostenlos, kein API-Key), sobald
     mindestens zwei Haltepunkte eine Koordinate haben. Sie zeigt:
     - **Nummerierte Marker** in der Reihenfolge der Haltepunkte (1, 2, 3 …,
       identisch zur Zeilennummer in der Tabelle), farblich passend zum
       Zeilenstatus (blau = normal, orange = auffällige Fahrzeit, rot =
       nicht gefunden). Ein Klick auf einen Marker zeigt den Namen des
       Haltepunkts in einem Popup.
     - Die **tatsächliche Fahrstrecke** als Linie, sobald „Fahrzeiten
       automatisch berechnen“ ausgeführt wurde (OSRM liefert dafür die
       reale Straßen-Geometrie); vorher bzw. nach einer manuellen
       Positions-Korrektur wird ersatzweise eine gerade Verbindungslinie
       zwischen den Haltepunkten gezeigt, bis erneut berechnet wird.
     - Die Karte ist **direkt eingebettet** (kein Klick/Popup zum Öffnen
       nötig) und normal mit Zoom/Verschieben bedienbar – das ermöglicht
       eine schnelle visuelle Plausibilitätsprüfung der gesamten Route,
       ohne einen zusätzlichen Dialog öffnen zu müssen. Die genaue
       Straßen-Geometrie wird nicht dauerhaft gespeichert (nur die
       Koordinaten der Haltepunkte); nach einem Neuladen der Seite zeigt
       die Karte bis zur nächsten Berechnung daher zunächst gerade Linien.

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
   - **„Zurück auf die Hauptseite“**: Oben rechts im Bereich „Aktueller
     Haltepunkt“ gibt es einen Button, der zurück zur Planungsseite (Schritt
     1/2) führt, ohne die laufende Route zu beenden oder Daten zu verlieren.
     Auf der Planungsseite erscheint dann zusätzlich ein Button „Zurück zur
     Live-Ansicht“, um jederzeit wieder zurück zu Schritt 3 zu wechseln –
     z. B. um zwischendurch einen Haltepunkt zu ergänzen oder die Karte
     anzusehen, ohne die Route neu starten zu müssen.

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

5. **PDF-Export (Karte + Tabelle)**
   - Der Button „Als PDF exportieren (Karte + Tabelle)“ erzeugt **auf
     Verlangen** (kein automatischer Export) ein PDF mit genau zwei
     Inhalten: der aktuellen Routenkarte (als Bild, per **html2canvas**
     eingefangen) und der Haltepunkt-Tabelle inkl. Total-Zeile (als echte,
     durchsuchbare PDF-Tabelle, per **jsPDF** + **jsPDF-AutoTable**).
   - Läuft komplett im Browser, kein Server/Upload nötig; das PDF wird
     direkt als Datei heruntergeladen (`route-JJJJ-MM-TTThh-mm.pdf`).
   - Wurde noch keine Route berechnet (keine Karte sichtbar) oder lässt
     sich die Karte ausnahmsweise nicht als Bild einfangen, wird trotzdem
     ein PDF erzeugt – nur mit der Tabelle und einem entsprechenden
     Hinweistext anstelle der Karte. Der Export schlägt also nie komplett
     fehl.
   - Die Routenkarte zeichnet die Fahrstrecke bewusst auf einem
     `<canvas>`-Element statt als SVG (`preferCanvas: true`), damit die
     Linie im PDF-Bild exakt an der richtigen Stelle über den Kartenkacheln
     liegt – SVG-Ebenen werden vom verwendeten Bild-Werkzeug (html2canvas)
     sonst gelegentlich leicht versetzt eingefangen.

## Verwendete externe Dienste (alle kostenlos, ohne API-Key)

- **Nominatim** (`nominatim.openstreetmap.org`) – Geocoding der Ortsnamen
  in Koordinaten. Hinweis: öffentlicher Dienst mit Nutzungsrichtlinie
  (max. ca. 1 Anfrage/Sekunde), daher läuft die Auflösung der Haltepunkte
  in der App bewusst leicht verzögert nacheinander ab.
- **OSRM** (`router.project-osrm.org`) – Routing/Fahrzeitberechnung für
  Auto-Routen auf Basis von OpenStreetMap-Kartendaten.
- **Leaflet** + OpenStreetMap-Kartenkacheln – Anzeige der Routenkarte und
  des Karten-Auswahl-Dialogs.
- **jsPDF** + **jsPDF-AutoTable** + **html2canvas** (alle per CDN, nur im
  Browser des Nutzers aktiv) – Erstellung des PDF-Exports (Karte + Tabelle).

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
      geoSuspicious,     // true = Fahrzeit zu diesem Halt > 2 Std., Position sollte geprüft werden (orange Zeile)
      resolvedName,       // per Reverse-Geocoding ermittelter Klartext-Ortsname, nur wenn der Name eine reine Koordinate ist
      resolvedNameFailed, // true = Reverse-Geocoding für diese Koordinate ist fehlgeschlagen
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
