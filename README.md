# Obsidian Kinopoisk Plugin

Enrich film notes with data from Kinopoisk (description, rating, poster, link).

## Features

- Search Kinopoisk by film title
- **Smart search** — if the note title doesn't exactly match a film, a modal lists the candidate films (name, year, short description); pick the right one
- Auto-fill frontmatter: `kinopoisk` (link), `kp_rating`, `description`, `poster`
- Download posters to local vault directory
- API key rotation (up to 3 keys)
- Cache API responses to avoid re-fetching
- Batch enrichment for all film notes
- Quota checking
- **Graceful error handling** — clear, actionable messages (not just stack traces) when the API is down, the key is missing, or the quota is exhausted

## Installation

1. Copy plugin folder to your Obsidian vault's `.obsidian/plugins/` directory
2. Enable plugin in Obsidian settings

## Settings

- **API Key**: Your Kinopoisk Unofficial API key (required)
- **Secondary/Tertiary API Key**: Optional keys for rotation
- **Poster directory**: Where to save downloaded posters (default: `Films_posters`)
- **Cache directory**: Where to cache API responses (default: `.kinopoisk-cache`)

## Commands

- **Enrich current film note from Kinopoisk** — fill data for the active film note
- **Enrich all film notes from Kinopoisk** — batch enrich all notes with `type: film` (skips already-enriched ones)
- **Check Kinopoisk API quota** — show remaining API quota

## Usage

1. Create a film note with `type: film` in frontmatter
2. Run "Enrich current film note from Kinopoisk"
3. The plugin will search Kinopoisk and fill:
   - `kinopoisk` — link to the Kinopoisk page
   - `kp_rating` — Kinopoisk rating
   - `description` — film description
   - `poster` — local poster image

## Error handling

When something goes wrong you get an actionable notice, e.g.:

- No key configured → points to Settings → Kinopoisk Plugin → API Key
- All keys exhausted (402/403) → rotation continues automatically; final message explains quota
- Network/API failure → checklist: connection, API availability, key validity, retry

## API

Uses Kinopoisk Unofficial API (kinopoiskapiunofficial.tech). Free tier: 500 requests/day.

## License

MIT
