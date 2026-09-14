# Obsidian Kinopoisk Plugin

Enrich film notes with data from Kinopoisk (description, rating, poster, link).

## Features

- Search Kinopoisk by film title
- Auto-fill frontmatter: `kinopoisk` (link), `kp_rating`, `description`, `poster`
- Download posters to local vault directory
- API key rotation (up to 3 keys)
- Cache API responses to avoid re-fetching
- Batch enrichment for all film notes
- Quota checking

## Installation

1. Copy plugin folder to your Obsidian vault's `.obsidian/plugins/` directory
2. Enable plugin in Obsidian settings

## Settings

- **API Key**: Your Kinopoisk Unofficial API key (required)
- **Secondary/Tertiary API Key**: Optional keys for rotation
- **Poster directory**: Where to save downloaded posters (default: `Films_posters`)
- **Cache directory**: Where to cache API responses (default: `.kinopoisk-cache`)

## Commands

- **Enrich current film note from Kinopoisk** - Fill data for the active film note
- **Enrich all film notes from Kinopoisk** - Batch enrich all notes with `type: film`
- **Check Kinopoisk API quota** - Check remaining API quota

## Usage

1. Create a film note with `type: film` in frontmatter
2. Run "Enrich current film note from Kinopoisk"
3. The plugin will search Kinopoisk and fill:
   - `kinopoisk` - Link to Kinopoisk page
   - `kp_rating` - Kinopoisk rating
   - `description` - Film description
   - `poster` - Local poster image

## API

Uses Kinopoisk Unofficial API (kinopoiskapiunofficial.tech). Free tier: 500 requests/day.

## License

MIT
