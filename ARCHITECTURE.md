# Midori — Architektur

Lokales Backtesting und Trading-Bot-Entwicklung als Desktop-App. Einmalkauf statt Abo,
keine Cloud, keine Anmeldung. Zwei Arbeitsweisen auf einem Kern: **Replay** (Bar für Bar
vorspulen, manuell traden — das FX-Replay-Prinzip) und **Bots** (dieselbe Order-Engine,
Signale kommen aus JavaScript statt aus Klicks).

## 1. Bausteine

| Baustein | Wahl | Lizenz | Begründung |
|---|---|---|---|
| Shell | Electron 43 | MIT | Gleicher Stack wie Acrobar, Node 24 vorhanden |
| UI | Vue 3 + JavaScript | MIT | Ein Framework für beide Apps |
| Chart | lightweight-charts 5 | Apache 2.0 | Einzige freie Chart-Lib mit echter Finanz-Performance |
| Build | Vite 8 | MIT | |
| ZIP | fflate | MIT | Kein natives Modul, 8 kB |
| Fonts | Inter, DM Mono, Plus Jakarta Sans | OFL 1.1 | Self-hosted, keine externen Requests |

Keine nativen Module. Das ist eine bewusste Einschränkung: jedes native Modul muss bei
jedem Electron-Update neu gebaut werden und verkompliziert das Signieren des Installers.
Deshalb auch kein DuckDB (siehe Abschnitt 3).

UI-Sprache ist Englisch, das Design folgt der „Living Data"-Sprache der Katsumii-App
(Abschnitt 10).

## 2. Warum Marktdaten nie mitgeliefert werden

Der kommerzielle Knackpunkt liegt nicht im Code, sondern in den Datenlizenzen. Praktisch
jeder freie Anbieter untersagt die Weiterverbreitung seiner Daten. Midori umgeht das nicht,
sondern vermeidet es strukturell:

**Midori liefert keine Marktdaten aus und speichert keine auf fremden Servern.** Die App
lädt auf Anforderung des Nutzers in dessen eigenes Benutzerverzeichnis. Damit ist Midori
ein Werkzeug wie ein Texteditor, kein Datenprodukt — und verkaufbar, ohne Datenlizenzen zu
erwerben.

Daraus folgt die Provider-Architektur: jede Quelle ist ein austauschbares Modul in
`electron/data/providers/`, CSV-Import ist gleichberechtigt und kein Notbehelf.

| Markt | Quelle | Auflösung | Status |
|---|---|---|---|
| Krypto | `data.binance.vision` (öffentliches Archiv) | 1m ab 2017 | **implementiert** |
| Forex | Dukascopy-Datafeed | Tick/1m ab ~2003 | geplant |
| US-Aktien | Alpaca (Key des Nutzers, 15 Min verzögert) | 1m, 7+ Jahre | geplant |
| Futures | CSV-Import | beliebig | geplant |

Live-Daten sind ausdrücklich kein Ziel. Für Backtesting genügt Historie bis gestern; das
erspart Börsen-Lizenzverträge, die für ein Einmalkauf-Produkt nicht finanzierbar wären.

### Binance-Fallstricke, die verifiziert wurden

- **Zeiteinheit wechselt.** Archive bis 2024 tragen Millisekunden, ab 2025 Mikrosekunden
  (geprüft: BTCUSDT 2023-01 vs. 2025-06). Ohne Erkennung landen neuere Daten im Jahr 57385.
  `normalizeTime()` in `binance.js`, abgesichert in `test/binance.test.js`.
- **Der laufende Monat hat keine Monatsdatei.** Er wird aus Tagesarchiven gefüllt.
- **Jedes Archiv hat eine `.CHECKSUM`.** Wird geprüft; fehlt sie (ältere Archive), ist das
  kein Abbruchgrund, eine Abweichung dagegen schon.
- Ein 404 auf einen Monat heißt „das Symbol war da noch nicht gelistet" und wird als
  `missing` zurückgemeldet, nicht verschluckt.

## 3. Datenhaltung

Eine flache Binärdatei pro Symbol, ausschließlich in der Basis-Auflösung 1m:

```
<userData>/market-data/BTCUSDT-1m.bin        Float64Array, stride 7
<userData>/market-data/BTCUSDT-1m.meta.json  Symbol, Format, Anzahl, Zeitraum, Quelle
```

