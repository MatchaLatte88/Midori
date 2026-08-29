# Versionsvertrag

Stand: 30. August 2026. Übernommen aus dem Versionsvertrag der Katsumii-App und auf
Midoris Aufbau zugeschnitten (kein Python-Backend, dafür ein Changelog-Gate).

## Kanonische Quelle

`version.json` im Projektwurzelverzeichnis ist die **einzige** von Hand gepflegte
Versionsangabe. Sie folgt SemVer; Entwicklungsstände tragen den Patch als laufende Nummer
und das Prerelease-Suffix `-dev`:

```
0.1.0-dev → 0.1.1-dev → 0.1.2-dev …
```

Eine Zahl, die in vier Dateien von Hand gepflegt wird, ist eine Zahl, die sich früher oder
später selbst widerspricht. Deshalb wird alles Übrige daraus erzeugt.

## Abgeleitete Stellen

`npm run sync:version` schreibt `version.json` in:

- `package.json` (`version`)
- `package-lock.json` (`version` **und** `packages[""].version`)
- `src/generated/version.js` (`APP_VERSION`, gelesen von der Titelleiste und dem
  Changelog-Fenster)

Diese drei Dateien **niemals** von Hand editieren. Der Electron-Hauptprozess liest die
Version über `app.getVersion()`, also ebenfalls aus `package.json` — keine zusätzliche
Kopie.

`src/data/changelog.json` ist reiner Präsentationsinhalt und **keine** Versionsquelle. Es
gibt dort bewusst kein `current`-Feld: Der oberste Eintrag im `releases`-Array trägt die
aktuelle Version, und das Changelog-Fenster markiert genau den Eintrag als *latest*, dessen
Nummer `APP_VERSION` entspricht. Weichen beide ab, trägt kein Eintrag den Marker — und
`check:version` schlägt fehl.

## Synchronisieren und prüfen

Nach jeder Änderung an `version.json` genau einmal:

```powershell
npm run sync:version
npm run check:version
```

`check:version` schreibt nichts, meldet **alle** Abweichungen auf einmal und setzt einen
Exit-Code — geeignet als Gate vor dem Commit und in CI.

Dieselben Prüfungen laufen zusätzlich in `npm test` (`test/version.test.js`), damit ein
nicht synchronisierter Stand auch dann auffällt, wenn jemand den separaten Befehl vergisst.

## Erster öffentlicher Release

Für den ersten stabilen Release wird `version.json` bewusst auf eine Nummer ohne
`-dev`-Suffix gesetzt, synchronisiert und geprüft. Das macht ein Mensch, nie der
`ship`-Skill. Frühere Nummern bleiben Entwicklungshistorie.

SemVer-seitig ist `0.1.0-dev` kleiner als `0.1.0` — ein stabiler Release derselben
Patch-Nummer gilt also korrekt als neuer als sein Entwicklungsvorläufer.
