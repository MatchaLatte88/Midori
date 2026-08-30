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

Vorhanden sind SMA, EMA, Bollinger Bands, RSI, ATR, VWAP, Fair Value Gaps, Inverted Fair
Value Gaps, Handelssessions und das Volume Profile mit POC und Value Area — als festes Profil
am rechten Rand und als **Range Profile**, das du über eine selbst gezogene Spanne legst. Oszillatoren bekommen eine eigene Chart-Ebene, damit eine
0–100-Skala nie mit Preisen zusammengelegt wird.

Jede Einstellung erklärt sich selbst: Fahre mit der Maus über ein Feld im Indikator-Panel,
und der Tooltip sagt, was der Wert bewirkt.

Zwei Dinge sind dabei bewusst so gebaut:

- Indikatoren liegen in `shared/indicators/` und werden vom Chart **und** später von der
  Backtest-Engine importiert. Eine zweite Implementierung könnte abweichen — und dann würde
  der Bot etwas anderes handeln, als du auf dem Chart siehst.
- **Fair Value Gaps** merken sich getrennt, wo die Lücke liegt und ab welcher Bar sie
  überhaupt bekannt war. Nur so kann eine Strategie sie nicht zwei Bars zu früh handeln.
  Wann eine Lücke als gefüllt gilt (Berührung, Mittellinie, ganz durchlaufen), stellst du
  selbst ein — ebenso, ob nur die Lücken der letzten N Bars gezeigt werden und wie breit die
  Box gezeichnet wird. 0 heißt bei beiden „kein Limit". Die Mindestgröße einer Zone gibst du
  wahlweise in Prozent oder in Punkten an. **Inverted FVGs** sind Lücken, durch
  die der Preis geschlossen hat: aus gescheiterter Unterstützung wird Widerstand. Sie
  verschwinden nicht, wenn der Preis sie testet — das ist ihr Zweck —, sondern erst, wenn er
  jenseits von ihnen schließt. Beide Indikatoren lesen dieselbe Lückendefinition, und beide
  Farben wählst du selbst.
- **Sessions** (Asia, London, New York — als Futures- oder Forex-Satz, oder selbst
  definiert) kennen die Zeitzone ihres Marktes, nicht eine feste UTC-Stunde. Wenn irgendwo
  die Uhren umgestellt werden, wandert die Session mit.
- **Stop Hunts** markieren Niveaus, durch die der Preis gelaufen ist, um Stops zu füllen,
  und hinter die er dann zurückgekehrt ist. Als Liquidität zählen wahlweise Swing-Punkte,
  gleiche Hochs/Tiefs (die eigentlichen Cluster) und die Extrema abgeschlossener Sessions —
  einzeln zuschaltbar. Du stellst ein, wie viele Bars der Preis für die Rückkehr hat und wie
  lange sie danach halten muss; ein Durchstoß ohne Rückkehr ist kein Hunt, sondern ein
  Bruch, und wird nicht gezeigt. Auch hier ist getrennt, wo das Niveau liegt und ab welcher
  Bar es überhaupt bekannt war.
- **Silver Bullet** setzt die Bausteine zu einem fertigen Setup zusammen: ein Sweep holt
  Liquidität, die Umkehr reißt eine FVG, der Preis schließt jenseits der letzten Gegenkerze,
  und der Einstieg liegt beim Rücktest der Lücke — alles in einer der drei Silver-Bullet-Stunden
  nach New Yorker Zeit. Entry, Stop und Ziel werden gleich mitgezeichnet, samt Ausgang. Der
  Ausgang ist eine pessimistische Schätzung: Trifft eine Bar Stop und Ziel, gilt der Stop.
  Genau abrechnen kann das nur die Engine, die dafür Minutenbars nachlädt.
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

**Position**: vom Entry zum Stop ziehen — nach unten ergibt einen Long, nach oben einen Short.
Das Ziel setzt sich auf 2R und ist danach frei verschiebbar wie die anderen beiden Anker. Die
Stop-Seite ist rot, die Ziel-Seite gruen. Beschriftet wird innerhalb des Blocks: TP und SL mit
Preis und Prozentabstand, der Entry auf der Chancen-Seite, und Richtung plus
Chance-Risiko-Verhaeltnis direkt an der Entry-Linie in der roten Zone.

Es gibt bewusst nur *ein* Positionswerkzeug: Zieht man das Ziel ueber den Entry, wird aus dem
Long ein Short, und die Beschriftung folgt dem Bild. Die Richtung wird nicht gespeichert,
sondern aus den Ankern gelesen.

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
  components/chart/ fvgPrimitive.js, sessionPrimitive.js, huntPrimitive.js, setupPrimitive.js
  components/chart/drawings/  Geometrie, Modell, Rendering und Maussteuerung
  components/       LineStyleBar, PositionStyleBar — Stilleisten über dem Chart
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