Pro Bar `[ timeMs, open, high, low, close, volume, buyVolume ]` = 56 Byte. Fünf Jahre 1m
sind ~147 MB und werden in einem Rutsch gelesen. Gemessen: 44.640 Bars schreiben in 13 ms,
ein Monat 15m-Bars aggregieren in 9 ms.

`buyVolume` ist der Anteil am Volumen, bei dem der Käufer der Aggressor war (Taker).
Verkaufsvolumen ist `volume - buyVolume`, Delta die Differenz. Quellen ohne diese Angabe
speichern **NaN, nicht 0** — eine Null würde behaupten, jeder Trade sei ein Verkauf gewesen,
und ein Delta-Profil würde massiven Verkaufsdruck zeigen, den es nie gab. Diese
Unterscheidung zieht sich durch: Aggregation lässt NaN durchschlagen (eine unbekannte Minute
macht den ganzen Bucket unbekannt), und das Profil führt pro Preisniveau mit, wieviel
Volumen überhaupt einen Split hat.

### Formatversionen

`meta.json` trägt `format`. v1 (stride 6, ohne `buyVolume`) stammt aus der Zeit vor dem
Delta und wird beim Lesen im Speicher auf das aktuelle Layout geweitet — mit NaN für den
nie erfassten Split. Die Datei selbst bleibt unangetastet, bis der nächste Merge sie ohnehin
neu schreibt; Lesen darf keine Nebenwirkungen auf der Platte haben. Eine unbekannte, höhere
Formatnummer wird mit einer Handlungsanweisung abgelehnt statt fehlinterpretiert.

Migrierte Daten bleiben also nutzbar, haben aber kein Delta. Die Bibliothek im Datenpanel
sagt das pro Datensatz an, statt es den Nutzer im Chart raten zu lassen.

**Höhere Timeframes werden nie gespeichert, sondern immer aggregiert.** Damit gibt es genau
eine Wahrheit pro Symbol und keine Möglichkeit, dass 15m- und 1m-Daten auseinanderlaufen.

Schreibvorgänge gehen in eine `.tmp`-Datei und werden umbenannt — ein Absturz mitten im
Schreiben darf keinen halben Datensatz hinterlassen. Beim Merge gewinnt bei gleichem
Zeitstempel der neuere Wert.

Kein DuckDB, kein SQLite: Die einzige Abfrage, die der Kern braucht, ist „Bereich nach
Zeit", und die ist eine Binärsuche. Eine Datenbank käme als natives Modul mit
Packaging-Kosten, ohne hier etwas zu lösen. Sobald Portfolio-Analytik über viele Symbole
nötig wird, ist das neu zu bewerten.

## 4. Die Look-Ahead-Frage

An dieser Stelle sterben Backtester. Wenn eine Strategie eine 15m-Bar sieht, die noch nicht
abgeschlossen ist, kennt sie deren High und Low, bevor sie entstanden sind — jede Strategie
sieht dann brillant aus und verliert live.

`aggregate()` unterscheidet deshalb zwei Aufrufer:

- **Die Engine** bekommt nur geschlossene Buckets (`dropIncomplete = true`). Ein Bucket
  gilt erst als geschlossen, wenn Daten bis zu seiner letzten Minute vorliegen *und* das
  angefragte Zeitfenster ihn ganz enthält.
- **Der Chart** darf die laufende Bar zeichnen (`dropIncomplete = false`).

Abgesichert durch `test/store.test.js` — insbesondere „aggregate does not let a bucket peek
past the requested end". Diese Tests sind keine Formsache; sie sind die Zusicherung, auf der
alle Ergebnisse der App beruhen.

Bekannte Grenze: Die Bucket-Grenzen liegen auf UTC. Das ist für 24/7-Krypto korrekt.
Sessionbasierte Märkte (Futures, Aktien) brauchen sessionbewusste Grenzen — offen, siehe
Abschnitt 12.

## 5. Prozesse

```
Electron main
  data/providers/    Quellen-Adapter (binance.js …)
  data/store/        barStore.js — Binärformat, Merge, Aggregation
  ipc.js             die einzige Brücke zum Renderer
  engine/broker.js   Orders, Fills, Position, Konto
  engine/backtest.js Der Loop: Fills vor Strategie, Kennzahlen
Renderer (Vue)
  stores/session.js  ausgewähltes Symbol, Timeframe, Bibliothek
  components/        ChartPanel, DataManager, IndicatorPanel, DrawingToolbar
  components/chart/  volumeProfilePrimitive.js, drawings/
```

