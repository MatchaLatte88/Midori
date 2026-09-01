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
5. Oben **Replay**, um denselben Chart Bar für Bar von Hand durchzuhandeln, oder **Backtest**,
   um eine Strategie darüber laufen zu lassen.

Ein Monat 1m-Daten sind etwa 44.600 Bars und rund 2 MB; ein Jahr lädt in ein bis zwei
Minuten.

## Indikatoren

Vorhanden sind SMA, EMA, Bollinger Bands, RSI, ATR, VWAP, Fair Value Gaps, Inverted Fair
Value Gaps, Handelssessions, Stop Hunts, Silver Bullet, Ranges und das Volume Profile mit POC
und Value Area — als festes Profil am rechten Rand und als **Range Profile**, das du über eine
selbst gezogene Spanne legst. Oszillatoren bekommen eine eigene Chart-Ebene, damit eine
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
- **Ranges** markieren die Strecken, auf denen der Markt stehen bleibt — und zwar passend zu
  dem Chart, den du gerade ansiehst. Eine Stunden-Range wird im 1m-Chart **nicht** markiert:
  Statt einer festen Prozentspanne (die auf 1m alles markiert und auf 1h nichts) wird die
  Höhe daran gemessen, wie weit dieser Markt in derselben Anzahl Bars normalerweise kommt.
  Eine Range braucht außerdem eine Mindestlänge und **beide Kanten mehrfach berührt** — sonst
  wäre jede schmale Diagonale eine. Sie endet an der Bar, die jenseits einer Kante schließt;
  Dochte durch die Kante verbreitern sie nur. Gezeichnet werden Box, Equilibrium und der
  Ausbruch samt Richtung, und eine noch laufende Range zieht ihre Kanten gestrichelt bis zum
  rechten Rand.
- **Silver Bullet** setzt die Bausteine zu einem fertigen Setup zusammen: ein Sweep holt
  Liquidität, die Umkehr reißt eine FVG, der Preis schließt jenseits der letzten Gegenkerze,
  und der Einstieg liegt beim Rücktest der Lücke — alles in einer der drei Silver-Bullet-Stunden
  nach New Yorker Zeit. Entry, Stop und Ziel werden gleich mitgezeichnet, samt Ausgang. Der
  Ausgang ist eine pessimistische Schätzung: Trifft eine Bar Stop und Ziel, gilt der Stop.
  Genau abrechnen kann das nur die Engine, die dafür Minutenbars nachlädt.
- **Backtests** laufen über den Reiter *Backtest* auf dem Symbol und Timeframe, den der Chart
  gerade zeigt. Du setzt Startkapital, Zeitraum, Risiko je Trade (Prozent oder fester Betrag),
  das Chance-Risiko-Verhältnis und einen Hebeldeckel — der steht auf 1, weil risikobasierte
  Größen bei engen Stops sonst das Zwanzigfache des Kontos verlangen und die Gebühren darauf
  das Ergebnis bestimmen. Ergebnisse landen unter *Results*: Equity ab null, Winrate, PnL,
  Drawdown, Profitfaktor, Serien und die Aufschlüsselung nach Richtung, Fenster und Ausgang.
  Mit Strg-Klick vergleichst du mehrere Läufe in Prozent — in Geld wäre der Lauf mit dem
  größeren Startkapital immer im Vorteil.
  Unter den Kennzahlen steht, **womit der Lauf lief** — Markt, Zeitraum, Startkapital, jeder
  Strategieparameter und die berechneten Kosten —, damit sich zwei Ergebnisse überhaupt
  vergleichen lassen.
  Bei einem einzelnen Lauf schaltest du oben zwischen *Analysis* und *Trades* um: Dort springt
  der Chart auf den ersten Trade und zeichnet ihn als Positionsblock — Risikozone zum Stop,
  Gewinnzone zum Ziel, Marken an Ein- und Ausstieg —, mit Kontext davor und danach. „Next
  trade" geht zum nächsten.
- Der **Auto-Backtest** probiert Wertebereiche durch: Du schaltest jeden Zahlenparameter
  einzeln von *Fixed* auf *Range* und gibst von/bis/Schritt an; die App rechnet jede
  Kombination und stellt die besten vier den schlechtesten vier gegenüber. Sie läuft auf einem
  eigenen Thread, zeigt Fortschritt samt Restzeit und lässt sich jederzeit stoppen.
  Jede gezeigte Kombination hat einen **Use**-Knopf: Er trägt die Werte samt Markt und
  Zeitraum ins Backtest-Formular ein und wechselt dorthin — dort bekommst du Trade-Durchsicht
  und einen gespeicherten Report.
  **Sweep-Ergebnisse selbst werden nicht gespeichert** — sie leben so lange wie die Ansicht. Eine
  Kombination, die du behalten willst, rechnest du im Backtest-Tab nach; der wird gespeichert.
  **Wichtig ist die Out-of-Sample-Spalte:** Gerankt wird auf dem früheren Teil des Zeitraums,
  die gezeigten Kombinationen werden auf dem späteren nachgerechnet. Wo die beiden Zahlen
  auseinandergehen, war die erste Zufall. FVG-Größe 4–20 mal CRV 1,2–3,0 sind 323
  Kombinationen und brauchen auf einem Jahr BTC-5m rund 23 Sekunden.
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

