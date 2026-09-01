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

Jeder Parameter trägt zusätzlich ein `hint` — die Erklärung, die im Panel als Tooltip am Feld
hängt. Sie steht im selben Schema wie das Feld selbst, damit ein neuer Parameter nicht ohne
seine Erklärung ankommen kann; ein Test in `test/indicators.test.js` besteht darauf, dass
jeder Parameter einen hat und dass er mehr sagt als sein eigenes Label. Ein Regler, den
niemand deuten kann, ist in einem Werkzeug für Handelsentscheidungen kein kosmetisches
Problem.

Es gibt eine zweite Ausgabeform. Manche Indikatoren beschreiben keine Zahl je Bar, sondern
einen *Bereich* des Charts: ein Preisband, das an einer Bar beginnt und endet, wenn der Preis
zurückkommt. Die deklarieren `kind: 'zones'` und liefern

```
compute(bars, params) -> { zones: Array<{ top, bottom, startIndex, index, … }> }
```

Serien-Indikatoren lassen `kind` weg — das ist der Normalfall. Der Chart legt für Zonen keine
Serie an, sondern schiebt sie in ein Pane-Primitive.

Vorhanden: SMA, EMA, Bollinger Bands, RSI, ATR, VWAP (täglich/wöchentlich verankert),
Fair Value Gaps, Inverted Fair Value Gaps, Handelssessions, Stop Hunts, Silver Bullet und
Ranges.

True Range und die Wilder-Glättung liegen in `shared/indicators/atr.js`, nicht mehr in
`index.js`: ATR und Ranges brauchen dieselbe Volatilitätszahl, und eine zweite
Implementierung davon wäre genau die Abweichung, vor der der Kopf von `index.js` warnt.
`index.js` re-exportiert beide, damit bestehende Importe dort bleiben, wo sie waren.

Silver Bullet ist zusätzlich als **Strategie** registriert und damit backtestbar — siehe
Abschnitt 8b. Der Detektor bleibt derselbe; nur die Verwendung ist eine zweite.

### Bar-Zeiten sind Millisekunden

Der Chart hält Bars in **Sekunden**, weil die Series-API das so will. Jeder Indikator, der
einen Kalender liest — Sessions, ein verankerter VWAP —, braucht **Millisekunden**. Bekommt
er Sekunden, landet jede Bar im Januar 1970: Die Zahlen sehen weiter wie Zeitstempel aus, die
Ausgabe weiter wie ein Indikator, und die Sessions liegen alle am falschen Tag.

`ChartPanel` rechnet deshalb einmal pro Render eine Millisekunden-Kopie (`indicatorBars`) und
übergibt ausschließlich die. Das war zugleich ein stiller Fehler: Der VWAP-Anker
„täglich"/„wöchentlich" setzte im Chart **nie** zurück und war identisch mit „ganzer
Bereich" — der Tageswechsel wäre erst nach 86.400.000 Sekunden-Einheiten gekommen, also alle
2,7 Jahre. Beides ist mit derselben Zeile erledigt.

### Handelssessions

Eine Session ist ein Fenster in der **lokalen Zeit ihres Marktes**, und genau darin liegt die
Schwierigkeit. London läuft 08:00–17:00 London — im Winter 07:00–16:00 UTC, im Sommer eine
Stunde anders —, und Großbritannien, die USA und Australien stellen die Uhren an
verschiedenen Wochenenden um. Ein paar Wochen im Jahr liegt eine in festen UTC-Stunden
definierte Session schlicht falsch.

Sessions tragen deshalb eine **IANA-Zone** und werden über `Intl` gelesen, das jede dieser
Regeln kennt und weiter kennt, wenn sie sich ändern. Keine Offset-Tabelle in der Datei und
keine zu pflegen. Abgesichert in `test/sessions.test.js`: dieselbe London-Session liegt im
August auf 07:00 UTC und im Januar auf 08:00 UTC — eine Fixed-Offset-Lösung gäbe zweimal
dieselbe Stunde zurück.

Ein Fenster über Mitternacht (Asien) bleibt **ein** Block: Die Zuordnung erfolgt über den
lokalen Tag, an dem die Session *begonnen* hat, sonst zerfiele Tokio jede Nacht in zwei
Stücke mit einer Lücke dazwischen, die es nie gab.

Voreingestellt sind zwei Sätze — Futures (Asien/London/New York) und Forex (die klassischen
vier Zentren) — und eigene lassen sich im Panel anlegen: Name, Zone, Fenster, Farbe. Der
Parametertyp `sessions` ist eine Liste statt eines Skalars; validiert wird sie beim Eintragen
in `computeIndicator`, mit einer Meldung, die den fehlerhaften Eintrag benennt.

Die Suche beginnt am `days`-Fenster statt bei Bar 0. Eine Wanduhr abzulesen kostet einen
Intl-Zugriff pro Bar und Session; drei Jahre zu durchlaufen, um fünf Tage zu zeichnen, sind
81 ms gegen 8 ms für dasselbe Ergebnis.

### Fair Value Gaps

