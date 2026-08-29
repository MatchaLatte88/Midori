# Midori

Lokales Backtesting und Trading-Bot-Entwicklung als Desktop-App. Marktdaten kommen aus
kostenlosen öffentlichen Archiven auf den eigenen Rechner, Strategien laufen als
JavaScript. Kein Abo, kein Konto, keine Cloud.

## Voraussetzungen

- Node.js ≥ 20 (entwickelt mit 24)
- Windows (Electron; macOS/Linux ungetestet)

## Setup

```powershell
npm install
```

Danach genügt ein Doppelklick auf **`start.bat`** — das Skript installiert bei Bedarf die
Abhängigkeiten, startet den Dev-Server auf Port 5300, öffnet die App und räumt den Server
beim Schließen wieder ab. `start.bat /build` läuft stattdessen gegen den Produktions-Build.

Alternativ direkt über npm:

```powershell
npm run app       # Vite auf Port 5300 + Electron
```

Weitere Skripte:

```powershell
npm test          # node --test (Store, Aggregation, Binance-Parser, Engine, Zeichnungen)
npm run dev       # nur Vite
npm run build     # Renderer nach dist/
node scripts/smoke.js BTCUSDT 2024-01-01 2024-02-01   # echter Download in ein Temp-Verzeichnis
node scripts/check-migration.js                       # installierte Datensaetze pruefen (read-only)
node scripts/backtest.js sma-cross BTCUSDT 1h         # Strategie auf lokalen Daten laufen lassen
npm run sync:version                                  # version.json in alle abgeleiteten Dateien schreiben
npm run check:version                                 # auf Versions-Drift pruefen (schreibt nichts)
```

## Version und Changelog

`version.json` im Root ist die einzige von Hand gepflegte Version. Alles andere —
`package.json`, `package-lock.json` und `src/generated/version.js` — wird daraus mit
`npm run sync:version` erzeugt und darf nicht von Hand editiert werden.

Die Versionsnummer steht links oben neben dem Namen; ein Klick oeffnet die Release Notes aus
`src/data/changelog.json`. Regeln und Begruendung: [docs/versioning-contract.md](docs/versioning-contract.md).

Fuer einen Release gibt es den Skill `/ship`: Version hochzaehlen, Changelog schreiben, Gates
laufen lassen, committen und pushen — in einem Schritt.

## Erste Schritte in der App

1. Links im Panel **Market data** ein Symbol eintragen (Binance-Schreibweise: `BTCUSDT`,
   nicht `BTC/USD`), Zeitraum wählen, **Download 1m history**.
2. Der Download holt Monatsarchive von `data.binance.vision`, prüft deren SHA256 und legt
   sie als Binärdatei unter `%APPDATA%/project-midori/market-data/` ab.
3. Symbol in der **Local library** anklicken, oben den Timeframe wählen. Nach links scrollen
   lädt ältere Bars nach.
4. Rechts das **Volume Profile** einschalten oder über **Add** einen Indikator auflegen.

Ein Monat 1m-Daten sind etwa 44.600 Bars und rund 2 MB; ein Jahr lädt in ein bis zwei
Minuten.

## Indikatoren

Vorhanden sind SMA, EMA, Bollinger Bands, RSI, ATR, VWAP und das Volume Profile mit POC und
Value Area. Oszillatoren bekommen eine eigene Chart-Ebene, damit eine 0–100-Skala nie mit
Preisen zusammengelegt wird.

Zwei Dinge sind dabei bewusst so gebaut:

- Indikatoren liegen in `shared/indicators/` und werden vom Chart **und** später von der
  Backtest-Engine importiert. Eine zweite Implementierung könnte abweichen — und dann würde
  der Bot etwas anderes handeln, als du auf dem Chart siehst.
- Das **Volume Profile rechnet immer auf 1m-Bars**, egal welchen Timeframe der Chart zeigt.
  Wer stattdessen die angezeigten Bars profiliert, bekommt auf dem 4h-Chart einen anderen
  POC als auf dem 5m-Chart.

Das Profil kennt drei Ansichten: Gesamtvolumen, Kauf gegen Verkauf, und reines Delta. Die
Aufteilung stammt aus dem Taker-Buy-Volumen, das Binance in seinen Archiven mitliefert.

**Vor dem 29.08.2026 geladene Datensätze haben diese Aufteilung nicht** — sie funktionieren
weiter, zeigen aber kein Delta. Die Bibliothek im Datenpanel weist das pro Symbol aus; ein
erneuter Download desselben Zeitraums rüstet es nach.

## Backtesting

Die Order-Engine liegt unter `electron/engine/` und traegt beides: Replay und Bots. Eine
Strategie ist ein JS-Modul mit `onBar(ctx)`; Beispiel in `strategies/sma-cross.js`.

```js
export const indicators = {
  fast: { id: 'sma', params: { period: 20 } },
  slow: { id: 'sma', params: { period: 50 } },
};

export function onBar(ctx) {
  if (!ctx.isFlat) return;
  if (ctx.ind('fast', 1) <= ctx.ind('slow', 1) && ctx.ind('fast') > ctx.ind('slow')) {
    ctx.buy({ size: 0.1, stopLoss: ctx.bar.close * 0.99 });
  }
}
```