## Replay

**Replay** oben in der Leiste: Startdatum und Startkapital wählen, dann geht es Bar für Bar
vorwärts — Leertaste spielt und pausiert, Pfeil rechts geht einen Schritt, 1 bis 30 Bars pro
Sekunde. Alles vor dem Abspielkopf steht zum Lesen da, alles danach existiert für die Sitzung
nicht: Die Indikatoren rechnen nur über die aufgedeckten Bars, weil sie die anderen gar nicht
bekommen.

Gehandelt wird links im Ticket: Market, Limit oder Stop, Stop und Ziel per Klick vom Chart
(⌖ arme das Feld, dann auf den Preis klicken). Die **Größe folgt aus dem Risiko** — dieselbe
Rechnung wie bei den Strategien, also ist ein von Hand genommener Trade bei gleichem Stop
genauso groß wie ein vom Bot genommener. Ohne Stop gibt es keine definierte Risikogröße, und
der Knopf bleibt aus.

**Oder schnell rein und die Level danach hinlegen.** Oben links im Chart stehen **Buy** und
**Sell** mit einem Größenfeld dazwischen (die Pfeile gehen um 1, alles Feinere tippst du). Ein
Klick ist eine Market-Order ohne Stop und ohne Ziel. Sie steht **sofort** gestrichelt im Chart —
mit Richtung, Größe und dem Hinweis, dass sie auf der nächsten Bar füllt; gefüllt wird sie
nämlich weiterhin erst dort, wie jede andere Order auch. Stop und Ziel kommen gleich danach, mit
der Maus:

**Stop und Ziel ziehst du im Chart.** Die Positionslinie ist immer greifbar; von ihr nach unten
oder oben wegziehen legt das Level an, das dort hingehört — unter dem Markt schützt einen Long
und nimmt bei einem Short Gewinn mit, darüber umgekehrt. Ein Level, das schon liegt, wird genauso
verschoben. Während die Maus unten ist, ändert sich nichts am Konto; erst das Loslassen schickt
die Order, ab der nächsten Bar wie jede andere. Ein Level auf der falschen Seite des letzten
Preises wird abgelehnt und sagt warum — es hätte die Position geschlossen statt sie zu schützen.

**Die Preise stehen auf der Preisachse**, wo du ohnehin nach ihnen siehst — Einstieg, Stop und
Ziel, jeder in seiner Farbe. Die Marken am Block sagen dafür, was ein Level *wert* ist: was der
Stop kostet und was das Ziel einbringt, beides in $ und in R. Der Stop ist dabei −1,00R, denn
genau er ist das R, gegen das alles andere gerechnet wird. Die Marke der Position selbst trägt
Richtung, Größe und das offene Ergebnis: `L 0,05  +$142,30  +0,57R`.

**Ganz rechts auf der Positionslinie sitzt ein ×.** Ein Klick darauf schließt die Position zu
Markt — dasselbe wie „Close" im Panel, nur ohne den Weg dorthin.

**Oder du zeichnest den Trade und schickst ihn ab.** Mit dem Positionswerkzeug Entry, Stop und
Ziel ziehen, dann **Rechtsklick auf den Block**:

- **Pending order** — wartet auf dem gezeichneten Entry, mit den gezeichneten Leveln. Ob Limit
  oder Stop, ergibt sich daraus, wo der Entry zum aktuellen Preis liegt.
- **Market order** — jetzt rein, mit den gezeichneten **Abständen**. Ein vor einer Stunde
  gezeichneter Block hat einen überholten Entry; seine Form — Risiko und Ziel in Punkten — ist
  das, was noch zählt, und die wandert an den aktuellen Preis. Gemessen wird am tatsächlichen
  Fill, Spread und Slippage inbegriffen, damit „Risiko 500" auch 500 kostet, wenn die nächste
  Bar wegspringt.