Bewusst **kein HTTP-Server**. Ein lokaler Fastify-Server (wie im Vorgänger
`Backtester_Fable`) bedeutet einen offenen Port, Portkonflikte und eine Angriffsfläche, die
eine Desktop-App nicht braucht. Stattdessen `ipcMain.handle` mit `contextIsolation` und
`sandbox: true`; der Renderer sieht ausschließlich `window.midori`.

Fehler werden geworfen, nicht geloggt: Electron reicht eine geworfene Exception als
abgelehntes Promise an den Renderer, wo sie in der UI landet. Ein stiller Fallback würde
falsche Backtest-Ergebnisse erzeugen — die teuerste Fehlerart in diesem Produkt.

Lange Läufe (Backtests, Optimierung) gehören später in `utilityProcess` oder
`worker_threads`, damit die UI nie blockiert.

## 6. Indikatoren

Indikatoren liegen in `shared/indicators/` — bewusst weder unter `src/` noch unter
`electron/`. Zeichnete der Chart einen anderen gleitenden Durchschnitt als die Strategie
handelt, wäre jedes Backtest-Ergebnis eine Lüge, die auf dem Bildschirm richtig aussieht.
Es gibt genau eine Implementierung, importiert von beiden Seiten.

Jeder Indikator ist eine reine Funktion über das gesamte Bar-Array:

```
compute(bars, params) -> { [output]: Array<number|null> }
```

Die Ausgabe hat immer dieselbe Länge wie die Eingabe, mit `null` während der Aufwärmphase.
Gleiche Länge heißt: Index i gehört immer zu `bars[i]` — keine Offset-Buchhaltung an der
Aufrufstelle und keine Möglichkeit, versehentlich den Wert einer anderen Bar zu lesen.
Reine Funktionen statt inkrementellem Zustand sind zugleich der Grund, warum sich
Look-Ahead hier nicht einschleichen kann: Die Engine übergibt einer Strategie den Ausschnitt
`[0..i]`, nie das Ende.

Jeder Indikator exportiert ein deklaratives `params`-Schema; das Panel baut daraus seine
Eingabefelder. Neuer Indikator = ein Eintrag in `INDICATORS`, keine UI-Änderung.

Vorhanden: SMA, EMA, Bollinger Bands, RSI, ATR, VWAP (täglich/wöchentlich verankert).

### Volume Profile

Ein Profil ist nur so gut wie die Auflösung der Bars, aus denen es gebaut wird. Wer die
gerade angezeigten Bars profiliert, bekommt auf dem 4h-Chart eine gröbere Antwort als auf
dem 5m-Chart — gleicher Markt, anderer POC.

**Midori baut das Profil immer aus den 1m-Bars**, unabhängig vom angezeigten Timeframe. Der
Timeframe ändert die Kerzen, nie das Profil. Genau dafür ist die Datenhaltung aus
Abschnitt 3 ausgelegt.

OHLCV-Bars verraten nicht, zu welchem Preis innerhalb der Minute gehandelt wurde, also muss
das Volumen über die Spanne der Bar verteilt werden. Bei 1m-Bars ist diese Spanne klein und
der Fehler entsprechend gering — der Grund, warum die Basis-Auflösung hier mehr zählt als
irgendwo sonst in der App. Voreinstellung ist `uniform`: gleichmäßig über `[low, high]`,
gewichtet nach Bin-Überlappung. Das behauptet nichts darüber, wann innerhalb der Minute
gehandelt wurde. Alternativen: alles auf den Close, oder je ein Viertel auf O/H/L/C.

Die Value Area wächst vom POC aus nach außen und nimmt jeweils die schwerere Seite, bis der
gewünschte Volumenanteil erreicht ist (Einzel-Bin-Variante; die klassische Market-Profile-
Methode vergleicht Paare, bei den hier üblichen Bin-Zahlen ergibt das praktisch dieselben
Grenzen ohne Gleichstands-Sonderfall).