Die Strategie bekommt nie das Bar-Array, nur `ctx.history(n)` und `ctx.ind(name, back)` —
beide enden bei der aktuellen Bar. Look-ahead ist nicht verboten, sondern nicht erreichbar.
Und eine Order fuellt fruehestens auf der Bar nach ihrer Platzierung.

**Fills werden auf den 1m-Bars aufgeloest.** Wenn eine 1h-Bar Stop und Ziel beruehrt, laeuft
die Engine die sechzig Minuten durch und nimmt, was zuerst erreicht wurde, statt zu raten.
An echten Daten (BTCUSDT, 1h, drei Monate, enge Klammern) entschied das 103 von 1699 Trades
anders — 6 Prozentpunkte Trefferquote. Wo keine feineren Daten existieren, gilt die
pessimistische Regel, und jeder Fill vermerkt in `resolution`, wie er zustande kam.

## Zeichenwerkzeuge

Links am Chart: Trendlinie, Strahl, horizontale und vertikale Linie, Rechteck, Fibonacci-
Retracement, Messwerkzeug sowie Long- und Short-Position. Werkzeug waehlen, ziehen, fertig —
danach springt die Leiste zurueck auf den Cursor.

**Long/Short-Position**: vom Entry zum Stop ziehen. Das Ziel setzt sich auf 2R und ist danach
frei verschiebbar wie die anderen beiden Anker. Die Stop-Seite ist rot, die Ziel-Seite gruen,
und der Block zeigt Entry, SL, TP mit Prozentabstand sowie Risiko, Chance und
Chance-Risiko-Verhaeltnis.

Ist ein Block ausgewaehlt, erscheint oben links am Chart eine Leiste fuer **Gewinnfarbe,
Verlustfarbe und Deckkraft**. Die Einstellung gehoert zur einzelnen Zeichnung und gilt zugleich
als Vorgabe fuer den naechsten Block.

## Hell und Dunkel

Oben rechts in der Titelleiste: Hell, Dunkel oder dem System folgen. Die Wahl gilt fuer die
gesamte App einschliesslich des nativen Fensterrahmens und bleibt ueber Neustarts erhalten. Mit dem Cursor lassen sich Zeichnungen anklicken, verschieben und an
ihren Ankerpunkten anfassen; `Entf` loescht die Auswahl, `Esc` bricht ab. Die Farbfelder
faerben die Auswahl um, wenn eine besteht.

Die Werkzeuge sind selbst gebaut — die Leiste von TradingView gehoert zur Charting Library,
die fuer Konkurrenzprodukte nicht lizenziert ist.

Zeichnungen haengen an `(Zeit, Preis)`, nicht an Pixeln: Sie bleiben beim Zoomen, Scrollen und
beim Wechsel des Timeframes an derselben Stelle. Gespeichert wird pro Symbol unter
`%APPDATA%/project-midori/drawings/` — getrennt von den Kerzen, damit ein erneuter Download
keine Annotationen mitnimmt.

## Woher die Daten kommen

Midori liefert selbst keine Marktdaten aus — die App lädt auf deine Anweisung in dein
eigenes Benutzerverzeichnis. Aktuell implementiert ist Binances öffentliches Archiv
(kein API-Key, kein Konto). Geplant: Dukascopy für Forex, CSV-Import für Futures, Alpaca
für US-Aktien.

Live-Daten sind kein Ziel. Historie bis gestern genügt fürs Backtesting.

## Aufbau

```
electron/
  data/providers/   Quellen-Adapter (binance.js)
  data/store/       barStore.js — Binärformat, Merge, Timeframe-Aggregation
  engine/           broker.js (Orders, Fills, Position), backtest.js (Loop, Kennzahlen)
  ipc.js            einzige Brücke zum Renderer
  main.js           Fenster, titleBarOverlay
shared/
  indicators/       von Chart und Engine gemeinsam genutzt: index.js, volumeProfile.js
strategies/       Beispielstrategien (sma-cross.js)
src/
  components/       ChartPanel, DataManager, IndicatorPanel, DrawingToolbar
  components/chart/ volumeProfilePrimitive.js — Canvas-Plugin für das Profil
  components/chart/drawings/  Geometrie, Modell, Rendering und Maussteuerung
  stores/session.js Symbol, Timeframe, Bibliothek, aktive Indikatoren
  styles/           Katsumii „Living Data" — tokens.css, base.css, fonts.css
scripts/            Werkzeuge: Smoke-Test, Backtest-Runner, Versions-Sync
test/               node:test — Store, Aggregation, Parser, Indikatoren, Profil, Engine,
                    Zeichnungen, Versionierung
```

Details und Begründungen der Entscheidungen: [ARCHITECTURE.md](ARCHITECTURE.md).

## Stand

M0 und M1 stehen: Datenbeschaffung, Speicherung, Aggregation, Chart, Indikatoren, Volume
Profile und die Order-Engine samt Backtest-Loop. Die Engine laeuft bisher nur ueber die
CLI — Anbindung an die Oberflaeche, Replay und der Bot-Editor sind die naechsten Schritte
(siehe ARCHITECTURE.md, Abschnitt 11).
