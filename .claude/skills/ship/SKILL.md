---
name: ship
description: Changelog updaten, Version bumpen, offene Änderungen committen und pushen. Nur verwenden, wenn der User es explizit anfordert ("update changelog", "neue version", "release", "/ship").
---

# Ship — Version + Changelog + Commit + Push

Führt den wiederkehrenden Release-Schritt aus. Nur auf explizite Aufforderung des Users ausführen — niemals proaktiv.

Übernommen aus dem `ship`-Skill der Katsumii-App und auf Midorii zugeschnitten: kein Backend, kein Python, Tests laufen über `npm test`.

## Versionsquellen

`version.json` im Root ist die **einzige** manuell gepflegte Version (SemVer, aktuell Prerelease `0.1.N-dev`). Daraus erzeugt `npm run sync:version` alle abgeleiteten Stellen:

- `package.json` und beide Root-Versionen in `package-lock.json`
- `src/generated/version.js` (`APP_VERSION`, gelesen von der Titelleiste und dem Changelog-Fenster)

Diese Dateien **niemals** von Hand editieren. `src/data/changelog.json` ist reiner Präsentationsinhalt und hat bewusst **kein `current`-Feld** — nicht einführen. Details: `docs/versioning-contract.md`.

## Ablauf

1. **Offene Änderungen erfassen** — `git status` und `git diff --stat`. Der User meint mit "alle Änderungen" üblicherweise den gesamten Working Tree, auch Änderungen aus anderen Sessions. Zeige ihm vor dem Commit kurz die Dateiliste, damit er sieht, was enthalten ist.
2. **Änderungen verstehen** — aus dem Diff (und ggf. `git log` seit dem letzten Versions-Commit) ableiten, was sich fachlich geändert hat. Nicht raten: Diff kurz lesen.
3. **Version bumpen** — `version.json` lesen und den Patch um eins erhöhen, das `-dev`-Suffix behalten (`0.1.3-dev` → `0.1.4-dev`). Ist die Version ausnahmsweise stabil (kein `-dev`), ebenfalls den Patch erhöhen und stabil lassen. Danach genau einmal:

   ```powershell
   npm run sync:version
   ```

4. **Changelog schreiben** — neuen Release-Block GANZ OBEN in das `releases`-Array von `src/data/changelog.json` einfügen:
   - `version`: `v` + exakt der Wert aus `version.json` (`"v0.1.4-dev"`). Das Changelog-Fenster markiert genau den Block als *latest*, dessen Nummer `APP_VERSION` entspricht; weicht sie ab, trägt kein Eintrag den Marker und `check:version` schlägt fehl.
   - `date`: Format `"Aug 2026"`
   - `changes[]`: je `type` (`feat` | `fix` | `perf` | `style` | `break`) und `text` — englisch, user-facing formuliert (was der User in der App davon hat, nicht welcher Code sich geändert hat), Stil wie die bestehenden Einträge.
   - Einträge niemals in `ChangelogModal.vue` hardcoden — nur in dieser JSON-Datei.
5. **Gates laufen lassen** — vor dem Commit:

   ```powershell
   npm run check:version
   npm test
   ```

   Beide müssen grün sein. Schlägt etwas fehl: melden und stoppen, nicht committen.
6. **Committen** — EIN Commit für alles, inklusive der generierten Versionsdateien. Message-Format:
   `Feat: <Kurzbeschreibung Hauptänderungen, mit + getrennt> + v0.1.4-dev`
   (Prefix `Fix:`/`Style:`/`Perf:`, wenn keine Features dabei sind.) Commit-Trailer wie üblich anhängen.
7. **Pushen** — `git push` zu origin/main, da der User den Push mit dem Skill-Aufruf angefordert hat. Falls der Aufruf erkennbar nur "changelog updaten" meinte, vor dem Push nachfragen.
8. **Kurz melden** — neue Versionsnummer + eine Zeile, was gepusht wurde. Kein langer Report.

## Randfälle

- Working Tree sauber UND nichts Ungepushtes: „nichts zu shippen" melden, stoppen.
- Committete, aber ungepushte Commits: in den Changelog-Block mit aufnehmen (Commits seit dem letzten Versions-Commit via `git log`) und nur pushen.
- Das Ablegen des `-dev`-Suffixes (erster öffentlicher Stable-Release) macht der User bewusst — nie automatisch aus diesem Skill heraus.
- Marktdaten und Zeichnungen liegen unter `%APPDATA%/project-midori/` und damit ohnehin außerhalb des Repos. `node_modules/`, `dist/` und Logs NICHT committen — im Zweifel `.gitignore` prüfen.
- Untracked Dateien, die nach Arbeitsartefakt aussehen (Scratch-Skripte, `* - Copy.js`, Screenshots), vor dem Commit ausdrücklich beim User nachfragen statt blind mitzunehmen.
- Ändert sich etwas an `electron/`, sollte die App vor dem Commit einmal gestartet worden sein (`start.bat`) — Renderer-Fehler erscheinen im Terminal.