Gerechnet wird im Main-Prozess, wo die Daten ohnehin liegen — nur die fertigen Bins
überqueren die Bridge statt eines Jahres voller Minuten. Gemessen: 120 Bins über 44.640
1m-Bars in 6 ms. Gezeichnet wird über die Plugin-API von lightweight-charts als
Pane-Primitive auf `zOrder: bottom`, damit die Kerzen darüber lesbar bleiben.

Invariante, abgesichert in `test/volumeProfile.test.js`: **Die Summe aller Bins entspricht
dem eingegangenen Volumen.** Ein Verteilungsverfahren, das Volumen erfindet oder verliert,
verschiebt den POC — und der POC ist der eine Wert, auf den hin gehandelt wird.

### Delta

Liefert die Quelle den Taker-Buy-Anteil, trägt jedes Preisniveau zusätzlich Kauf-, Verkaufs-
und Delta-Volumen. Der Kaufanteil wird mit exakt denselben Gewichten verteilt wie das
Gesamtvolumen, damit beide Level für Level zusammenpassen (`buy + sell == total` an jedem
Niveau, im Test und im Smoke-Lauf geprüft).

Ein zweites Feld pro Bin führt mit, wieviel Volumen dort überhaupt aus Bars mit Split stammt.
Ohne dieses Feld wäre ein Niveau, das nur von migrierten Bars gespeist wird (Kauf = 0, weil
nie erfasst), nicht von einem Niveau zu unterscheiden, an dem tatsächlich niemand gekauft hat
— und würde als vollständig verkauft gezeichnet. `deltaCoverage` meldet den tatsächlich
abgedeckten Anteil, sodass ein teilweise migrierter Datensatz seine eigenen Grenzen ausweist.

Drei Darstellungen: Gesamtvolumen (Value Area eingefärbt), Kauf gegen Verkauf (gestapelt,
Gesamtlänge bleibt das Volumen) und reines Delta (Länge = Betrag, Farbe = Vorzeichen). Fehlt
der Split, fällt die Anzeige auf das Gesamtvolumen zurück — ein durchgehend leeres Delta sähe
sonst nach Gleichgewicht aus.

## 7. Zeichenwerkzeuge

Die Werkzeugleiste, die man von TradingView kennt, gehört zur *Charting Library* — und die ist
für Konkurrenzprodukte nicht lizenziert (Abschnitt 1). `lightweight-charts` bringt keine
Zeichenfunktionen mit. Sie sind deshalb selbst gebaut, über dieselbe Plugin-API wie das Volume
Profile.

Vorhanden: Trendlinie, Strahl, horizontale und vertikale Linie, Rechteck, Fibonacci-
Retracement, ein Messwerkzeug (Preisdifferenz, Prozent, Anzahl Bars) sowie Long- und
Short-Position.

### Positionswerkzeuge

Long und Short sind die einzigen Zeichnungen mit drei Preisen statt zwei Punkten: Entry, Stop
und Ziel. Gezogen wird nur vom Entry zum Stop — das Ziel setzt sich zunächst auf das Doppelte
des Risikos auf der Gegenseite, weil so ein Trade tatsächlich bemessen wird. Danach ist jeder
der drei Anker frei verschiebbar.

Gespeichert werden drei Anker, und Stop und Ziel teilen sich die rechte Kante. Wird einer von
beiden gezogen, muss der andere in der Zeit mitgehen, sonst reißt der Block auseinander;
`moveAnchor` behandelt das typspezifisch. Der Entry besitzt die linke Kante allein.

**Rot und Grün gelten hier — und nur hier.** Der Chart hält Kerzen bewusst in Blau/Weiß
(Abschnitt 10), damit Grün dem Akzent gehört. Ein Positionsblock ist aber keine Kerze, sondern
eine Fläche mit eindeutiger Bedeutung: Die Stop-Seite ist immer rot, die Ziel-Seite immer grün.
Die Farbe folgt der Bedeutung, nicht der Richtung — ein Short liest sich damit genauso herum
wie ein Long, und Risiko und Chance sind absolute Abstände.

Angezeigt werden Entry, Stop und Ziel mit Prozentabstand sowie Risiko, Chance und das
Chance-Risiko-Verhältnis. Sitzt der Stop auf dem Entry, ist das Verhältnis `null` statt
unendlich — es gibt dann kein Risiko, durch das sich teilen ließe.

