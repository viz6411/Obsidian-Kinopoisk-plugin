# Obsidian Kinopoisk Plugin

Enrich **film and serial (TV series) notes** with data from Kinopoisk — descriptions, ratings, posters, and links — via the [Kinopoisk Unofficial API](https://kinopoiskapiunofficial.tech).

## Features

- **Search by title** — looks up the active note (or all notes) on Kinopoisk
- **Film and serial (TV series) support** — auto-detects whether a note is a film or a serial, and prefers the matching Kinopoisk entry type (`FILM` vs `TV_SERIES`) when matching by title
- **Smart match** — exact title match is preferred (with the expected type first); on multiple candidates a modal lists name, year and short description so you can pick the right entry
- **Per-type data mapping** — films and serials have **separate** field→property mappings (tabs in settings): you can enrich films and TV series into different properties without affecting each other
- **Configurable note detection** — the plugin decides which notes are films and which are serials by a property + value pair you set for each (default: `type: film` and `type: serial`); no more hardcoded `type: film`
- **Bulk enrichment** — enrich every film note, every serial note, or both at once from the settings page (buttons appear only when detection is configured); already-enriched notes are skipped
- **Local posters** — downloads the poster and stores it locally: `[[Films_posters/<id>.jpg]]` for films, `[[TV_series_posters/<id>.jpg]]` for serials (directories are configurable)
- **Seasons for TV series** — two serial-only fields computed from the `/seasons` endpoint: `seasons` (all seasons except the pilot) and `released_seasons` (only aired seasons, excluding scheduled/upcoming ones and the pilot)
- **API key rotation** — add as many keys as you like; keys are tried in order and rotated automatically on quota exhaustion (402/403)
- **Local API cache** — responses are cached as JSON in the vault, so re-enriching and re-opening notes does not burn quota
- **Quota check** — one-tap notice with used/remaining requests and reset time
- **Update checks** — queries GitHub releases for a newer version (command, settings button, optional silent check on startup)
- **Graceful errors** — actionable notices (missing key, exhausted quota, API down) instead of stack traces

## Installation

1. Copy the plugin folder to your vault's `.obsidian/plugins/` directory
2. Enable the plugin in **Settings → Community plugins**

## Setup

1. **API Keys** — add at least one key from [kinopoiskapiunofficial.tech](https://kinopoiskapiunofficial.tech) (required)
2. **Film note detection** — pick the property and value that mark a note as a film
   - Property name, e.g. `type`
   - Expected value, e.g. `film`
   - Matching is case-insensitive; a note must have the property and its value must equal the expected value
3. **Serial note detection** — same as films, for TV series (default `type` / `serial`)
4. **Data Mapping** — separate tabs for **Films** and **Serials**; type the target property for each API field (type-ahead suggests existing properties), leave empty to disable the field
5. **Behavior** — overwrite existing values, and what to do when a property is missing from the note
6. **Directories** — poster directory for films (default `Films_posters`), poster directory for serials (default `TV_series_posters`), and cache directory (default `.kinopoisk-cache`)

## Settings

| Setting | Description |
| --- | --- |
| **Updates** | Installed version, **Check now** button, "check on startup" toggle |
| **Film note detection** | Property name + expected value that mark a note as a film |
| **Serial note detection** | Property name + expected value that mark a note as a serial/TV series |
| **Actions** | **Enrich all film notes** / **Enrich all serial notes** / **Enrich all film and serial notes** — bulk-enrich the matching notes (buttons are hidden until detection is configured) |
| **Kinopoisk API Keys** | Dynamic list of keys (`+ Add key`, trash icon to remove); keys are rotated on 402/403 |
| **Data Mapping** | Films / Serials tabs; each API field maps to a property you type (type-ahead of existing properties); empty = disabled; per-type **Reset** button. Serials also expose the two seasons fields (`seasons`, `releasedSeasons`) — TV-series only |
| **Overwrite existing properties** | If a property is already filled, overwrite with API data |
| **Missing property behavior** | `Add and fill` or `Do nothing` when the property is absent |
| **Poster directory (films)** | Where film posters are saved (vault-relative, default `Films_posters`) |
| **Poster directory (serials)** | Where serial/TV-series posters are saved (vault-relative, default `TV_series_posters`) |
| **Cache directory** | Where API responses are cached (vault-relative) |

## Commands

- **Enrich current note (film/serial) from Kinopoisk** — fill the active note (auto-detects film vs serial)
- **Enrich all film notes from Kinopoisk** — batch-enrich every film note (skips notes that already have the mapped Kinopoisk URL property)
- **Enrich all serial notes from Kinopoisk** — batch-enrich every serial/TV-series note
- **Enrich all film and serial notes from Kinopoisk** — one pass over both types
- **Check Kinopoisk API quota** — show used/remaining requests
- **Check for plugin updates** — query GitHub releases and notify if a newer version exists

## Usage

1. Make sure your notes carry the detection property/value, e.g.
   ```yaml
   ---
   type: film
   status: false
   rating: 8.7
   ---
   ```
   and for a TV series:
   ```yaml
   ---
   type: serial
   status: false
   rating: 8.7
   ---
   ```
2. Set **Film note detection** (property `type`, value `film`) and **Serial note detection** (property `type`, value `serial`) in the plugin settings
3. Run **Enrich current note** (or an **Enrich all …** button from settings / the command palette)
4. The plugin fills the mapped properties — by default:
   - `kinopoisk` — link to the Kinopoisk page
   - `kp_rating` — Kinopoisk rating
   - `description` — description (multi-line, written as a YAML block scalar)
   - `poster` — `[[Films_posters/<id>.jpg]]` for films, `[[TV_series_posters/<id>.jpg]]` for serials (local embed)
   - For **serials only**, also:
     - `seasons` — total seasons excluding the pilot (number 0)
     - `released_seasons` — aired seasons only (excludes the pilot and upcoming/scheduled seasons)
5. The **Data Mapping** tabs work per note type, so a film can write to one property while a serial writes to another (e.g. films → `description`, serials → `synopsis`)

## Error handling

You get an actionable notice, not a stack trace:

- No key configured → points to Settings → Kinopoisk Plugin → API Keys
- All keys exhausted (402/403) → rotation continues automatically; the final message explains quota
- Network/API failure → checklist: connection, API availability, key validity, retry

## API

Uses the Kinopoisk Unofficial API (kinopoiskapiunofficial.tech). Free tier: 500 requests/day.

## License

MIT