Eine FVG (auch „Imbalance") ist ein Preisbereich, durch den der Markt so schnell gelaufen ist,
dass dort keine beidseitige Auktion stattgefunden hat. Sie wird an drei aufeinanderfolgenden
Bars abgelesen:

```
bullish   low(i)  > high(i-2)    Lücke = [high(i-2), low(i)]
bearish   high(i) < low(i-2)     Lücke = [high(i),  low(i-2)]
```

**Zwei Indizes, mit Absicht.** Eine Zone hat eine *Form* und einen *Zeitpunkt, ab dem sie
bekannt ist* — und das sind nicht dieselben Bars. `startIndex` (= i-2) ist der Beginn der
Lücke und damit die Zeichenkoordinate; `index` (= i) ist die Bar, die sie bestätigt. Vor
Bar i konnte niemand wissen, dass die Lücke entsteht. Wer beide Felder zu einem
zusammenzieht und der Strategie dieselbe Zahl gibt, handelt ein Niveau zwei Bars bevor es
gebildet wurde — genau die Sorte Look-Ahead aus Abschnitt 4, nur eine Ebene höher.

**Mitigation** ist Parameter, keine eingebaute Regel: Trader sind sich echt uneinig, wie weit
der Preis zurückkommen muss. `touch` (nahe Kante), `ce` (Mittellinie, *consequent
encroachment*), `full` (ganz durchlaufen), `break` (jenseits **schließen**). Geprüft wird ausschließlich auf Bars **nach** der
bestätigenden Bar — die Bar, die eine Lücke erzeugt, kann sie nicht füllen, wie weit ihr
Docht auch reicht. Unter `touch` wäre genau das sonst der Normalfall, denn die nahe Kante
*ist* ihr eigenes Low.

`minSize` misst wahlweise in **Prozent oder in Punkten** (`minSizeUnit`). Prozent misst gegen
das Preisniveau, auf dem die Zone liegt, und bedeutet damit dasselbe, während der Preis läuft;
Punkte messen den rohen Abstand in der Notierung des Instruments — das, was man vom eigenen
Chart abliest und worin ein fester Stop bemessen ist. Keine der beiden Einheiten passt auf
jeden Markt, deshalb beide.

**Was angezeigt wird**, ist von **wie breit** getrennt. `minSize` und `lookback` (nur Lücken
aus den letzten N Bars) verengen, *welche* Zonen überhaupt gemeldet werden — beides ist auch
für eine Strategie sinnvoll und steht deshalb in `fvg.js`. `boxWidth` nicht: wie weit der
Chart ein Rechteck nach rechts malt, sagt nichts über den Markt. Der Parameter wird über das
gemeinsame Schema validiert und dann nur vom Renderer gelesen — dasselbe Muster wie die
Breite des Volume Profile. Bei beiden Zahlen heißt 0 „kein Limit", nicht „nichts".

Die Box endet, was zuerst kommt: die Füllung oder das Breitenlimit. Ohne beides läuft sie bis
zum rechten Rand — eine offene Lücke am letzten Bar abzuschneiden läse sich als „hier war
Schluss". Das Breitenlimit zählt ab der linken Kante der Box, `4` ergibt also eine vier Bars
breite Box. Der Lookback zählt vom neuesten Bar rückwärts, nicht ab einem Datum, damit das
Fenster dasselbe bedeutet, nachdem ältere Bars dahinter nachgeladen wurden.

Gezeichnet wird als Pane-Primitive auf `zOrder: bottom`, wie das Volume Profile: eine Zone
ist Kontext, nie etwas, das über den Kerzen liegt. Waagerecht wird über logische Indizes
positioniert statt über Zeitstempel — die Zonen stammen aus genau dem Bar-Array, das der
Chart zeigt, also *sind* ihre Indizes die Koordinaten. Das übersteht auch das Nachladen
älterer Bars, bei dem sich alle Indizes um denselben Betrag verschieben.

Aber nur **ganze** Indizes. `logicalToCoordinate()` prüft intern `!isInteger(index)` und gibt
dann **0** zurück — keinen `null`, sondern eine gültige Koordinate. Wer nach `index - 0.5`
fragt, klebt jede Box lautlos an den linken Chartrand, und nichts wirft einen Fehler. Halbe
Bars werden deshalb in Pixeln gerechnet, nachdem der ganze Index umgerechnet wurde; die
Pixelbreite einer Bar kommt aus der Differenz zweier ganzer Indizes, nicht aus der
`barSpacing`-Option, die einem Zoom nicht folgt. Die gesamte Arithmetik steht in
`boxExtent()` und ist in `test/fvgPrimitive.test.js` abgedeckt — ohne Chart prüfbar, weil
genau dieser Fehler auf dem Bildschirm wie eine Designentscheidung aussieht.

Farblich gilt dasselbe Richtungsvokabular wie bei Kerzen und Buy/Sell-Split: hell ist oben,
blau ist unten. Kein zweites Grün (Akzent) und kein Rot — siehe Abschnitt 10.

Die Mittellinie wird nur gezeichnet, wenn CE auch die geltende Mitigationsregel ist. Sonst
stünde eine Linie im Chart, die unter den anderen beiden Einstellungen nichts bedeutet.

### Inverted Fair Value Gaps

Eine IFVG ist das, was übrig bleibt, wenn der Markt eine Lücke *nicht* respektiert. Eine
bullische FVG, unter die der Preis schließt, hat als Unterstützung versagt; dieselben Preise
werden danach als Widerstand gelesen, und die Zone dreht ihre Richtung um.

Beide Detektoren teilen sich deshalb **eine** Definition einer Lücke (`findGaps`). Eine zweite,
die auseinanderdriftet, hätte Chart und Engine für denselben Markt auf unterschiedliche
Niveaus gesetzt — genau der Fehler, gegen den `shared/indicators/` überhaupt existiert. Ein
Test hält das fest: jede Inversion muss auf eine Lücke zurückführbar sein, die auch der
FVG-Detektor gefunden hat, mit identischen Preisen und umgekehrter Richtung.

**Was zählt als Bruch.** Voreinstellung ist ein *Close* jenseits der Lücke, nicht ein Docht:
ein Docht hindurch ist ein gescheiterter Vorstoß, ein Körper hindurch ist Akzeptanz — zwei
verschiedene Ereignisse. `wick` gibt es für alle, die den Vorstoß handeln. Auf einem Monat
BTC-15m liefert `wick` weniger *offene* Inversionen als `close`, nicht mehr: die Zonen
entstehen früher und werden entsprechend früher wieder mitigiert.

Die IFVG behält die Trennung von `startIndex` und `index` und braucht sie stärker als die
FVG: Gezeichnet wird ab der **ursprünglichen Lücke** — dort liegt das Niveau, und dort sucht
es auch, wer es sucht — bestätigt aber erst auf der brechenden Bar. Auf einem Monat BTC-15m
liegen dazwischen im Median 14 Bars, im Extremfall 890. Das Bild reicht zurück; was eine
Strategie handeln darf, nicht.

Die Box-Breite zählt für beide Indikatoren **ab der linken Kante** — den Bars, die die Lücke
gebildet haben. `3` ergibt eine drei Bars breite Box, egal welcher Indikator sie anfordert.
Bei einer IFVG kann sie damit lange vor der brechenden Bar enden, und das ist so gewollt: Die
Box markiert das Preisniveau, und das Niveau liegt dort, wo die Lücke war. Festgehalten in
`test/fvgPrimitive.test.js`.

**Eine Inversion stirbt nicht am Rücktest.** Die ersten drei Mitigationsregeln beenden eine
Zone, sobald der Preis in sie zurückkehrt. Für eine Lücke ist das genau richtig — die
Ineffizienz ist ausgehandelt. Für eine Inversion ist es verkehrt herum: Die Zone *ist* ein
Niveau, zu dem der Preis zurückkommen und an dem er reagieren soll. Der Rücktest ist der
Grund, sie zu zeichnen, nicht ihr Ende.

Gemessen auf einem Monat BTC-15m: Die Lücken-Regel auf Inversionen angewandt warf **690 von
718** weg, 212 davon auf der unmittelbar folgenden Bar, die Hälfte binnen drei Bars. Deshalb
ist `break` die Voreinstellung für die IFVG — die Zone endet erst, wenn eine Bar jenseits von
ihr *schließt* — und `full` bleibt die Voreinstellung für die einfache Lücke. `break` ist
dabei derselbe Test, der eine Lücke überhaupt erst invertiert, nur gegen die neue Richtung
gelesen; `reaches()` delegiert dafür an `breaksThrough()`.

Dasselbe Argument entscheidet die zweite abweichende Voreinstellung. Eine **gefüllte Lücke
ist weg** — die Ineffizienz existiert auf keinem Preis mehr, sie auszublenden ist richtig.
Eine **gebrochene Inversion ist nicht weg, sondern vorbei**: Sie galt von einer Bar bis zu
einer anderen, und ihre Box endet dort ohnehin. Sie zusätzlich wegzufiltern löscht sie aus
genau dem Stück Chart, auf dem sie galt. Deshalb steht `show` bei der IFVG auf „alles" und
bei der FVG auf „nur offene".

Gemeldet wurde das zweimal aus dem Chart, beide Male überprüfbar: eine Lücke vom 27.08. 18:00
invertierte in der Nacht um 00:45 und wurde um 02:00 erneut gebrochen — mit der alten
Voreinstellung wurde dafür nie etwas gezeichnet. Im Bildausschnitt eines Vier-Stunden-
Fensters lagen 14 Inversionen, gezeichnet wurden 5.

Weil beendete Zonen nur bis zu ihrem Ende laufen, füllen sie den Chart trotzdem nicht zu —
im Gegensatz zu offenen, die bis zum rechten Rand reichen. Gezeichnet werden sie mit halber
Deckkraft und gestrichelter Kante statt wie zuvor als reiner Umriss: Bei einer Inversion ist
„beendet" der Normalfall (677 von 718), und ein Chart aus Haarlinien ist unlesbar.

Die Voreinstellung steht an zwei Stellen — im Destructuring der Detektorfunktion und im
Param-Schema. Ein Test vergleicht beide gegeneinander, statt darauf zu vertrauen, dass sie
im Gleichschritt bleiben: Liefe eine Strategie mit `full` und der Chart mit `break`, wäre das
wieder genau die Divergenz, gegen die `shared/indicators/` existiert.

`originIndex` führt mit, aus welcher Lücke die Zone stammt, damit eine Strategie eine frische
Inversion von einer unterscheiden kann, die zweihundert Bars gebraucht hat.

### Stop Hunts

Ein Stop Hunt ist der Lauf durch ein Niveau, an dem Stops liegen, und die Rückkehr auf die
Ausgangsseite. Drei Dinge, in dieser Reihenfolge: ein **Niveau**, ein **Durchstoß**, ein
**Reclaim**. Alle drei sind nötig — ein Durchstoß ohne Reclaim ist kein Hunt, sondern ein
Bruch. Dieselben zwei Bars gehören zu beidem; erst was danach passiert, entscheidet welches.

**Drei Quellen für Liquidität**, einzeln zuschaltbar (`sources`):

- `swing` — Fraktale: `strength` Bars links und rechts sind niedriger. Der universelle Fall.
- `equal` — zwei oder mehr Swings auf demselben Preis innerhalb einer Toleranz. Das ist der
  eigentliche Stop-Cluster. Das Niveau ist das **Extrem** der Gruppe, nicht ihr Mittel: Die
  Stops liegen jenseits des äußersten, ein Lauf bis zum Mittelwert hätte nichts gefüllt.
- `session` — Hoch und Tief **abgeschlossener** Sessions, gelesen über `computeSessions`.
  Die laufende Session liefert kein Niveau; ihre Extrema bewegen sich noch.

**Look-Ahead ist hier die eigentliche Falle.** Ein Fraktal-Hoch auf Bar i ist erst dann ein
Fraktal, wenn `strength` Bars rechts davon geschlossen haben — auf Bar i konnte es niemand
wissen. Jedes Niveau trägt deshalb `formedIndex` (wo es liegt, zum Zeichnen) und
`knownIndex` (ab wann es handelbar ist), dieselbe Trennung wie `startIndex`/`index` bei den
Lücken. Ein Sweep trägt drei Indizes, weil er einen Moment mehr hat als eine Zone:
`levelIndex`, `sweepIndex` und `index` — letzterer ist die Bar, die den Reclaim bestätigt,
und der einzige, den eine Strategie lesen darf.

**Das Bestätigungsfenster.** `confirmBars` zählt ab der durchstoßenden Bar einschließlich.
`1` ist die strenge Lesart: Docht hindurch, Körper zurück, eine Kerze. Höhere Werte fangen
langsamere Hunts und bestätigen entsprechend später — `sweepIndex` und `index` fallen dann
wirklich auseinander. Läuft das Fenster ohne Reclaim ab, gilt das Niveau als echt gebrochen
und fällt weg. Ein Niveau kann deshalb nur **einmal** gejagt werden: Die Stops dahinter sind
beim ersten Mal gefüllt worden.

**Ein Hunt hat eine kurze Lebensdauer.** `holdBars` sagt, wie lange nach dem Reclaim der
Preis das Niveau noch respektieren muss. Ohne Fenster gewinnt die falsche Lesart und
verschlingt fast alles: Auf einem Monat BTC-15m überleben von 286 Hunts unbegrenzt gerade
**12**, bei zehn Bars **117**. Der Abstand ist kein Markteffekt, sondern die Definition, die
den Indikator auffrisst — derselbe Fehler wie bei der IFVG, wo die Lückenregel 690 von 718
Inversionen wegwarf. Von den Hunts, die scheitern, scheitert der Median nach sechs Bars und
ein Viertel schon in der ersten; ein Fenster von zehn fängt die Zurückweisungen, die mit
diesem Niveau zu tun hatten, und wenige, die es nicht hatten.

**Die Richtung ist nach dem Trade benannt, nicht nach dem Docht.** Ein Hunt durch ein *Hoch*
nimmt Buy-Side-Liquidität und dreht nach unten, ist also `bear` — genau umgekehrt zu dem, was
der Docht getan hat, und das ist der Punkt des Musters.

Gezeichnet wird ein Hunt als **drei Marken**, weil er drei Momente hat: die gestrichelte
Linie vom Entstehen des Niveaus bis zum Lauf (ihre Länge ist, wie lange die Liquidität
sichtbar dort lag), die gefüllte Raid-Box von Niveau bis Docht-Extrem über der
durchstoßenden Bar, und das blasse Fenster bis zur bestätigenden Bar. Ist das Fenster leer,
hat dieselbe Bar zurückgeschlossen — und genau das soll man sehen.

### Silver Bullet

Silver Bullet ist **zuerst eine Uhrzeit**, dann ein Muster. Drei Ein-Stunden-Fenster, alle in
New Yorker Ortszeit — 03:00 (London Open), 10:00 (NY AM), 14:00 (NY PM) —, gelesen über
`localReading` aus `sessions.js`, damit sie der US-Zeitumstellung folgen statt zweimal im Jahr
eine Stunde danebenzuliegen. Bar-Zeiten müssen deshalb Millisekunden sein.

**Die Kette.** Vier Glieder, in dieser Reihenfolge, alle vier erforderlich:

1. **Sweep** — Liquidität wird geholt: ein Hoch oder Tief wird gelaufen und zurückgegeben.
2. **FVG** — die Umkehr ist impulsiv genug, um eine Lücke in Gegenrichtung zu reißen.
3. **MSS** — der Preis schließt jenseits des **Bodys der letzten gegenläufigen Kerze** vor
   dieser Lücke. Beim Short: die letzte bullische Kerze, unterschritten. Das Niveau ist deren
   `open` — in beiden Richtungen die Body-Kante, die dem Impuls entgegensteht.
4. **Entry** — der Preis kommt zurück und berührt die nahe Kante der Lücke.

Nichts davon wird hier neu erfunden: Der Sweep kommt aus `stophunt.js`, die Lücke aus
`fvg.js`. Es sind dieselben Detektoren, die der Chart zeichnet — ein Setup kann also nicht auf
einem Niveau sitzen, über das der Chart anderer Meinung ist. Genau dafür gibt es `shared/`.

**Was der MSS wirklich tut.** Gemessen auf einem Monat BTC-5m: Von 1267 bärischen Lücken
erfüllen **91 %** den MSS schon auf der eigenen Bestätigungsbar, 97 % binnen zehn Bars. Das ist
strukturell — ein Impuls, der steil genug für eine Lücke ist, hat die letzte Gegenkerze fast
zwangsläufig unterschritten. Der MSS **bestätigt** also, er selektiert nicht. Wer mehr Setups
sucht, muss an Fenster, Sweep oder `minGapSize` drehen, nicht am MSS.

**Kandidatenwahl.** Auf einen Sweep können mehrere Lücken folgen, und die erste ist nicht
zwangsläufig die brauchbare — der Preis kommt vielleicht nie zu ihr zurück. „Das erste Setup,
das alle Regeln erfüllt" heißt deshalb: die Kandidaten der Reihe nach durchgehen und die erste
Kette nehmen, die **vollständig** schließt, statt bei der ersten Lücke aufzugeben. Pro
Fenster-Vorkommen (Datum + Fenster) bleibt genau ein Setup stehen.

**`scope` skaliert nicht auf hohe Timeframes.** `entry` verlangt nur den Einstieg im Fenster,
`all` die ganze Kette. Eine Silver-Bullet-Stunde ist auf 5m zwölf Bars lang, auf 15m vier und
auf 1h eine einzige — `all` ist oberhalb von 5m praktisch unerfüllbar und liefert dort fast
keine Setups. Das ist kein Fehler, sondern die Konsequenz aus Fensterlänge und Bargröße.

**Ergebnisse sind pessimistisch.** Jedes Setup wird vorwärts abgelaufen, bis Ziel oder Stop
zuerst erreicht ist; berührt eine Bar beides, gewinnt der Stop. Die Engine kann das besser —
sie löst über Minutenbars auf (siehe Abschnitt 4) —, dieser Indikator hat nur die angezeigten
Bars. `outcome` ist also eine gegen das Setup verzerrte Schätzung, keine Abrechnung.

### Ranges

Alles andere in diesem Ordner findet eine **Bewegung** — eine Lücke, einen Sweep, einen
Impuls. Ranges finden das Gegenteil: die Strecken, auf denen der Markt schlicht stehen
bleibt, und das ist der größere Teil des Tages.

**Warum eine Prozentschwelle nicht funktioniert.** Die naheliegende Definition — „Hoch minus
Tief unter x %" — ist die, an der ein Range-Indikator scheitert, und zwar spektakulär.
Gemessen auf drei Monaten BTC markiert eine Spanne von 0,3 % über 20 Bars **77 % des
1m-Charts** und auf 1h **gar nichts**. Bei 1 % sind es 99 % gegen 11 %. Es gibt keinen Wert
dazwischen, der auf beiden funktioniert: Die Zahl misst den Timeframe, nicht den Markt.

**Die Normierung.** Nicht den Preis messen, sondern den Preis gegen das, was dieser Markt in
derselben Anzahl Bars normalerweise zurücklegt. Über N Bars kommt ein Random Walk etwa
`ATR × √N` weit — das √N ist kein Fudge-Faktor, sondern die Skalierung der Diffusion, und der
Grund, warum 100 Bars nicht das Zehnfache von 10 Bars abdecken. Also:

```
compression = height / (ATR × √length)
```

Die Verteilung dieses Verhältnisses ist über alle Timeframes praktisch dieselbe Zahl —
Median 1,21 auf 1m, 1,05 auf 5m, 0,97 auf 15m, 0,97 auf 1h, 0,98 auf 4h, mit ebenso eng
laufendem unterem Rand. **Eine** Schwelle bedeutet damit überall dasselbe. Voreingestellt
sind 0,6; das markiert 14 % des 1m-Charts, 28 % auf 5m, 40 % auf 15m, 30 % auf 1h, 34 % auf
4h.

**Damit ist die eigentliche Frage beantwortet:** Eine Stunden-Range darf im 1m-Chart nicht
auftauchen. Sie tut es nicht. Von den 24 Ranges, die auf 1h in diesem Zeitraum gefunden
werden, hat **keine einzige** ein Gegenstück auf 1m — 1200 Minutenbars einer Stunden-Balance
decken ungefähr das ab, was 1200 Minutenbars üblicherweise abdecken. Umgekehrt genauso: keine
der 674 1m-Ranges erscheint als dieselbe Range auf 1h. `maxBars` sichert dieselbe Regel noch
einmal stumpf ab.

Die Volatilität wird an den Bars **vor** der Range gemessen, nie in ihr. Innen wäre
zirkulär — eine Range drückt ihr eigenes ATR, und jede würde bestehen.

**Vier Bedingungen, jede gegen einen anderen Hochstapler:** Mindestlänge (drei ruhige Kerzen
sind keine Range), Kompression (siehe oben), Berührungen (beide Kanten je `minTouches` mal
getrennt besucht — ohne das qualifiziert sich jede schmale Diagonale) und ein Ende (ein Close
jenseits einer Kante; 95 % auf 1m und 92 % auf 15m enden so, der Rest weitet sich aus oder
läuft an den Rand der Daten).

`minTouches` von 1 ist **kein** Filter: Die Kanten sind die Extrema genau dieser Bars, eine
Berührung je Seite gibt es also per Konstruktion. 2 ist die erste Einstellung, die etwas
verlangt (sie entfernt 28 % der Kandidaten), 3 entfernt 77 %.

**Kein Drift-Filter.** Das Erste, wonach man greift, um die langsame Diagonale
auszuschließen — und es ist überflüssig: Die gefundenen Ranges haben eine Kaufman Efficiency
Ratio von 0,09–0,16 im Median gegen 0,18 für beliebige Fenster gleicher Länge. Länge,
Kompression und Berührungen haben bereits entfernt, was er entfernen würde.

**Ablauf.** Saat, erweitern, brechen. Jede Position wird als Start eines `minBars`-Fensters
geprüft; die früheste, die eng genug ist, gewinnt, damit die linke Kante die des Marktes ist
und nicht die des Scans. Beim Erweitern **verbreitert** eine Bar, die nur über eine Kante
docht, die Range — das ist ein Raid auf die Kante, den sie überlebt —, während eine Bar, die
darüber **schließt**, sie beendet. Die Kompressionsprüfung läuft bei jeder neuen Länge erneut,
sonst bläht sich eine Range langsam zu einem Trend auf. Ranges überlappen nie.

**Die Kanten tragen dieselbe Look-Ahead-Disziplin wie die Indizes.** `top` und `bottom` sind
Endwerte, und die hat eine Range erst, wenn sie vorbei ist; sie auf der Bestätigungsbar zu
zitieren gäbe einer Strategie eine Kante, die der Markt noch nicht gedruckt hatte. Die Kanten
zum Bestätigungszeitpunkt laufen deshalb getrennt mit, als `confirmTop` und `confirmBottom`,
und nur die darf etwas lesen, das in Echtzeit handelt. In der Praxis sind sie fast die
endgültigen — die Höhe wächst danach im Median um 0 % und im 90. Perzentil um 7 % (1m) bis
16 % (1h) —, aber „fast immer gleich" ist kein Vertrag.

Gezeichnet werden vier Marken: die Box über die Bars, die wirklich dazugehören (eine Range
läuft **nicht** bis zum rechten Rand wie eine offene Lücke — ihre Breite ist der lesbare
Teil), das Equilibrium gestrichelt in der Mitte, bei einer noch laufenden Range beide Kanten
gestrichelt bis zum Rand, und der Ausbruch als Kasten von der gefallenen Kante bis zum Close
der Ausbruchsbar — das Spiegelbild der Raid-Box aus `huntPrimitive.js`. Die Box behält eine
Farbe, egal wie es ausging: sie nach dem späteren Ausbruch einzufärben wäre die visuelle Form
genau des Look-Aheads, den der Detektor vermeidet.

Kosten: 0,5 ms für die 3000 Bars, die der Chart hält.

### Zonenfarben

Die Zonen-Indikatoren, die Stop Hunts und die Silver-Bullet-Setups tragen je zwei
Farbparameter (bullisch / bärisch); Ranges tragen drei — eine neutrale für die Box und je eine
für den Ausbruch nach oben und nach unten. Gespeichert werden
**Token-Namen, kein Hex**: dieselbe Wahl muss in Hell und Dunkel funktionieren, und das tut
nur ein Token. Der Renderer setzt die Deckkraft ausschließlich über `globalAlpha` und backt
sie nie zusätzlich in die Farbe — beides zusammen multipliziert sich, und eine Zone, die mit
0,13 angefordert wurde, kommt mit 0,017 heraus. Dieselbe Falle ist in
`drawings/drawingPrimitive.js` ausführlich dokumentiert.

Die FVG steht voreingestellt auf den Kerzentönen (hell oben, blau unten — das Richtungs-
vokabular aus Abschnitt 10), die IFVG auf Indikatorfarben. Beide sind meist gleichzeitig auf
dem Chart und müssen auf einen Blick unterscheidbar sein; keine der Voreinstellungen ist blau
(Kerzen) oder grün (Akzent). Ein Test prüft, dass jede Palettenfarbe als Token in
`tokens.css` existiert — ein Name ohne Token löst zu einem leeren String auf und malt
nichts, was auf dem Bildschirm wie ein Renderfehler aussieht.

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

### Strichstil

Jede Zeichnung trägt Farbe, Strichstärke (1–4 px) und Strichmuster (durchgezogen, gestrichelt,
gepunktet). Bearbeitet wird das in der `LineStyleBar`, die über dem Chart schwebt, sobald eine
Zeichnung ausgewählt ist — aus demselben Grund wie die `PositionStyleBar`: Eine Strichstärke
beurteilt man neben der Linie, die sie ändert, nicht quer durchs Fenster. Beide Leisten teilen
sich die Ecke und erscheinen nie gleichzeitig, denn eine Zeichnung ist entweder ein
Positionsblock oder keiner.

Die Auswahl merkt sich die Einstellung für die nächste Zeichnung (`setLineStyle`, wie
`setPositionStyle`). Ohne diese zweite Hälfte fiele jede neue Zeichnung auf 1 px durchgezogen
zurück, und die Einstellung wirkte kaputt.

**Das Muster gilt nur für die einfachen Linienformen.** Fib, Messwerkzeug, Range-Profil und
Positionsblock setzen ihre Striche selbst: Deren Strichelung ist Bedeutung — welches Level,
welche Kante — und darf nicht von einer Dekoration überschrieben werden.

**Auswahl addiert ein Pixel statt zu verdoppeln.** Bei der früheren festen Breite von 1 war
Verdoppeln unauffällig; sobald die Breite dem Nutzer gehört, würde eine ausgewählte 4-px-Linie
auf 8 springen. Bei Breite 1 liefern beide Regeln dieselben 2 px, also sieht nichts, was vorher
existierte, anders aus.

**Gespeicherte Werte werden beim Laden normalisiert.** `normalizeWidth` rundet auf eine
angebotene Breite und fällt sonst auf 1 zurück — eine Breite von 0 zeichnet nichts, eine
negative wirft in manchen Engines. Ein unbekanntes Muster zeichnet durchgezogen statt gar
nicht. Eine Datei aus der Zeit vor diesen Feldern lädt unverändert weiter.

### Einrasten mit Shift

Wird beim Ziehen Shift gehalten, rastet die Geste auf eine Achse ein: horizontal hält den Preis
des Ankers fest, vertikal dessen Zeit. Das gilt beim Neuzeichnen, beim Ziehen eines Ankers
(gegen das andere Ende der Linie) und beim Verschieben einer ganzen Zeichnung (gegen den
Startpunkt der Bewegung).

**Die Achse wird in Pixeln entschieden, niemals in Marktkoordinaten.** Eine Preisdifferenz und
eine Zeitdifferenz sind nicht vergleichbar — zwischen 20 Dollar und 20 Minuten gibt es kein
Verhältnis. Wer die beiden Zahlen direkt vergleicht, lässt die größere gewinnen, und dann
kippt die Achse beim Zoomen der Preisskala, ohne dass sich der Zeiger bewegt hat. Auf dem
Schirm sind beide Deltas Pixel, und die Antwort ist die, die der Nutzer meint: die Richtung,
in die er weiter gezogen hat. Deshalb wird der Anker für den Vergleich zurück auf den Schirm
projiziert. Festgehalten in `test/drawings.test.js`.

Der Zustand wird pro Event gelesen statt mitgeführt, also wirkt Loslassen mitten im Ziehen erst
bei der nächsten Mausbewegung. Positionsblöcke rasten nicht ein: Ihre drei Anker kodieren
bereits eine Richtung, und eine waagerechte Sperre würde das Risiko auf null setzen.

### Positionswerkzeug

Die Position ist die einzige Zeichnung mit drei Preisen statt zwei Punkten: Entry, Stop und
Ziel. Gezogen wird nur vom Entry zum Stop — das Ziel setzt sich zunächst auf das Doppelte des
Risikos auf der Gegenseite, weil so ein Trade tatsächlich bemessen wird. Danach ist jeder der
drei Anker frei verschiebbar.

**Ein Werkzeug für beide Richtungen.** Long und Short waren anfangs getrennt, taten aber
exakt dasselbe: Die Erzeugung unterschied sich in nichts außer dem Etikett, und wer den Stop
über den Entry zog, hatte faktisch einen Short, dessen Beschriftung weiter „LONG" behauptete.
Die Richtung wird deshalb **nicht gespeichert**, sondern aus der Geometrie gelesen — Ziel über
dem Entry heißt Long, darunter Short (`positionDirection`). Nach unten ziehen ergibt einen
Long, nach oben einen Short, ohne dass dem Werkzeug gesagt werden müsste, was gemeint war. So
kann die Beschriftung dem Bild nicht widersprechen.

Liegt das Ziel exakt auf dem Entry, entscheidet die Seite des Stops; fallen alle drei Preise
zusammen, gibt es keine Richtung und der Block heißt schlicht „POSITION".

Zeichnungen, die noch unter `long` oder `short` gespeichert wurden, werden beim Laden auf
`position` abgebildet (`LEGACY_POSITION_TYPES`). Ihre Richtung ergibt sich aus den Ankern, die
sie ohnehin schon haben, also bleibt ein alter Short ein Short. Erzeugen lassen sich die alten
Typen nicht mehr.

Gespeichert werden drei Anker, und Stop und Ziel teilen sich die rechte Kante. Wird einer von
beiden gezogen, muss der andere in der Zeit mitgehen, sonst reißt der Block auseinander;
`moveAnchor` behandelt das typspezifisch. Der Entry besitzt die linke Kante allein.

**Rot und Grün gelten hier — und nur hier.** Der Chart hält Kerzen bewusst in Blau/Weiß
(Abschnitt 10), damit Grün dem Akzent gehört. Ein Positionsblock ist aber keine Kerze, sondern
eine Fläche mit eindeutiger Bedeutung: Die Stop-Seite trägt die Verlustfarbe, die Ziel-Seite die
Gewinnfarbe. Die Farbe folgt der Bedeutung, nicht der Richtung — ein Short liest sich damit
genauso herum wie ein Long, und Risiko und Chance sind absolute Abstände.

Beide Farben und die Deckkraft der Flächen liegen **pro Zeichnung** im Datensatz, damit sich
mehrere geplante Trades auf einem Chart auseinanderhalten lassen. Die Leiste dazu schwebt über
dem Chart statt in einem Seitenpanel zu sitzen: Eine Farbwahl beurteilt man neben der Fläche,
die sie ändert, nicht quer über das Fenster hinweg. Die zuletzt gewählte Einstellung gilt auch
für den nächsten neuen Block — sonst spränge jeder neue Block auf die Vorgabe zurück und die
Einstellung fühlte sich kaputt an.

Deckkraft wird an genau einer Stelle angewandt (`globalAlpha`) und nie zusätzlich in die Farbe
gerechnet. Beides zusammen multipliziert sich: Eine mit 0,13 angeforderte Fläche kam bei 0,017
heraus, ein Fib-Band bei 0,005 — praktisch unsichtbar.

Beschriftet wird ausschließlich **innerhalb** des Blocks, jeweils auf der zum Entry zeigenden
Seite: Ziel und Stop mit Preis und Prozentabstand, der Entry auf der Chancen-Seite, und
Richtung samt Chance-Risiko-Verhältnis direkt an der Entry-Linie in der Risiko-Zone. So hängt
nichts über den Rand hinaus und nichts verdeckt etwas anderes — eine frühere Zusammenfassung
über dem Block tat genau das und verbarg den Prozentwert des Ziels.

Sitzt der Stop auf dem Entry, ist das Verhältnis `null` statt unendlich — es gibt dann kein
Risiko, durch das sich teilen ließe.

### Range Volume Profile

Ein Werkzeug, kein Indikator: Man zieht eine Spanne auf, und darüber liegt ein Volume Profile
genau dieses Zeitraums. Gerechnet wird es wie das Panel-Profil im Main-Prozess aus 1m-Bars —
dieselbe Funktion, dieselben Bins, nur ein anderes Fenster.

**Senkrecht zählt die Spanne nicht.** Die zwei Anker legen die Zeit fest; die Box wird auf die
Preisspanne gezeichnet, die die Bars darin tatsächlich abgedeckt haben. Die Höhe des Ziehens
zu respektieren würde jeden Trade darüber und darunter stillschweigend verwerfen — und ein
Profil, dem Volumen fehlt, setzt seinen POC an die falsche Stelle, also genau den einen Wert,
für den das Werkzeug existiert.

Gezeichnet wird in zwei Schichten: Die Spanne selbst gehört zu den Zeichnungen und liegt
**über** den Kerzen (der Nutzer hat sie dorthin gesetzt), das Histogramm liegt als eigenes
Primitive **darunter** (eine Verteilung ist Kontext). Ergebnisse werden pro Fenster
zwischengespeichert; der Schlüssel enthält Spanne *und* Bin-Einstellungen, und beim Ziehen
werden Schlüssel, die niemand mehr braucht, sofort verworfen — sonst wüchse die Map, solange
die Maustaste gedrückt ist.

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
- **Klammern an ruhenden Orders** werden erst beim Fill platziert (`_attachBracket`). Bei einem
  Markteinstieg geht das vorab, weil er auf der nächsten Bar füllt; bei einer Limit- oder
  Stop-Order nicht: Zwei lebende Orders gegen eine Position, die es noch nicht gibt, würden
  entweder in die falsche Richtung eröffnen oder sich — da `reduceOnly` — beim ersten Berühren
  selbst löschen und den Einstieg später ungeschützt füllen lassen. Die Level reisen deshalb auf
  der Order mit und werden in dem Moment zu Orders, in dem es die Position wird — genau das, was
  eine Börse mit einer angehängten OCO tut. Da `_fillAgainst` die Orderliste vor dem Durchlauf
  einfriert, sind sie ab dem **nächsten** Schritt scharf: mit Minutendaten die nächste Minute
  derselben Bar, sonst die nächste Bar.
- **Abstände statt Level.** Ein Klammerschenkel ist entweder ein absoluter Preis oder ein
  *Abstand zum Fill* — nie beides, das wird abgelehnt. Der Abstand wird am tatsächlich gezahlten
  Preis gemessen, Spread und Slippage inbegriffen, damit ein Plan mit „Risiko 500" auch dann 500
  kostet, wenn der Markt auf dem Weg hinein gesprungen ist.
- **Position**: Netting, kein Hedging. Aufstocken mittelt den Einstieg größengewichtet,
  Teilschließungen realisieren anteilig, eine übergroße Gegenorder dreht die Position.
- **Kennzahlen ohne Trades sind `null`, nicht 0.** Eine Trefferquote von 0 % würde „immer
  verloren" heißen; ein Profit-Faktor von `Infinity` wäre eine erfundene Zahl.

## 8b. Strategien und Backtests

### Wo die Grenze zum Indikator liegt

Nicht bei der Komplexität. Ein **Indikator beschreibt** den Markt, eine **Strategie legt sich
fest**. In dem Moment, in dem etwas sagt „hier kaufen, so viel riskieren, dort raus", ist es
keine Zeichnung mehr, sondern etwas, das über Geld recht oder unrecht haben kann — und genau
das gehört nach `shared/strategies/`, weil genau das backtestbar ist.

Eine Strategie darf einen Indikator **benutzen**, und Silver Bullet tut das: Der Detektor
bleibt in `shared/indicators/`, zeichnet weiter im Chart, und die Strategie meldet ihn als
Ereignisquelle an. Eine Definition, zwei Verwendungen. Würde die Strategie die Erkennung
nachbauen, wären Chart und Backtest irgendwann verschiedener Meinung über denselben Markt —
der Fehler, gegen den `shared/` überhaupt existiert.

### Serien und Ereignisse

Die Engine kannte bisher nur Serien: ein Wert je Bar, deklariert unter `indicators`, gelesen
über `ctx.ind(name, back)`. Ein Setup ist aber kein Wert je Bar, sondern ein paar Dutzend
Objekte über eine ganze Serie. Solche Indikatoren werden unter `events` deklariert und über
`ctx.events(name)` gelesen — was **auf dieser Bar** bekannt wurde, und nichts sonst.

Gebucketet wird nach `index`, **niemals** nach `startIndex`. Das ist der ganze Grund, warum es
beide gibt: `startIndex` sagt, wo etwas gezeichnet wird, `index` sagt, ab wann man danach
handeln konnte. Der Zeichen-Index hier gäbe einer Strategie ein Setup, bevor der Markt es
fertig gemacht hat — exakt die Lüge, gegen die die Trennung erfunden wurde.

Ereignisse nehmen am Warm-up-Sprung nicht teil. Eine Serie ist undefiniert, bis ihr Fenster
voll ist, und das ist ein Grund zu warten; eine Bar ohne Ereignisse wärmt sich nicht auf, auf
ihr ist nur nichts passiert.

### Risiko gehört der Schicht, nicht der Strategie

Jede Strategie bekommt dieselben Fragen, also werden sie einmal gestellt — in `RISK_PARAMS` —
und überall gleich beantwortet: Wie viel steht auf einem Trade, wie weit liegt das Ziel
relativ dazu, und wie viel Notional darf die Position tragen. Eine Strategie mit eigenen Namen
dafür machte zwei Läufe unvergleichbar, und Vergleichen ist der Grund, warum Läufe gespeichert
werden.

**Die Positionsgröße wird abgeleitet, nie gesetzt.** Man wählt das Risiko; der Abstand zum
Stop bestimmt die Größe. Ein weiterer Stop kauft also eine kleinere Position statt eines
größeren Verlusts.

### Die Hebelgrenze ist keine Formalität

Risikobasierte Größenrechnung teilt durch den Stopabstand, ein enger Stop verlangt also eine
große Position. BTC bei 58.700, Stop 45 entfernt, 1 % von 10.000 riskiert: rechnerisch 2,2 BTC
— **130.000 Notional gegen 10.000 Eigenkapital**. Das kann auf Spot niemand halten, und die
Gebühren auf die Phantomgröße kosten bei 0,1 % je Seite mehr, als der Trade je verlieren
durfte.

Gemessen auf einem Monat BTC-5m machte ungedeckelte Größenrechnung aus 54 Silver-Bullet-Trades
**4.924 an Gebühren** gegen ein 10.000er Konto. Mit `maxLeverage` (Standard 1, also Spot)
fallen dieselben Gebühren auf 995. Der Broker selbst prüft keine Margin — er füllt jede Größe,
die eine Strategie verlangt —, also sitzt der Deckel in `positionSize`.

Deckeln senkt das tatsächliche Risiko unter das gewünschte: Der Stop liegt weiter dort, aber
eine kleinere Position verliert dort weniger. Das ist die ehrliche Richtung, in der man falsch
liegt, und sie ist sichtbar — ein Lauf, dessen Größen an der Decke kleben, sagt einem, dass
der Stop für dieses Risiko zu eng ist.

### Warum die Fills schlechter sind als die Indikator-Ausgänge

Der Detektor meldet den Entry auf der Bar, auf der der Preis die Lückenkante **berührt hat** —
rückblickend. Eine Order weiß das nicht. Wenn diese Bar geschlossen ist und die Strategie
gefragt wird, ist der Preis vorbei.

Also schickt die Strategie eine Market-Order auf der Signalbar, und die Engine — die eine
Order nie auf der Bar füllen lässt, die sie erzeugt hat — füllt gegen die nächste, plus
Spread, Slippage und Gebühr. Die `outcome`-Felder des Indikators und das Backtest-Ergebnis
werden deshalb **nicht** übereinstimmen. Diese Lücke ist kein Defekt, sondern der Preis dafür,
dass das Setup erst hinterher erkennbar ist.

Eine ruhende Limit-Order an der Kante füllte näher und ist das realistischere Modell. Sie ist
nicht gebaut, weil der Detektor nur Setups meldet, die auch einen Entry bekamen: Ihn auf der
MSS-Bar zu fragen, reichte der Strategie eine vorgefilterte Liste derer, zu denen der Preis
zurückkam — Rückschau im Kostüm einer Limit-Order. Das sauber zu lösen heißt, den Indikator
scharfgestellte Setups melden zu lassen, bevor er ihr Schicksal kennt.

### Läufe auf der Platte

`electron/data/store/runStore.js`: ein Index plus eine Datei je Lauf, unter
`userData/backtests/`.

Was das entscheidet, ist nicht die Zahl der Läufe, sondern die Größe eines einzelnen. Die
Equity-Kurve der Engine trägt **einen Punkt je Bar** — über ein Jahr 5m sind das 105.000
Punkte, mehrere MB je Lauf, in *jedem* Speicherformat. Die Lösung ist deshalb nicht der
Behälter, sondern das Verdichten der Kurve vor dem Schreiben: Zwischen zwei Trades bewegt sich
die realisierte Bilanz nicht. Aus 8.928 Punkten werden 101, ein Lauf wiegt 25 KB.

Damit wäre SQLite eine native Abhängigkeit, die gegen jede Electron-Version neu kompiliert
werden müsste, ohne dafür ein Problem zu lösen — ein paar hundert Objekte im Speicher
beantworten jede Frage schneller als der Roundtrip. Alles läuft durch vier Funktionen, falls
diese Einschätzung kippt.

**Ein Lauf speichert, womit er lief.** Ein Ergebnis ohne seine Einstellungen ist kein
Ergebnis: Zwei Läufe derselben Strategie, die sich in einer Zahl unterscheiden, sind der ganze
Grund fürs Speichern, und eine Seite, die den Ausgang zeigt aber nicht die Eingaben, macht
genau diesen Vergleich unmöglich. Gespeichert werden die **aufgelösten** Parameter — inklusive
jedes eingesetzten Standardwerts —, Symbol, Timeframe, Zeitraum, Startkapital, die
Fill-Auflösung und die Kosten.

Die Kosten meldet die **Engine**, nicht der Aufrufer. Wer nichts übergibt, bekommt die
Voreinstellungen des Brokers; ein Lauf, der die leere Überschreibung gespeichert hätte, würde
behaupten, kostenlos gewesen zu sein — und sähe vergleichbar aus mit einem Lauf von nach einer
Änderung dieser Voreinstellungen. Auf einem Monat BTC-5m waren es 995 an Gebühren gegen ein
10.000er Konto, also nichts, worüber ein gespeicherter Lauf schweigen darf.

Angezeigt werden sie über `shared/analysis/runSettings.js`, das die Werte durch das
Parameterschema der Strategie zurückliest: `riskMode: 'percent'` wird zu „Percent of equity".
Damit bekommt eine Strategie, die eine Einstellung dazubekommt, deren Anzeige geschenkt. Fehlt
das Schema — die Strategie wurde umbenannt, entfernt, oder ein Parameter fiel zwischen zwei
Versionen weg —, fällt jede Zeile auf den rohen Schlüssel zurück, statt zu verschwinden: Ein
Lauf, der `minGapSize: 50` unter einem unbekannten Namen zeigt, sagt weiter die Wahrheit, eine
leere Zeile nicht.

**Der Index ist abgeleitet, nie maßgeblich.** Fehlt er oder ist er unlesbar, wird er aus den
Dateien neu gebaut, statt eine leere Bibliothek über einem vollen Ordner zu zeigen. Deshalb
geht beim Löschen die Datei mit — ein zurückgelassener Lauf stünde beim nächsten Neuaufbau
wieder da.

Weggelassen werden Order- und Fill-Protokolle: ein Vielfaches der Trades, dieselben Ereignisse
feiner beschrieben, und nichts in der Oberfläche liest sie. Die Eingaben sind gespeichert, ein
Lauf ist also wiederholbar.

### Trades durchsehen

Sitzt im Ergebnis-Reiter als zweite Ansicht eines einzelnen Laufs, umschaltbar neben der
analytischen. Zwei Arten, dieselbe Frage zu stellen — was hat dieser Lauf getan —, und beide
wollen die ganze Fläche, also lösen sie einander ab statt sie zu teilen. Beim Vergleich mehrerer
Läufe gibt es die Ansicht nicht: Zwei ineinander verschachtelte Trade-Listen wären zwei
Strategien im Wechsel und beantworten nichts.

Eine Zusammenfassung sagt, dass eine Strategie verloren hat; sie sagt nie, warum. Zwanzig Bars
um einen Entry sagen es — und das von Hand zu tun, ein Jahr Chart zu einem aus einer Tabelle
kopierten Zeitstempel zu scrollen, ist genug Arbeit, dass es niemand tut. Also geht der Chart
zum Trade statt umgekehrt.

Geladen wird **nur das Fenster um den aktuellen Trade**, nicht der ganze Lauf: 60 Bars Vorlauf,
25 Nachlauf. Ein Jahr 5m sind 105.000 Bars, ein Trade braucht knapp neunzig, und für den Rest
auf dem Weg zum ersten zu bezahlen ließe den Knopf kaputt wirken. Wie viel Chart das ist, kommt
aus `stepMs`, das die Engine meldet und der Lauf speichert — die Alternative, eine
Timeframe-zu-Millisekunden-Tabelle in den Renderer zu kopieren, ist genau die Art Duplikat, die
auseinanderdriftet. Läufe von vor dieser Ergänzung haben keins und fallen auf eine Stunde
zurück: auf 1m zu viel Chart, auf 1d zu wenig, aber nie nichts.

**Gezeichnet wird der Trade als Positionsblock** — dieselbe Formensprache wie das
Setup-Primitive und das Positionswerkzeug: Risikozone vom Einstieg zum Stop, Gewinnzone zum
Ziel, Einstiegslinie gestrichelt dazwischen. Ein vom Indikator gefundenes Setup, ein von Hand
geplanter Trade und ein von der Engine tatsächlich ausgeführter sollen nicht drei
Bildsprachen brauchen. Was den ausgeführten unterscheidet, ist der **Ausgang**: Die Bar, die
ihn geschlossen hat, trägt eine Marke in der Farbe dessen, was passiert ist.

**Beschriftet wird er wie das Positionswerkzeug**, an denselben Stellen und aus denselben
`positionStats`: TP und SL zur Mitte ihrer eigenen Zone hin, der Einstieg auf der Gewinnseite,
Richtung und Chance-Risiko-Verhältnis an der Einstiegslinie in der Risikozone. Dazu das eine,
was nur ein ausgeführter Trade hat — das **realisierte Ergebnis** teilt sich die Zeile mit dem
R:R, denn genau darin unterscheidet er sich von einem geplanten. `formatPrice` ist dafür aus
`drawingPrimitive.js` exportiert: Zwei Blöcke nebeneinander, die unterschiedlich runden, sähen
aus wie zwei verschiedene Preise.

Ohne beide Schenkel gibt es kein Verhältnis. `positionStats` liest einen fehlenden als Null —
`Math.abs(entry - null)` ist der Einstiegspreis —, was jedem Lauf von vor der Klammer ein
erfundenes, selbstbewusstes R:R verpasst hätte. Das Primitive prüft deshalb auf beide, bevor es
rechnet, und schreibt sonst einen Geviertstrich.

Dafür muss der Trade seine Klammer kennen. Stop und Ziel lagen bisher nur in den Orders, und
die werden nicht gespeichert — `submitEntry` merkt sie deshalb an der Einstiegsorder, der Fill
reicht sie an die Position weiter, und die abgeschlossene Position schreibt sie in den Trade.
Läufe von vor dieser Ergänzung haben sie nicht und zeigen nur Ein- und Ausstieg.

**Fills lassen sich nicht über Zeitstempel platzieren.** Bei Intrabar-Auflösung passiert ein
Fill auf einer Minute *innerhalb* der Bar, seine Zeit ist also keine Bar-Zeit, und der Chart
hat nichts zum Anknüpfen — `timeToCoordinate` gäbe null zurück. `barIndexAt` sucht deshalb die
Bar, die den Fill enthält, und das Primitive rechnet wie alle anderen in logischen Indizes.
Festgehalten in `test/tradePrimitive.test.js`.

Beim Wechsel wird neu geladen statt zwischengespeichert. Jedes Fenster ist ein kleiner
IPC-Aufruf; ein Cache über alle Trades hielte den ganzen Lauf ein zweites Mal im Speicher, für
eine Ersparnis, die niemand bemerkt. Ein Zähler verwirft eine Antwort, die eintrifft, nachdem
weitergeblättert wurde.

### Läufe vergleichen

Ctrl-Klick wählt mehrere Läufe. Verglichen wird in Prozent des jeweiligen Startkapitals, nie in
Währung: Wer mit mehr angefangen hat, sähe bei gleichem Können besser aus.

**Die x-Achse ist Zeit.** Sie war es nicht — sie war die Position eines Punktes in seiner
eigenen Liste, und das ist nur dasselbe, wenn beide Läufe gleich viele Punkte haben. Eine
gespeicherte Kurve ist auf einen Punkt je Saldoänderung verdichtet, also hat ein Lauf mit neun
Trades elf Punkte und einer mit vierhundert deren 402. Über dieselbe Breite gezeichnet lag der
neunte Trade des einen über dem dreihundertsten des anderen, die Linien kreuzten sich, und keine
dieser Kreuzungen hatte mit dem Markt zu tun.

Zwei Achsenmodi, und keiner wird automatisch gewählt:

- **Kalender** — echte Zeitstempel. Die richtige Frage bei Läufen über denselben Zeitraum: wer
  lag im März vorn.
- **Starts ausgerichtet** — jeder Lauf beginnt bei null. Die richtige Frage bei Läufen über
  *verschiedene* Zeiträume, die auf einer Kalenderachse zwei getrennte Segmente mit einer Lücke
  dazwischen wären: wahr und nutzlos.

Welche der beiden Fragen gestellt wird, steht nicht in den Daten. Ein Chart, der seine Achse
still wechselt, ist einer, den man kein zweites Mal gleich liest.

**Gezeichnet wird als Treppe, nicht als Steigung.** Zwischen zwei Saldoänderungen saß das Konto
auf der älteren; eine gerade Linie dazwischen zeichnete einen Anstieg durch Tage, an denen nichts
gehandelt wurde. Der Wert unter dem Zeiger trägt denselben Wert fort, also stimmen Linie und
Ablesung überein.

**Der Settings-Diff ist die Frage, die ein Vergleich eigentlich stellt:** was habe ich geändert?
Eine Liste je Lauf beantwortet sie nicht — man liest zwei Spalten identischer Zahlen ab und sucht
die abweichende. Hier stehen die Parameter nebeneinander, abweichende Zeilen sind markiert, und
standardmäßig sind nur sie sichtbar. Ein Parameter, den nur ein Lauf hat, zählt als Unterschied
und wird als Fehlen gezeigt, nicht als Leerzeile.

**Die Kennzahltabelle markiert je Zeile die beste Zelle** — in der Richtung, in der die Zeile
gelesen wird. Eine Tabelle, die überall die größte Zahl hervorhöbe, krönte den tiefsten Drawdown
und die höchsten Gebühren. `COMPARE_METRICS.better` hält das fest; `none` steht dort, wo es kein
Besser gibt (Trade-Anzahl, Haltedauer). Ein `null` gewinnt nie: ein Lauf ohne Trades hat keine
Trefferquote, und die an die Spitze zu setzen läse sich als eine perfekte. Bei Gleichstand sind
beide markiert — eine Zeile, in der zwei Läufe gleichauf liegen, ist eine Zeile, in der die
Einstellung nichts entschieden hat.

**Unvergleichbarkeit wird gemeldet, nie erzwungen.** Verschiedene Märkte, Timeframes, Zeiträume,
Startkapitale, Kostenmodelle oder Fill-Auflösungen erscheinen als Hinweiszeilen über der Tabelle.
Ein 5m-Lauf auf BTC neben einem 4h-Lauf auf ETH ist eine völlig legitime Frage; sie abzulehnen
hieße, dass das Werkzeug entscheidet, was gemeint war.

Die Arithmetik liegt in `shared/analysis/compare.js` und ist in `test/compare.test.js`
festgehalten — eine Kennzahl, die niemand prüfen kann, ist eine Kennzahl, der niemand trauen
sollte.

### Der Lauf passiert im Hauptprozess

Aus demselben Grund wie das Volume Profile: Die Bars liegen schon dort. Ein Jahr Minuten über
die Brücke zu schicken, dort zu rechnen und zurückzuschicken, bewegte zig Megabyte für nichts.
Über die Brücke geht nur die fertige Zusammenfassung.

## 8c. Automatische Backtests (Sweeps)

### Was ein Sweep ist und wogegen er abgesichert werden muss

Ein Sweep probiert jede Kombination mehrerer Wertebereiche durch — FVG-Größe 4 bis 20 mal
CRV 1,2 bis 3,0 sind 323 Läufe — und stellt die besten den schlechtesten gegenüber.

Er ist damit vor allem **eine Maschine zum Überanpassen**. Wer dreihundert Kombinationen auf
einem Stück Historie testet und die beste behält, hat meistens die gefunden, die genau dieses
Stück auswendig gelernt hat. Sie sieht hervorragend aus und bedeutet nichts.

Deshalb wird der Zeitraum **geteilt**. Alle Kombinationen werden auf dem früheren Teil
gerankt; nur die wenigen, die angezeigt werden, laufen danach über den späteren Teil, der bei
der Auswahl kein Mitspracherecht hatte. Zwei Zahlen pro Kombination, und die Lücke dazwischen
ist der eigentliche Befund. Nur die Angezeigten nachzurechnen ist bewusste Sparsamkeit: Alle
323 zu prüfen verdoppelte die Kosten für Zahlen, die niemand ansieht.

Der Testabschnitt ist der **spätere**. Eine auf neuen Daten optimierte Regel gegen ältere zu
prüfen, prüft sie gegen einen Markt, der vorher kam — das beantwortet nichts.

### Warum das überhaupt bezahlbar ist

Gemessen auf 12 Monaten BTC-5m: Ein einzelner Lauf kostet 1.967 ms, und **1.975 ms davon sind
die Erkennung** — praktisch alles. Das Bucketing der Minutenbars sind 19 ms.

Entscheidend ist, dass die Erkennung nicht von jedem Parameter abhängt. `rrr`, `riskValue`,
`riskMode` und `maxLeverage` ändern, was die Strategie mit einem Setup *tut*, nicht welche
Setups es gibt. `runBacktest` nimmt deshalb einen optionalen `indicatorCache`, den der
Sweep-Läufer pro Abschnitt anlegt. Dein Beispiel — 17 Größen mal 19 CRV-Werte — braucht damit
17 Erkennungen statt 323: **23 Sekunden statt zehn Minuten**.

Der Cache ist nach Indikator und Parametern verschlüsselt und **nicht** nach den Bars. Damit
ist es Aufgabe des Aufrufers, pro Bar-Array einen eigenen zu führen; wer einen zwischen
Trainings- und Testabschnitt teilt, bekommt die Setups des einen gegen die Bars des anderen
gerechnet. Der Läufer legt genau deshalb zwei an.

### Sweeps werden nicht gespeichert

Ein Sweep ist eine einmal gestellte Frage — „spielt dieser Parameter hier überhaupt eine
Rolle" — und seine Antwort wird an Ort und Stelle gelesen. Eine Bibliothek davon wäre ein
zweites Archiv neben den Läufen, für Ergebnisse, zu denen niemand zurückkehrt. Eine
Kombination, die es wert ist, behalten zu werden, ist es wert, als **Backtest** nachgerechnet
zu werden — und der wird gespeichert.

Das Ergebnis lebt also so lange wie die Ansicht. Das Panel sagt das, bevor der Sweep startet,
statt es hinterher zu offenbaren.

### Werte in den Backtest übernehmen

Jede angezeigte Kombination hat einen *Use*-Knopf: Er trägt die Einstellungen in das
Backtest-Formular ein und wechselt dorthin. Damit ist der Sweep die grobe Suche und der
Backtest die genaue Abrechnung — mit Trade-Durchsicht und gespeichertem Report, die beide der
Sweep bewusst nicht hat.

Übergeben wird über `session.handoff`. Die beiden Ansichten sind Geschwister, die nie
gleichzeitig gemountet sind, es gibt also keine Komponente dazwischen, durch die sich ein Prop
reichen ließe. Der Wert wird beim Lesen **verbraucht** (`takeHandoff`): Bliebe er liegen,
würden dieselben Einstellungen bei jedem Öffnen des Backtest-Tabs erneut angewandt und still
überschreiben, was inzwischen editiert wurde.

**Markt und Timeframe reisen mit** und werden auf die Sitzung angewandt. Eine auf BTC-5m
gefundene Kombination bedeutet nichts, gegen das gerechnet, was der Chart gerade zeigt — und
das stillschweigend zu tun, wäre die Sorte Fehler, die richtig aussieht.

Eine Kombination trägt **alle** Parameter, nicht nur die variierten: `expandSweep` setzt zwar
nur die gesweepten Schlüssel, aber die Basis kommt aus den Schema-Defaults. Das Formular
mischt sie trotzdem über seine eigenen Defaults, damit ein Sweep von vor einer neuen
Einstellung diese nicht auf `undefined` setzt. Festgehalten in `test/handoff.test.js`.

Der übernommene Zeitraum ist der **ganze** des Sweeps, nicht nur der zurückgehaltene Teil. Das
ist der Zeitraum, nach dem gefragt wurde, und macht den Report mit jedem anderen Backtest über
dieselbe Spanne vergleichbar. Er enthält damit aber die Bars, auf denen die Einstellungen
ausgewählt wurden — der Report liest sich also freundlicher als die Out-of-Sample-Spalte, und
sowohl der Knopf als auch das Formular sagen das.

### Das Limit ist kein Zeitbudget

`MAX_COMBINATIONS` steht auf 100.000 und ist eine Absicherung gegen Vertipper, nicht gegen
Ehrgeiz: Ein Schritt von 0,001 statt 0,1 expandiert auf Millionen, und das gehört abgelehnt,
bevor irgendetwas startet.

Als Zeitbudget taugt die Zahl nicht, denn was eine Kombination kostet, hängt vollständig davon
ab, **welcher** Parameter variiert wird. `detectionCount` beantwortet das: Es zählt nur die
Bereiche über Parameter, die die Erkennung berühren. 323 Kombinationen über eine einzige
Erkennung sind Sekunden, 323 über 323 Erkennungen sind Minuten. Das Panel zeigt beide Zahlen
nebeneinander, und die zweite ist die, auf die es ankommt.

### Ein eigener Thread, nicht der Hauptprozess

Ein Sweep sind Minuten bis Stunden ununterbrochener Rechnerei. Im Hauptprozess hielte er die
Event-Loop für die gesamte Dauer: kein IPC, keine Fensterereignisse, kein Fortschritt — eine
App, die aussieht, als sei sie abgestürzt. Also läuft er in `sweepWorker.js` auf einem
Worker-Thread, und `sweepManager.js` besitzt genau einen davon.

Die Bars werden **im Worker gelesen**, nicht hineingeschickt. Ein Jahr 5m plus die Minuten
darunter sind über eine halbe Million Objekte; die über die Thread-Grenze zu klonen kostet
mehr als die Datei erneut zu lesen.

**Abgebrochen wird über einen `SharedArrayBuffer`**, nicht per Nachricht. Der Worker gibt
während der Schleife nie an seine Nachrichtenschlange ab, ein gesendeter Stopp würde also erst
gelesen, wenn der Sweep ohnehin fertig wäre. Ein geteiltes Byte lässt sich zwischen zwei
Kombinationen lesen. Der Abbruch ist kooperativ und damit verlustfrei: Terminieren wäre
sofortig, würfe aber die bereits gerechneten Kombinationen weg.

### Ranking

Voreinstellung ist der **Erwartungswert pro Trade**: Er fragt, ob die Regel selbst etwas taugt,
unabhängig davon, wie oft sie feuerte und wie groß die Positionen waren. Nettogewinn belohnt,
was am meisten handelte und am meisten riskierte; der Profitfaktor ignoriert, wie selten die
Trades waren. Keines ist allein sicher, alle drei sind wählbar.

Dafür gibt es `minTrades`: Eine Kombination mit vier Trades kann jedes Maß per Zufall anführen,
und sie als beste zu melden wäre der Sweep, der über seinen eigenen Fund lügt. Zu seltene
Kombinationen werden nicht schlecht gerankt, sondern **aussortiert** — und die Zahl der
Aussortierten wird gemeldet, statt sie stillschweigend zu verlieren.

Auch das schlechte Ende wird gezeigt, nie nur die Gewinner: Der Abstand zwischen beiden Enden
sagt, ob der Parameter überhaupt etwas bewirkt. Liegen vier Kombinationen alle auf einem Haar
beieinander, ist die Einstellung nicht das, was das Ergebnis treibt — und das verrät erst die
Zahl des Verlierers.

### Fließkomma in Bereichen

Ein Bereich von 1,2 bis 3,0 in Schritten von 0,1, durch fortgesetzte Addition gelaufen, kommt
bei 1.9000000000000001 an und speichert das als Parameter. Zwei Sweeps, die identisch sein
müssten, sind es dann nicht, und ein gespeichertes Ergebnis liest sich wie Rauschen. Jeder Wert
wird deshalb als `from + index * step` berechnet und auf die Nachkommastellen gerundet, die der
Schritt selbst trägt. Festgehalten in `test/sweep.test.js`.

## 8d. Replay

Bar für Bar durch die Historie, von Hand gehandelt — die andere Hälfte des Satzes über der
Order-Engine: Im Backtest ruft eine Strategie `ctx.buy()`, im Replay klickt ein Mensch auf
Kaufen, und beides endet in derselben `Broker`-Klasse.

### Die eine Regel, die es zum Test macht

Die Bar unter dem Abspielkopf ist die letzte **abgeschlossene**. Alles danach ist nicht
versteckt, sondern existiert für die Sitzung nicht: Der Chart bekommt `bars.slice(0, index+1)`,
also kann ein Indikator eine nicht aufgedeckte Bar nicht sehen, weil sie nicht im Array ist. Das
ist eine stärkere Zusage, als Kerzen auszublenden, und dieselbe, die die Engine einer Strategie
gibt.

Eine Order, die beim Stand auf Bar *i* gegeben wird, wird gegen Bar *i+1* geprüft — beim Schritt,
der sie aufdeckt. Exakt die Backtest-Regel: Eine Order füllt nie auf der Bar, die sie erzeugt hat.

Look-ahead ist im Replay ein anderes Problem als im Backtest, weil der Mensch davor einfach
hinsehen kann. Nichts im Code verhindert das. Was er verhindern kann, ist, dass das **Konto**
davon profitiert: Der Fill-Preis kommt von der Bar nach der Entscheidung, mit demselben Spread,
derselben Slippage und derselben Kommission, die eine Strategie gezahlt hätte.

### Warum der Broker jetzt in `shared/` liegt

Ein Backtest läuft im Hauptprozess, wo die Bars schon liegen. Ein Replay läuft im Renderer, weil
ein Klick im selben Frame zu einer Order und einem neu gezeichneten Chart werden muss und nicht
nach einer Rundreise. Beide brauchen dieselbe Klasse, und der Renderer kann nicht nach
`electron/` greifen — also liegt sie dort, wo beide sie importieren können:
`shared/engine/broker.js`. `summarize()` ist aus demselben Grund nach `shared/engine/summary.js`
gewandert: Fasste jede Seite sich selbst zusammen, meldete dasselbe Konto zwei verschiedene
Trefferquoten, sobald eine von beiden angefasst würde.

`shared/engine/replaySession.js` bekommt die Bars gereicht statt sie zu holen — kein IPC, keine
Uhr, kein Chart darin, also lässt sich eine Sitzung mit zwanzig Bars in einem Array prüfen
(`test/replaySession.test.js`). Die Sitzung bietet dieselben fünf Namen an, die die Engine einer
Strategie unter `ctx` gibt: `buy`, `sell`, `order`, `close`, `cancelAll`. Ein Mensch, der Kaufen
klickt, und eine Strategie, die `ctx.buy()` ruft, sind damit nicht nur hinterher vergleichbar —
es ist derselbe Aufruf.

### Das Fenster gehört dem Store, nicht dem Chart

Ein Replay-Fenster hat eine andere Form als ein Chart-Fenster. Der Chart lädt die neueste Seite
und blättert beim Scrollen rückwärts; ein Replay lädt einen Ausschnitt **um einen gewählten
Moment** und läuft dann vorwärts hindurch. Beides aus einem Paging-Zustand zu bedienen hieß, dass
der Chart unter einer laufenden Sitzung nachlädt — und die Sitzung zählt jeden Index vom Anfang
ihres Arrays, eine vorn eintreffende Seite verschöbe also jeden bereits getätigten Trade auf eine
andere Bar.

Während einer Sitzung zeichnet der Chart deshalb, was in `stores/replay.js` liegt, und lädt
selbst nichts. Vorwärts-Chunks werden **angehängt** — die einzige Richtung, die bestehende
Indizes stehen lässt, und `ReplaySession.extend` prüft sie, statt ihnen zu vertrauen. Der
Timeframe ist während einer Sitzung gesperrt: Ihre Bars *sind* dieser Timeframe.

Geladen werden 1.500 Bars Vorlauf (Kontext und Indikator-Warmlauf) und ein Vorwärts-Chunk von
höchstens 400 Bars.

### Minuten chunkweise, nicht je Bar

Eine Bar, die Stop und Ziel berührt, wird wie im Backtest über ihre Minuten entschieden.
Naheliegend war, sie je Schritt zu holen — und **gemessen am gespeicherten BTCUSDT-Datensatz
kostet ein `data:bars`-Aufruf rund 50 ms, egal was er verlangt**: fünfzehn Minuten-Bars und
fünfzigtausend kommen gleich schnell zurück, weil das Öffnen der Datei den Aufruf dominiert. Je
Bar zu holen kostete damit 40 ms **pro Schritt**; 400 Bars brauchten 16 Sekunden.

Die erste Bar, die Minuten braucht, holt sie deshalb für den ganzen Vorwärts-Chunk, alle weiteren
lesen aus der Map. Dieselben 400 Bars: **60 ms, ein einziger Abruf, identisches Ergebnis** (11
Trades, −724,24, `intrabar`). 0,15 ms je Schritt, also trägt auch die höchste Geschwindigkeit von
30 Bars/s.

Nichts wird geholt, solange keine Order ansteht: Ohne Order gibt es keinen Fill zu entscheiden,
und das ist der Normalfall der meisten Bars.

### Größe folgt aus dem Risiko

Dieselbe `positionSize` wie die Strategien, mit denselben drei Einstellungen (Modus, Risiko,
Hebelgrenze). Ein von Hand genommener Trade und ein von einem Bot genommener sind damit bei
gleichem Stop gleich groß — die Voraussetzung dafür, dass ihre Ergebnisse überhaupt nebeneinander
stehen dürfen. Ohne Stop gibt es keine definierte Risikogröße, und statt eines Standardwerts ist
der Knopf deaktiviert. Eine feste Stückzahl ist die zweite Option, nicht die erste.

Eine ruhende Order trägt ihre Klammer mit und bekommt sie beim Fill (Abschnitt 8). „Protect" an
der offenen Position macht dasselbe für eine Position, die schon läuft — und wie jede Order ab
der nächsten Bar: Schutz, der nach dem Schluss einer Bar beschlossen wurde, kann während ihr
nicht im Markt gewesen sein.

### Eine gezeichnete Position wird zur Order

Das Positionswerkzeug fragt bereits alles ab, was eine Order braucht, bis auf die Größe: wo du
rein willst, wo du falsch liegst, wo du fertig bist. Diese drei Zahlen danach in ein Ticket
abzutippen ist genau der Moment, in dem sie falsch abgetippt werden. Also: **Rechtsklick auf den
gezeichneten Block** — während ein Replay läuft — und er wird zur Order. Ohne laufendes Replay
gibt es kein Konto, an das sie ginge, und das Menü erscheint nicht.

Zwei Lesarten desselben Blocks (`shared/engine/plannedTrade.js`):

- **Pending** — die Level, wie gezeichnet. Der Plan galt für *diesen* Preis, also wartet die
  Order dort. Ob das ein Limit oder ein Stop ist, ist keine zweite Frage: Es folgt daraus, auf
  welcher Seite des aktuellen Preises der Einstieg liegt. Danach zu fragen hieße, den User um
  eine Wiederholung dessen zu bitten, was er gerade gezeichnet hat.
- **Market** — die *Abstände*, wie gezeichnet, ab jetzt. Ein vor einer Stunde gezeichneter Block
  hat einen Einstieg, den der Markt hinter sich gelassen hat; was noch etwas wert ist, ist seine
  Form — Risiko 500, Ziel 1000 —, und die wandert an den aktuellen Preis.

**Die Abstände werden nicht hier ausgerechnet.** Eine Market-Order füllt auf der nächsten Bar, zu
deren Open plus Spread und Slippage, und das steht beim Absenden nicht fest. Die Klammer geht
deshalb als Offset an den Broker und wird am Fill zu Leveln. An echten Daten (BTCUSDT 15m, Plan
mit 471,12 Risiko): Fill bei 95.205,21 statt der geplanten 94.224,89 — **tatsächlich
eingegangenes Risiko exakt 471,12**. Bei der Pending-Variante wartete dieselbe Zeichnung als Buy
Limit auf 94.224,89, füllte auf 94.234,32 und trug die gezeichneten Level; ihr Stop lag dann
480,55 entfernt, weil sie etwas über dem gezeichneten Einstieg füllte. Beide Lesarten sind damit
das, was auf der Zeichnung steht — nur eben zwei verschiedene Fragen an dieselbe Zeichnung.

Beide Menüeinträge werden **vorab** gebaut, nicht beim Klick: Ein Block, aus dem keine Order
werden kann — Stop auf dem Einstieg, Ziel auf der falschen Seite —, sagt das im Menü, statt nach
der Auswahl fehlzuschlagen. Die Prüfung ist strenger als die des Zeichenwerkzeugs, und das ist
Absicht: `positionDirection` muss für *jede* Anordnung dreier Anker eine Antwort haben, weil ein
Block immer irgendwie gezeichnet werden muss. Eine Order darf so nachsichtig nicht sein.

Die Größe kommt aus denselben Risiko-Einstellungen wie das Ticket, gerechnet gegen den Abstand
aus der Zeichnung — bei beiden Lesarten derselbe, sonst risikierte derselbe Plan je nach
Menüeintrag zwei verschiedene Beträge.

**Die Zeichnung wird beim Einstieg abgelöst, nicht beim Absenden.** Solange die Order nur wartet,
ist der Block das Einzige, was zeigt, wo ihr Stop und ihr Ziel hinkommen werden — die Klammer
existiert bis zum Fill nicht als Order. In dem Moment, in dem der Einstieg tatsächlich füllt,
zeichnet die Engine die Position, und zwei fast deckungsgleiche Blöcke übereinander sagen nichts
Zusätzliches: Der gezeichnete verschwindet. Wird die Order stattdessen storniert, bleibt er —
eingestiegen wurde ja nicht, der Plan steht also weiter.

Deshalb wird die Zeichnung an der Order gemerkt und nicht sofort gelöscht: Der Zeitpunkt, auf den
es ankommt, ist der Fill, und der kann viele Bars später kommen oder nie. Gemerkt wird am
Order-*Objekt*, nicht an seiner Id — der Broker setzt `status` in place, es gibt also nichts
nachzuschlagen. `takeEnteredPlans()` reicht die fälligen Ids genau einmal an den Chart weiter,
nach demselben Muster wie der vom Chart gepickte Preis; ohne dieses Abholen versuchte der Chart
bei jedem Repaint dieselben Zeichnungen erneut zu löschen.

Am Overlay wird dafür der Rechtsklick ausgefiltert: Ohne `event.button !== 0` startete er eine
Ziehgeste und zöge die Zeichnung unter dem Menü weg, das sie gerade beschreibt.

### Die Ansicht gehört dem User

Ein Replay wird von Hand eingerichtet: Zoom, und wo die neueste Kerze steht, damit rechts Platz
bleibt, in den hinein gelesen wird. Ein `scrollToRealTime()` bei jedem Schritt hat genau das
Schritt für Schritt weggeworfen — die Kerze sprang an den rechten Rand zurück, sobald *Step* oder
*Play* eine Bar aufdeckte.

Nötig war der Aufruf nie: Die Zeitachse hält einen **Right-Offset**, keinen absoluten Bereich.
Eine aufgedeckte Bar lässt die neueste Kerze deshalb genau stehen, wo sie war, und schiebt den
Chart darunter durch. Wer zurück in die Historie gescrollt hat, wird von der Library in die
andere Richtung kompensiert und bleibt auf den Bars, die er liest. Beides ist das Gewünschte —
solange nichts von hier aus dazwischenfunkt.

### Position und Level am Chart

Am rechten Rand steht auf der Einstiegslinie, was die Position **jetzt** wert ist: unrealisiert,
und in R daneben, wo es einen Stop gibt, gegen den sich das messen lässt. 240 sagt für sich
genommen wenig; 240 gegen 400 Risiko sagt das meiste. Die Zahl kommt aus `broker.unrealizedPnl`
statt hier noch einmal gerechnet zu werden — sonst könnten Chart und Panel über dasselbe Konto
verschiedener Meinung sein.

Gezeichnet wird die Position als Verlauf: die Fläche am Level am kräftigsten, zur Einstiegslinie
hin auslaufend. Um den Einstieg herum stehen die Kerzen, dort soll frei bleiben; das weit
entfernte Ende ist das Level selbst, und das ist der Teil, den das Auge finden soll. Am
Blockanfang sitzt ein Dreieck auf der Einstiegslinie, daneben ein Chip mit der Richtung und eine
Plakette mit Größe und Einstiegspreis — Plakette, weil ein 10px-Label ohne Grund in den Kerzen
verschwindet. Was nicht mehr auf den Block passt, entfällt der Reihe nach; die Breiten werden
gemessen und nicht gegen eine Mindestbreite geraten, denn eine Schwelle, die für „0,05 @ 1,2345"
stimmt, schneidet „0,05 @ 95.205,21" ab.

**Grün und Rot bedeuten hier Gewinn und Verlust und sonst nichts** — das sind die Zonen. Eine
Richtung ist weder gut noch schlecht, Long und Short nehmen deshalb die beiden Farben, mit denen
der Chart ohnehin oben und unten zeichnet (`--candle-up-brd` / `--candle-down-body`), so wie
`_orders` es bei einer ruhenden Order schon immer getan hat. Das ist dieselbe Entscheidung, die
die Kerzen blau/weiß statt grün/rot macht — siehe `tokens.css`.

**Die Schrift ist hier nicht die Mono der anderen Primitives**, und das ist Absicht. Zonen- und
Zeichen-Primitives beschriften eine *Analyse* — eine Lücke, ein Level, eine Session —, und dort
ist Mono richtig: Meta-Text über den Chart, so will es die Designsprache. Dieses Primitive
beschriftet ein **Konto**: was offen ist, was es wert ist, was der Stop kostet. Das wird im
Vorbeigehen gelesen, über Kerzen, während sich etwas bewegt — und Inter ist dabei schlicht
schneller zu erfassen als eine Schreibmaschinenschrift. 12px statt 10, die Richtung im
Display-Schnitt der Knöpfe mit etwas Laufweite, und alle Kästchen mit `--radius-sm`, also
derselben Ecke wie Buy und Sell.

Gewicht 600 bei Plus Jakarta Sans, nicht 700: Canvas lädt kein Face nach, das kein Element der
Seite angefordert hat, ein sonst ungenutztes Gewicht fiele also still auf einen Ersatz zurück.
Inter liegt als eine Variable-Datei bereit und hat das Problem nicht.

Stop und Ziel tragen ihre eigenen Marken auf derselben Linie und **werden dort auch gezogen**.
Ein Stop wird verschoben, indem man auf den Chart sieht und ihn hinlegt, nicht indem man eine
Zahl in ein Ticket tippt. Während die Maus unten ist, ändert sich am Konto nichts: Der Zug ist
eine Vorschau, die das Primitive zeichnet, und erst das Loslassen ersetzt den Schutz — über
dasselbe `protectPosition`, das die „Protect"-Zeile benutzt. Ein von Hand gezogenes Level wird
damit exakt die Order, die ein getipptes wird, ab der nächsten Bar wie alles andere.

Beide Legs gehen zusammen zurück in den Markt: `protectPosition` ersetzt, was auf der Position
liegt — nur das gezogene zu senden, stornierte das andere.

**Wo noch kein Stop ist, wird er von der Einstiegslinie weggezogen.** Die Einstiegslinie ist
immer greifbar — nicht, um sie zu verschieben, eine Position wurde eröffnet, wo sie eröffnet
wurde, sondern als *Quelle*. Was dabei entsteht, entscheidet `fieldForPrice`: die Seite des
**letzten Preises**, nicht die des Einstiegs. Ein Long, der schon 100 vorn liegt, hat seinen
Einstieg weit unter dem Markt; nach unten davon zu ziehen heißt trotzdem „hier liege ich falsch"
und nicht „hier ist mein Ziel". Losgelassen, ohne die Linie verlassen zu haben, passiert nichts:
Das war ein Klick auf die Position, kein gezogenes Level.

Zwei Stellen, zwei Zuständigkeiten: `fieldForPrice` sagt, *was* ein Level ist, `levelRefusal`
sagt, *ob* es dort sein darf. Genau auf dem letzten Preis beantwortet die erste die Frage und die
zweite lehnt ab.

Beträge tragen ein **$**, Preise nicht. Auf einer Marke, die beides nebeneinander stellt, sind
„SL 94.000,00 250,00" zwei Zahlen unbekannter Art; „SL 94.000,00 −$250,00" sind ein Level und
das, was Irrtum dort kostet. Das Symbol steht in `QUOTE_SYMBOL` — die App führt keine Währung je
Markt, also ist es genau ein Platzhalter, und ein Markt, der nicht in Dollar notiert, wollte ihn
aus dem Symbol lesen. Panel und Transportleiste schreiben denselben Betrag genauso, sonst stünde
dieselbe Zahl an zwei Orten in zwei Schreibweisen.

Ganz rechts auf der Einstiegslinie sitzt ein **×**, das die Position schließt — dieselbe
Market-Order wie „Close" im Panel. Umrandet, gefüllt erst unter dem Zeiger: Es liquidiert mit
einem Klick, soll also nach etwas aussehen, das gedrückt wird, und nicht nach etwas, über das man
fährt. Ausgelöst wird beim Loslassen **über dem Knopf**, denn Drücken und Wegziehen ist, wie man
einen Klick zurücknimmt, den man nicht meinte.

Sein Rechteck kommt aus `closeButtonRect`, und zwar für das Zeichnen wie für den Treffertest —
ein Knopf, dessen Bild und dessen Klickfläche getrennt ausgerechnet würden, schlösse irgendwann
eine Position von einer Stelle aus, an der er nicht zu sehen ist. Gefragt wird er vor den Leveln:
Er liegt auf der Einstiegslinie, beide antworteten sonst, und ein Knopf, der nicht klickbar ist,
weil die Linie darunter gezogen werden will, ist keiner.

**Abgelehnt wird ein Level auf der falschen Seite des letzten Preises** (`replayLevels.js`,
`levelRefusal`). Ein Stop dort ist kein Stop: Er ginge in den Markt, triggerte gegen das nächste
Open und schlösse die Position — das Level hätte den Trade *beendet* statt ihn zu schützen. Ein
Ziel auf der falschen Seite tut dasselbe über ein Limit, das bereits marktfähig ist. Genau auf
dem letzten Preis wird ebenfalls abgelehnt: Die nächste Bar öffnet darauf, auf welcher Seite der
Fill landet, ist Münzwurf. Die Ablehnung steht als Zeile im Chart, wo auch das Zeichenwerkzeug
seine Rückmeldungen gibt.

Die Klammer einer offenen Position zeichnet damit nur noch der Block — die zugehörigen
`stop-loss`/`take-profit`-Orders werden in `_orders` übersprungen. Sonst lägen zwei Linien und
zwei Beschriftungen auf demselben Preis.

Gegriffen wird über die Pane-Breite, nicht über die Elementbreite: Die Linien enden, wo die
Preisachse anfängt, und ein Band der Achse, das sich nicht ziehen ließe, weil zufällig ein Level
darüber läuft, wäre eine seltsame Sache. Das Overlay schaltet sich für ein Level genauso an wie
für eine Zeichnung — und weil es dann die `mousemove` des Hosts schluckt, hält es den Hover von
sich aus aktuell, solange nichts gezogen wird.

Die Marken am rechten Rand sind selbst Griffe, und darum beginnt die greifbare Strecke nie weiter
rechts als sie: Eine gerade eröffnete Position hat einen Block von wenigen Pixeln Breite — und
genau dann muss der Stop drauf (`TAG_REACH`).

### Was noch nicht gefüllt hat

Eine Market-Order hat keinen eigenen Preis; sie nimmt, was die nächste Bar aufmacht. Bis dahin
stand deshalb **nichts** auf dem Chart: Zwischen dem Klick auf Buy und der Bar, die ihn
beantwortet, sah es aus, als sei nichts passiert.

`announcedEntries` zieht diese Orders aus dem Buch, und `_announced` zeichnet sie ab dem
Abspielkopf nach rechts, auf Höhe des letzten Schlusskurses — gestrichelt, mit Dreieck,
Richtungs-Chip und „next bar" dahinter. Das ist ausdrücklich **nicht** die Position, sondern ihre
Ankündigung: Die Regel, dass eine Order frühestens auf der Bar nach der auslösenden füllt, bleibt
unberührt, und die gestrichelte Linie sagt genau das. Der Schlusskurs ist die ehrliche Schätzung;
gefüllt wird zum nächsten Open plus Kosten, und das weiß jetzt niemand.

Rechts vom Abspielkopf liegen nur die paar Bars, die der Chart als Offset hält — selten Platz für
ein Label. Es rutscht deshalb an seiner eigenen Linie nach links, statt vom Pane abgeschnitten zu
werden.

Ein `reduceOnly`-Market ist nicht dabei: Er schließt, was schon gezeichnet ist, und ihn als
ankommende Position zu melden, zeichnete eine zweite in die Gegenrichtung.

### Die Schnellleiste

Oben links im Chart: **Buy**, ein Größenfeld, **Sell**. Ein Klick schickt eine Market-Order über
denselben Weg wie das Ticket, nur ohne Stop und ohne Ziel — gestrichelt sichtbar ab dem Klick
(siehe „Was noch nicht gefüllt hat"), gefüllt auf der nächsten Bar. Die drei Style-Leisten teilen
sich dieselbe Ecke — sie sind immer nur einzeln zu sehen, und solange eine Sitzung läuft, rücken
sie unter die Leiste (`.is-trading`).

Das Fehlen der Klammer ist der Zweck, nicht die Lücke. Schutz, der hier mit eingetragen würde,
wäre eine unter Zeitdruck getippte Zahl; die eröffnete Position steht einen Moment später mit
ihrer eigenen Stop- und Ziellinie im Chart, und die werden mit der Maus hingelegt. Einstieg mit
der Maus entscheiden, Level mit der Maus entscheiden.

Das Feld ist **leer**, bis eine Größe eingetragen wird, und beide Knöpfe sind bis dahin tot. Eine
aus dem letzten Setup übriggebliebene Größe ist hier der eine Fehler, der Geld kostet, also wird
sie nie geraten. Die Pfeile gehen um 1 — auf die Nachkommastelle genau getippt wird alles
Feinere. Der Wert liegt im Store und nicht in der Komponente, damit ein Wechsel des Reiters kein
Feld leert, das gerade gebraucht wird.

Das Textfeld hält seinen eigenen Text, statt den geparsten Wert zurückzulesen: Sonst zerfiele die
„0" von „0,05" beim Tippen zu nichts, das Feld leerte sich unter dem Cursor, und keine Größe
unter eins wäre je einzugeben.

Gesendet wird nur bei `status === 'ready'` — `active` ist eine Sitzung schon in der Sekunde, in
der ihr Fenster noch lädt, und dahinter steckt dann noch keine Session, die eine Order annehmen
könnte.

### Gespeichert wird als Lauf

`ReplaySession.result()` liefert dieselbe Form wie `runBacktest`, geht durch denselben `runStore`
und landet in derselben Bibliothek — `strategy: 'replay'`, `strategyName: 'Manual replay'`.
`params` bleibt bewusst leer: Eine Sitzung hat keine Einstellung, die für ihre ganze Dauer galt,
das Risiko jedes Trades wurde im Moment entschieden, und einen davon zu speichern wäre eine
Behauptung, die die Sitzung nicht trägt. Was tatsächlich passiert ist, tragen die Trades.

Genau das ist der Zweck: Eine von Hand gehandelte Sitzung lässt sich im Vergleich neben das
legen, was eine Strategie über dieselben Bars getan hat.

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
`.icon-btn` — vor jeder neuen Klasse prüfen, ob eine davon passt.

### Bestätigung vor dem Löschen

Jede Aktion, die etwas unwiederbringlich entfernt, geht durch `ConfirmModal` — eine Komponente
für alle, damit Zerstörerisches überall gleich aussieht und sich gleich verhält. Fünf Stellen:
ein gespeicherter Lauf, eine ausgewählte Zeichnung, alle Zeichnungen eines Symbols, ein
Indikator, eine eigene Session.

Das Modal entscheidet nicht, was zerstörerisch ist, und löscht auch nichts selbst — es meldet
`confirm`, der Aufrufer führt aus. Eines, das selbst löschte, müsste jeden Store der App
kennen. Der Aufrufer hält deshalb auch, *was* gerade zur Bestätigung ansteht, denn nur er kann
es benennen: „Silver Bullet auf BTCUSDT 5m, 54 Trades" ist eine Warnung, „Sind Sie sicher?"
nicht.

Der Bestätigungsknopf bekommt beim Öffnen den Fokus. Das klingt verkehrt für eine gefährliche
Aktion, ist es aber nicht: Escape und ein Klick auf den Hintergrund brechen ab, die Fluchtwege
sind also die bequemen, und der Tastaturweg ist Enter statt Tab-dann-Enter. Der Knopf trägt
`.btn--danger` — im Projekt seit jeher definiert, bis jetzt ungenutzt —, also liest sich das
Fokussierte als Warnung.

**Die Entf-Taste fragt nicht.** Eine Zeichnung auszuwählen und eine bestimmte Taste zu drücken
ist bereits absichtsvoll; ein Modal bei jedem Druck machte das Aufräumen eines Charts zur
Qual. Ein Knopf lässt sich versehentlich treffen, und „alle entfernen" nimmt jede Zeichnung des
Symbols mit — das sind die Fälle, die eine Unterbrechung wert sind.

### Hover-Hinweise

`title` ist als Tooltip aufgegeben: Es lässt sich nicht gestalten, erscheint erst nach etwa
einer halben Sekunde und wird vom Betriebssystem gezeichnet statt von der App. In einem Panel,
in dem jeder Regler eine Erklärung braucht, liest sich das wie nachträglich angeklebt.

Stattdessen `src/hints.js` (Direktive `v-hint`) plus **eine** `HintTooltip`-Fläche nahe der
Wurzel. Eine statt einer pro Feld, weil das Seitenpanel scrollt (`overflow-y: auto`) — ein
Tooltip darin würde exakt an der Kante abgeschnitten, an der es erscheinen muss, denn das
Panel klebt am Fensterrand. Die eine Fläche liegt `position: fixed` in Viewport-Koordinaten
und wählt die Seite mit mehr Platz, überlebt also auch ein schmales Fenster.

Gestaltet als kleineres Geschwister von `.k-panel`: derselbe Gradient, dieselbe 1px-Linie,
derselbe Schatten, eine Radius-Stufe kleiner. Kein Blur — die Sprache benutzt Gradient-
Flächen, und über dem Chart würde Blur den Kursverlauf verschmieren. Der Kopf ist ein
`k-mono-label` in Akzentfarbe: dieselbe Rolle wie das Eyebrow einer Sektion, nur kleiner.

Der Text kommt aus dem `hint`-Feld des Indikator-Schemas (Abschnitt 6), nicht aus dem Markup —
eine Erklärung, die neben ihrer Definition steht, veraltet seltener als eine im Template.
`test/components.test.js` prüft, dass jede im Template benutzte Direktive in `main.js`
registriert ist: Eine fehlende Registrierung baut sauber durch und fällt erst beim Rendern
auf, genau wie ein Binding, das das Setup nie exportiert hat.

### Hell und Dunkel

Drei Modi statt eines Umschalters: „System" ist eine echte Wahl und nicht das Fehlen einer —
ohne diesen Zustand löst ein einziger Klick die App dauerhaft von der Einstellung des
Betriebssystems.

Der Renderer besitzt das Thema, weil nur er weiß, welcher Modus gewählt ist. Das Fenster wird
mit der Systemeinstellung als bester Schätzung für das erste Bild erzeugt; danach korrigiert der
Renderer über `ui:set-theme`. **Der native Fensterrahmen wird vom Betriebssystem gezeichnet und
kann keine CSS-Klasse lesen** — ohne diese Meldung bleibt beim Umschalten auf Dunkel eine helle
Titelleiste über einer dunklen App stehen. Es gibt bewusst keinen `nativeTheme`-Listener im
Hauptprozess: eine Wahrheitsquelle, damit sich beide Seiten nicht widersprechen können.

Die Farben des Rahmens stehen in `electron/titlebar.js` — einem eigenen Modul, damit
Fenstererzeugung und IPC-Handler sie teilen können, ohne einander zu importieren. Sie müssen mit
`--bg` und `--txt` synchron bleiben.

## 11. Meilensteine

- **M0 — Daten und Chart** ✅ Binance-Downloader mit Checksum, Binärstore, Aggregation,
  Chart mit Timeframe-Umschaltung und Nachladen beim Scrollen.
- **M0.5 — Indikatoren** ✅ Gemeinsames Indikator-Modul, Volume Profile mit POC, Value Area
  und Buy/Sell-Delta, Bedienpanel.
- **M0.6 — Zeichenwerkzeuge** ✅ Trendlinie, Strahl, horizontale/vertikale Linie, Rechteck,
  Fibonacci, Messwerkzeug und ein Positionswerkzeug mit Risiko/Chance-Zonen, dessen Richtung
  aus den Ankern folgt; Auswählen, Verschieben, Ankerpunkte ziehen, Speicherung pro Symbol.
- **M1 — Order-Engine** ✅ Market/Limit/Stop, Klammern mit gegenseitiger Aufhebung, Spread,
  Slippage, Kommission, Teilausführungen und Umkehr, Intrabar-Auflösung über die 1m-Basis,
  Backtest-Loop mit Kennzahlen. Vorgezogen, weil Replay sonst zweimal gebaut würde.
- **M2 — Replay** ✅ Abspielkopf, Bar-für-Bar-Vorlauf (Leertaste, Pfeil rechts, 1–30 Bars/s),
  Ticket mit Market-, Limit- und Stop-Einstieg, risikobasierte Größe, Stop und Ziel per Klick vom
  Chart, Konto- und Positionsanzeige, Speichern als Lauf — auf derselben Engine (Abschnitt 8d).
- **M3 — Bots.** Monaco-Editor, Worker-Ausführung, `midori.d.ts`, Kennzahlen (P&L, Drawdown,
  Sharpe, Trefferquote, Erwartungswert).
- **M4 — Analyse.** Equity-Kurve ✅, Trade-Liste mit Sprung zum Entry ✅, Vergleich mehrerer
  Läufe auf einer Zeitachse mit Settings-Diff ✅ (Abschnitt 8b). Offen: risikoadjustierte
  Kennzahlen, Benchmark, Parameter-Optimierung über einen Worker-Pool.
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
