# Time Tracker

IntelliJ-IDEA-Plugin und Webserver zur automatischen Erfassung und Verwaltung von
Entwicklungszeit nach Projekt und Git-Branch.

## IntelliJ-Plugin

Das Plugin erfasst Zeit, solange das Projektfenster fokussiert ist. Nach zwei Minuten ohne
Tastatur- oder Mausaktivität wird dieselbe Session pausiert; die zwei Minuten bis zum Timeout
bleiben Arbeitszeit. Synchronisationen verändern eine pausierte Session nicht. Ein
Branchwechsel oder das Schließen der IDE beendet die Session.

Die Statusleiste zeigt die aktuelle Sessionzeit und den Synchronisationsstatus. Ein Toolwindow
gibt es nicht. Zeichen und nichtleere Zeilen werden nur nach physischen Tastatureingaben im
aktuell ausgewählten Editor gezählt. Änderungen durch Checkout, Merge oder Dateireload zählen
nicht.

Serveradresse und API-Schlüssel werden unter
**Settings | Tools | Time Tracker** eingerichtet.

```powershell
.\gradlew.bat buildPlugin
```

Das installierbare Archiv liegt anschließend unter `build/distributions`.

### Automatische Plugin-Updates über GitHub Releases

Das Plugin registriert beim Start den nativen IntelliJ-Updatefeed
`https://github.com/cjaaayy/time-tracker/releases/latest/download/updatePlugins.xml`.
IntelliJ prüft diesen Feed zusammen mit den übrigen Pluginquellen und bietet kompatible neue
Versionen über den normalen Plugin-Updater an.

Für eine Veröffentlichung:

1. Das GitHub-Repository als **`cjaaayy/time-tracker`** anlegen und dieses Projekt dorthin
   pushen. Falls Besitzer oder Repositoryname abweichen, müssen der Feed in
   `TimeTrackerUpdateRepository.kt` und der Standardwert `githubRepository` in
   `build.gradle.kts` angepasst werden.
2. Die Version in `build.gradle.kts` erhöhen, zum Beispiel auf `0.2.0`, committen und pushen.
3. Einen zur Version passenden Tag pushen:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

Der Workflow `.github/workflows/release-plugin.yml` prüft, dass Tag und Pluginversion
übereinstimmen, baut und verifiziert das Plugin und erstellt anschließend ein GitHub Release
mit Plugin-ZIP, SHA-256-Prüfsumme und `updatePlugins.xml`. Das Repository muss öffentlich
sein, damit IntelliJ den Feed ohne GitHub-Anmeldedaten abrufen kann.

## Production-Server mit MySQL

Der Server verwendet MySQL 8.4 und Node.js. Für den empfohlenen Docker-Betrieb:

```bash
cd server
cp .env.example .env
# Sichere, unterschiedliche Passwörter in .env eintragen
docker compose up -d --build
```

Statusprüfung:

```bash
curl http://localhost:8080/healthz
```

Beim ersten Start wird das MySQL-Schema automatisch angelegt. Falls im konfigurierten
`TIME_TRACKER_DATA_DIR` noch JSON-Daten der alten Version liegen und die Datenbank leer ist,
werden diese einmalig nach MySQL übernommen.

### Erforderliche Umgebungsvariablen

- `MYSQL_HOST`
- `MYSQL_PORT` (Standard `3306`)
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_POOL_SIZE` (Standard `10`)
- `MYSQL_SSL=true` bei einer externen MySQL-Verbindung mit TLS
- `TIME_TRACKER_HOST` und `TIME_TRACKER_PORT`
- `TIME_TRACKER_SECURE_COOKIES=true` hinter einem HTTPS-Reverse-Proxy

Die Anwendung läuft im Container als unprivilegierter Benutzer, verwendet einen
MySQL-Connection-Pool, legt Tabellen mit InnoDB/utf8mb4 an, bietet einen Healthcheck und
beendet HTTP-Server sowie Datenbankverbindungen bei SIGTERM/SIGINT kontrolliert.

Für öffentlichen Betrieb muss TLS über einen Reverse Proxy wie Caddy oder nginx aktiviert
und `TIME_TRACKER_SECURE_COOKIES=true` gesetzt werden. Datenbank und `.env` dürfen nicht
öffentlich erreichbar oder in die Versionsverwaltung eingecheckt werden.

## Funktionen des Webinterfaces

- Registrierung, Freigabe, Deaktivierung und vollständige Löschung von Konten
- Rollen mit einzeln konfigurierbaren Berechtigungen
- Wochen-, Monats- und Kalenderauswertungen
- Teamübersicht und anonymisierte globale Statistik
- Projekt-/Branch-Ausschlüsse mit nachvollziehbarem Abschlusszeitpunkt
- Zulagen mit konfigurierbarem Stundensatz und Auszahlungshistorie
- API-Schlüssel ausschließlich für bestätigte, aktive Benutzer
