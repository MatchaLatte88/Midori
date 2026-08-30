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

Es gibt eine zweite Ausgabeform. Manche Indikatoren beschreiben keine Zahl je Bar, sondern
einen *Bereich* des Charts: ein Preisband, das an einer Bar beginnt und endet, wenn der Preis
zurückkommt. Die deklarieren `kind: 'zones'` und liefern

```
compute(bars, params) -> { zones: Array<{ top, bottom, startIndex, index, … }> }
```

Serien-Indikatoren lassen `kind` weg — das ist der Normalfall. Der Chart legt für Zonen keine
Serie an, sondern schiebt sie in ein Pane-Primitive.

Vorhanden: SMA, EMA, Bollinger Bands, RSI, ATR, VWAP (täglich/wöchentlich verankert),
Fair Value Gaps und Inverted Fair Value Gaps.

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

Genau dieser Abstand zwingt die Box-Breite dazu, **ab der bestätigenden Bar** zu zählen und
nicht ab der linken Kante. Bei einer FVG liegen beide zwei Bars auseinander und es fällt
nicht auf; bei einer IFVG hätte `Box width = 4` die Box 886 Bars vor dem Bruch enden lassen —
das Rechteck stünde vollständig in der Vergangenheit, bevor das Niveau je galt. Festgehalten
in `test/fvgPrimitive.test.js`.

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

### Zonenfarben

Beide Zonen-Indikatoren tragen zwei Farbparameter (bullisch / bärisch). Gespeichert werden
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
`.icon-btn` — vor jeder neuen Klasse prüfen, ob eine davon passt.

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