Stop und Ziel einer wartenden Order gehen erst in den Markt, wenn der Einstieg füllt — vorher
gäbe es nichts zu schützen. **Deine Zeichnung verschwindet in dem Moment, in dem der Einstieg
füllt**, und ab da zeichnet die Engine die Position. Solange die Order nur wartet, bleibt der
Block stehen: Er ist dann das Einzige, was zeigt, wo Stop und Ziel hinkommen. Wird die Order
storniert, bleibt er ebenfalls — eingestiegen wurde ja nicht.

Deine Orders laufen durch **dieselbe Engine** wie ein Backtest: Sie füllen frühestens auf der
Bar nach der, die du gerade ansiehst, mit Spread, Slippage und Kommission, und eine Bar, die
Stop und Ziel berührt, wird über ihre Minuten entschieden. **Save session** legt die Sitzung als
Lauf in dieselbe Bibliothek wie die Backtests — damit lässt sie sich direkt daneben legen.

## Läufe vergleichen

Im Reiter **Results** mehrere Läufe mit Ctrl-Klick auswählen. Die Kurven liegen auf einer
**Zeitachse** übereinander, in Prozent des jeweiligen Startkapitals; wahlweise als Kalender
(wer lag im März vorn) oder mit ausgerichteten Starts (für Läufe aus verschiedenen Zeiträumen).
Umschaltbar zwischen Equity und Drawdown, mit Ablesung unter dem Zeiger.

Darunter die Kennzahlen nebeneinander — die beste Zelle je Zeile ist markiert, und zwar in der
Richtung, in der die Zeile gelesen wird, sodass nicht der tiefste Drawdown gewinnt. Und der
**Settings-Diff**: was sich zwischen den Läufen tatsächlich unterscheidet, standardmäßig ohne
die Zeilen, die gleich geblieben sind.

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
  engine/           backtest.js (Loop), sweepRunner.js, sweepManager.js
  ipc.js            einzige Brücke zum Renderer
  main.js           Fenster, titleBarOverlay
shared/
  engine/broker.js  Orders, Fills, Position — von Backtest und Replay gemeinsam genutzt
  engine/           summary.js (Kennzahlen), replaySession.js (Abspielkopf, Konto)
  engine/           plannedTrade.js — aus einer gezeichneten Position wird eine Order
  indicators/       von Chart und Engine gemeinsam genutzt: index.js, volumeProfile.js
  strategies/       backtestbare Regeln: Registry, Risiko/Sizing, silverBullet.js
  analysis/sweep.js Kombinationen, Ranking, Zeitraum-Split — ohne Engine testbar
  analysis/         Kennzahlen eines fertigen Laufs, Vergleich mehrerer Läufe (compare.js)
strategies/       Beispielstrategien (sma-cross.js)
src/
  components/       ChartPanel, DataManager, IndicatorPanel, DrawingToolbar
  components/chart/ volumeProfilePrimitive.js — Canvas-Plugin für das Profil
  components/chart/ fvgPrimitive.js, sessionPrimitive.js, huntPrimitive.js, setupPrimitive.js
  components/chart/ replayPrimitive.js — offene Position und wartende Orders
  components/chart/drawings/  Geometrie, Modell, Rendering und Maussteuerung
  components/       LineStyleBar, PositionStyleBar — Stilleisten über dem Chart
  components/       BacktestPanel, ResultsPage — Läufe starten und vergleichen
  components/       ReplayBar, ReplayPanel — Transport, Konto und Ticket
  components/       ChartContextMenu — Rechtsklick-Menü über dem Chart
  stores/session.js Symbol, Timeframe, Bibliothek, aktive Indikatoren
  stores/replay.js  Abspielkopf, Fenster, Minuten-Cache, Order-Aktionen
  styles/           Katsumii „Living Data" — tokens.css, base.css, fonts.css
scripts/            Werkzeuge: Smoke-Test, Backtest-Runner, Versions-Sync
test/               node:test — Store, Aggregation, Parser, Indikatoren, Profil, Engine,
                    Replay, Vergleich, Zeichnungen, Versionierung
```

Details und Begründungen der Entscheidungen: [ARCHITECTURE.md](ARCHITECTURE.md).

## Stand

M0 bis M2 stehen: Datenbeschaffung, Speicherung, Aggregation, Chart, Indikatoren, Volume
Profile, Zeichenwerkzeuge, die Order-Engine samt Backtest-Loop und Sweeps, sowie Replay —
Bar für Bar von Hand handeln auf derselben Engine, mit gespeicherten Sitzungen, die neben den
Backtests im Vergleich stehen.

Offen sind der Bot-Editor für eigene Strategien (M3), risikoadjustierte Kennzahlen und ein
Benchmark (M4) sowie weitere Datenquellen (M5) — siehe ARCHITECTURE.md, Abschnitt 11.