### Ankerpunkte sind Markt-, keine Bildschirmkoordinaten

Jede Zeichnung speichert `(time, price)`-Paare. Eine auf dem 15m-Chart gezogene Trendlinie muss
auf denselben zwei Punkten liegen, wenn auf 4h umgeschaltet oder drei Monate zurückgescrollt
wird — das überlebt nur in Marktkoordinaten.

Die Umrechnung läuft über den logischen Bar-Index (`logicalToCoordinate` /
`coordinateToLogical`), nicht über `timeToCoordinate`: Letzteres kennt nur Zeitpunkte, die als
Bar existieren, und liefert für alles dazwischen oder danach `null`. Der logische Index
interpoliert zwischen Bars und lässt sich über die Bar-Breite auch nach vorne und hinten
verlängern — eine Linie darf über den rechten Rand hinauszeigen.

Getroffen wird dagegen in **Pixeln**: „innerhalb von sechs Pixeln der Linie" ist die Toleranz,
die ein Mensch erwartet. Sechs Dollar wären bei einem Pennystock ein Treffer und bei Bitcoin
ein Fehlgriff.

### Das Overlay-Problem

Eine transparente Ebene über dem Chart, die alle Zeigerereignisse abfängt, verschluckt auch
Verschieben und Zoomen — und ein Chart, den man nicht mehr ziehen kann, ist schlimmer als einer,
auf dem man nicht zeichnen kann. Eine Ebene, die nie Ereignisse bekommt, kann keine Zeichnung
verschieben.

Die Ebene ist deshalb standardmäßig durchlässig und schaltet sich nur ein, solange der Zeiger
tatsächlich über einer Zeichnung steht oder ein Werkzeug gewählt ist. Die Trefferprüfung läuft
auf einem gewöhnlichen `mousemove` des Chart-Elements, das durch eine Ebene mit
`pointer-events: none` hindurchreicht. Überall sonst behält der Chart seine eigenen Gesten.
Während ein Werkzeug aktiv ist, werden `handleScroll` und `handleScale` abgeschaltet — sonst
scrollt das Aufziehen eines Rechtecks den Chart.

### Speicherung

Eine JSON-Datei pro Symbol unter `<userData>/drawings/`, **getrennt von den Kerzendaten**: Ein
erneuter Download ersetzt Kerzen und darf dabei nicht ein Jahr Annotationen mitnehmen.

Zeichnungen gehören zum Symbol, nicht zum Timeframe. Ein Niveau, das auf dem Stundenchart
zählt, zählt auch auf dem Tageschart; eine Aufteilung nach Timeframe hieße, dieselbe Linie
viermal zu ziehen.

Der Symbolname kommt aus einem Textfeld und darf niemals einen Pfad formen. Erlaubt ist
`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` — Punkte innerhalb sind zulässig (BRK.B), am Anfang nicht,
denn das ergäbe `.`, `..` und versteckte Dateien. Eine defekte Datei wird beiseitegelegt statt
stillschweigend ersetzt, und ein einzelner unlesbarer Eintrag kostet nur sich selbst, nicht die
ganze Datei.

## 8. Order-Engine

Der gemeinsame Boden unter beiden Arbeitsweisen: Im Replay klickt ein Mensch auf Kaufen, im
Backtest ruft eine Strategie `ctx.buy()`. Beides endet in derselben `Broker`-Klasse, damit ein
von Hand erzeugtes und ein von einem Bot erzeugtes Ergebnis direkt vergleichbar sind.

Reihenfolge pro Bar, und warum sie so ist:

1. **Fills** — Orders aus früheren Bars werden gegen diese Bar geprüft
2. **onBar** — die Strategie sieht die Bar als abgeschlossen und darf neue Orders geben

Eine Order kann damit nie auf der Bar ausgeführt werden, die sie erzeugt hat. Diese eine Regel
beseitigt den häufigsten Selbstbetrug im Backtesting: auf einen Schlusskurs zu reagieren und
zugleich zu diesem Schlusskurs zu handeln, was niemand kann.

### Die Intrabar-Frage

Eine 1h-Bar, die Stop und Ziel berührt, sagt nichts darüber, was zuerst kam. Übliche
Backtester raten — meist zugunsten des Stops, was ehrlich, aber pessimistisch ist, oder
zugunsten des Ziels, was jedes Ergebnis stillschweigend schönt.

