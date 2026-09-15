# Obsidian Kinopoisk Plugin

Enrich film notes with data from Kinopoisk — descriptions, ratings, posters, and links — via the [Kinopoisk Unofficial API](https://kinopoiskapiunofficial.tech).

## Features

- **Search by title** — looks up the active note (or all notes) on Kinopoisk
- **Smart match** — exact title match is preferred; on multiple candidates a modal lists name, year and short description so you can pick the right film
- **Flexible field mapping** — map any API field (`webUrl`, `nameRu`, `nameEn`, `year`, `filmLength`, `ratingKinopoisk`, `ratingImdb`, `ratingFilmCritics`, `ratingMpaa`, `description`, `shortDescription`, `slogan`, `countries`, `genres`, `posterUrl`, …) to any note property, with type-ahead suggestions of existing properties
- **Configurable film-note detection** — the plugin decides which notes are films by a property + value pair you set (default: `type: film`); no more hardcoded `type: film`
- **Bulk enrichment** — enrich every film note from the settings page (button appears only when detection is configured); already-enriched notes are skipped
- **Local posters** — downloads the poster and stores `[[Films_posters/<id>.jpg]]` in the note
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
3. **Data Mapping** — for each API field, toggle it on and choose the target property (type-ahead suggests existing properties)
4. **Behavior** — overwrite existing values, and what to do when a property is missing from the note
5. **Directories** — poster directory (default `Films_posters`) and cache directory (default `.kinopoisk-cache`)

## Settings

| Setting | Description |
| --- | --- |
| **Updates** | Installed version, **Check now** button, "check on startup" toggle |
| **Film note detection** | Property name + expected value that mark a note as a film |
| **Actions** | **Enrich all film notes** — bulk-enrich every matching note (button is hidden until detection is configured) |
| **Kinopoisk API Keys** | Dynamic list of keys (`+ Add key`, trash icon to remove); keys are rotated on 402/403 |
| **Data Mapping** | Per-field toggles + target property (type-ahead of existing properties) |
| **Overwrite existing properties** | If a property is already filled, overwrite with API data |
| **Missing property behavior** | `Add and fill` or `Do nothing` when the property is absent |
| **Poster directory** | Where posters are saved (vault-relative) |
| **Cache directory** | Where API responses are cached (vault-relative) |

## Commands

- **Enrich current film note from Kinopoisk** — fill the active note
- **Enrich all film notes from Kinopoisk** — batch-enrich every film note (skips notes that already have the mapped Kinopoisk URL property)
- **Check Kinopoisk API quota** — show used/remaining requests
- **Check for plugin updates** — query GitHub releases and notify if a newer version exists

## Usage

1. Make sure your film notes carry the detection property/value, e.g.
   ```yaml
   ---
   type: film
   status: false
   rating: 8.7
   ---
   ```
2. Set **Film note detection** in the plugin settings (property `type`, value `film`)
3. Run **Enrich current film note** (or **Enrich all** from settings / command palette)
4. The plugin fills the mapped properties — by default:
   - `kinopoisk` — link to the Kinopoisk page
   - `kp_rating` — Kinopoisk rating
   - `description` — film description (multi-line, written as a YAML block scalar)
   - `poster` — `[[Films_posters/<id>.jpg]]` local embed

## Error handling

You get an actionable notice, not a stack trace:

- No key configured → points to Settings → Kinopoisk Plugin → API Keys
- All keys exhausted (402/403) → rotation continues automatically; the final message explains quota
- Network/API failure → checklist: connection, API availability, key validity, retry

## API

Uses the Kinopoisk Unofficial API (kinopoiskapiunofficial.tech). Free tier: 500 requests/day.

## License

MIT