Midori muss nicht raten. Es speichert ohnehin 1m-Bars, also wird ein Fill auf der 1h-Bar
aufgelöst, indem die sechzig Minuten der Stunde der Reihe nach durchlaufen werden. Erreicht
wird, was zuerst erreicht wurde.

Wo es keine feineren Daten gibt — eine Strategie auf der 1m-Basis selbst — ist die Reihenfolge
innerhalb der Minute tatsächlich unbekannt, und es gilt die pessimistische Regel: Der Fill, der
der Position schadet, geschieht zuerst. Jeder Fill trägt in `resolution`, welcher der beiden
Wege ihn entschieden hat; ein Ergebnis lässt sich also immer zurückverfolgen.

**Was das an echten Daten ausmacht:** BTCUSDT, 1h, drei Monate, enge symmetrische Klammern
(±0,4 ATR), 1.699 Trades. Die Minuten entschieden **103 Trades anders** — Trefferquote 48,1 %
statt 42,0 %, Ergebnisunterschied 1.451 auf 10.000 Startkapital. Wer die Auflösung nicht hat,
irrt bei sechs Prozent seiner Trades über den Ausgang, und zwar systematisch in eine Richtung.

Bei weiten Klammern verschwindet der Effekt — im Beispiel `sma-cross` (2 ATR Stop, 4 ATR Ziel)
traf keine einzige Stunde beide Seiten, und beide Läufe sind identisch. Das ist der Normalfall
und kein Widerspruch: Der Unterschied entsteht genau dort, wo es eng wird.

### Was sonst modelliert wird

- **Gaps**: Springt der Kurs über einen Stop hinweg, wird zur Eröffnung ausgeführt, nicht am
  Stop. Andernfalls würde das Risiko genau an den schlimmsten Tagen unterschätzt.
- **Kosten**: Halber Spread auf jeden Fill, Slippage zusätzlich nur dort, wo aggressiv
  ausgeführt wird (Market und ausgelöste Stops), Kommission auf das Nominal. Ein Round Trip
  bei unverändertem Kurs ist damit ein Verlust — wie in Wirklichkeit.
- **Klammern**: Stop und Ziel werden zusammen mit dem Einstieg platziert und heben einander
  auf, sobald eines ausgeführt wird. Eine Position bleibt nie mit einer verwaisten Order zurück.
- **Position**: Netting, kein Hedging. Aufstocken mittelt den Einstieg größengewichtet,
  Teilschließungen realisieren anteilig, eine übergroße Gegenorder dreht die Position.
- **Kennzahlen ohne Trades sind `null`, nicht 0.** Eine Trefferquote von 0 % würde „immer
  verloren" heißen; ein Profit-Faktor von `Infinity` wäre eine erfundene Zahl.

## 9. Bot-API (geplant, Abschnitt 11 M3)

Strategien sind JavaScript-Module, kein DSL:

```js
export const params = { fast: 20, slow: 50 };

export function onBar(bar, ctx) {
  if (ctx.crossOver(ctx.sma('fast'), ctx.sma('slow'))) {
    ctx.buy({ size: 1, stop: bar.low - ctx.atr(14) });
  }
}
```

Ausgeführt in einem Worker mit eingeschränktem Kontext. Ein mitgeliefertes `midori.d.ts`
gibt im eingebetteten Monaco-Editor Autovervollständigung — auch in einer
JavaScript-Codebasis, weil die Typen hier Nutzeroberfläche sind, nicht Bauwerkzeug.

Fremde Strategien brauchen echte Isolation (`isolated-vm` oder QuickJS-WASM), sobald das
Teilen von Strategien dazukommt.

## 10. Design-System

Übernimmt die „Living Data"-Sprache der Katsumii-App, verbindlich in `src/styles/tokens.css`
und `base.css`. Zwei begründete Abweichungen:

- **Akzent ist Midori-Grün** (`#059669` hell / `#34d399` dunkel). Weil der Akzent grün ist,
  bekommt Gewinn kein zweites Grün: `--pos` **ist** der Akzent. Verlust behält den einzigen
  roten Alarmton.
- **Kerzen sind blau/weiß, nie grün/rot.** Das hält Grün vollständig für Interaktion frei
  und bleibt für Rot-Grün-Sehschwäche lesbar. Aufwärts ist hell, abwärts blau; im hellen
  Modus wird „hell" zur hohlen Kerze mit Ink-Kontur, weil Weiß auf weißem Chart verschwindet.

Der Chart ist die eine Fläche, auf der die Gradient-Panels **nicht** gelten: Kursverlauf ist
die Figur, der Untergrund bleibt flach und ruhig. Chart-Farben stehen als eigene Tokens
(`--candle-*`, `--chart-*`) und werden in `ChartPanel.vue` per `getComputedStyle` gelesen,
damit ein Theme-Wechsel keine zweite Farbliste pflegen muss.

Klassen `k-panel`, `k-eyebrow`, `k-mono-label`, `k-chip`, `k-note`, `.btn`, `.primary-btn`,
`.icon-btn` — vor jeder neuen Klasse prüfen, ob eine davon passt. Nativer Fensterrahmen über
`titleBarOverlay`; dessen Farben in `electron/main.js` müssen mit `--bg`/`--txt` synchron
bleiben.

## 11. Meilensteine

- **M0 — Daten und Chart** ✅ Binance-Downloader mit Checksum, Binärstore, Aggregation,
  Chart mit Timeframe-Umschaltung und Nachladen beim Scrollen.
- **M0.5 — Indikatoren** ✅ Gemeinsames Indikator-Modul, Volume Profile mit POC, Value Area
  und Buy/Sell-Delta, Bedienpanel.
- **M0.6 — Zeichenwerkzeuge** ✅ Trendlinie, Strahl, horizontale/vertikale Linie, Rechteck,
  Fibonacci, Messwerkzeug, Long- und Short-Position mit Risiko/Chance-Zonen; Auswählen,
  Verschieben, Ankerpunkte ziehen, Speicherung pro Symbol.
- **M1 — Order-Engine** ✅ Market/Limit/Stop, Klammern mit gegenseitiger Aufhebung, Spread,
  Slippage, Kommission, Teilausführungen und Umkehr, Intrabar-Auflösung über die 1m-Basis,
  Backtest-Loop mit Kennzahlen. Vorgezogen, weil Replay sonst zweimal gebaut würde.
- **M2 — Replay.** Abspielkopf, Bar-für-Bar-Vorlauf, manuelle Orders per Maus, Positions- und
  Kontoanzeige — auf derselben Engine.
- **M3 — Bots.** Monaco-Editor, Worker-Ausführung, `midori.d.ts`, Kennzahlen (P&L, Drawdown,
  Sharpe, Trefferquote, Erwartungswert).
- **M4 — Analyse.** Equity-Kurve, Trade-Liste mit Sprung zum Entry, Parameter-Optimierung
  über einen Worker-Pool.
- **M5 — Weitere Quellen.** Dukascopy (Forex), CSV-Import (Futures), Alpaca (Aktien).
- **M6 — Auslieferung.** electron-builder, Code-Signing, Lizenzprüfung, Auto-Update.

## 12. Offene Punkte

- Sessionbewusste Aggregation für Futures und Aktien (Abschnitt 4).
- Bars werden als JSON-Objekte über IPC geschickt. Bei 3000 Bars pro Seite unkritisch,
  für Backtests über Millionen Bars muss die Engine direkt auf dem `Float64Array` im
  Main-Prozess laufen, statt Daten zu serialisieren.
- `lightweight-charts` verlangt laut Apache-2.0-NOTICE sichtbare Attribution. Die Option
  `attributionLogo` steht bewusst auf `true` — nicht abschalten.
- **Keine Content-Security-Policy gesetzt.** Im Dev-Modus unvermeidbar (Vite braucht
  `unsafe-eval`), in der ausgelieferten App aber nachzuholen: die Warnung verschwindet beim
  Packaging von selbst, das Risiko nicht. Spätestens mit M3 relevant, weil dann fremder
  Strategie-Code ins Spiel kommt.
- Lizenzmodell und Code-Signing-Zertifikat wie bei Acrobar früh klären.
- `THIRD-PARTY-NOTICES.txt` listet die tatsächlichen Abhängigkeiten, verweist aber auf die
  Lizenztexte statt sie vollständig zu enthalten. Vor der Auslieferung eines Installers
  sollten die Volltexte beiliegen und aus dem Dependency-Baum erzeugt werden.
