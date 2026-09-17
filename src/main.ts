import {
  AbstractInputSuggest,
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  parseYaml,
  requestUrl,
} from "obsidian";

// --- API types ---

interface FilmInfo {
  filmId: string;
  nameRu: string;
  nameEn: string;
  year: number;
  type: string;
  description: string;
  shortDescription: string;
  slogan: string;
  filmLength: string;
  posterUrl: string;
  webUrl: string;
  ratingKinopoisk: string;
  ratingVoteCount: string;
  ratingImdb: string;
  ratingFilmCritics: string;
  ratingMpaa: string;
  countries: string[];
  genres: string[];
}

// The full film-detail payload (a superset of the search result). The extra
// index signature lets us read it by a configurable field id without an `any`.
interface FilmDetail extends FilmInfo {
  [key: string]: unknown;
}

interface SearchResult {
  pagesCount: number;
  searchFilmsCountResult: number;
  films: FilmInfo[];
}

interface QuotaInfo {
  limit: number;
  quota: number;
  requestCount: number;
  resetDateTime: string;
}

// --- Seasons (TV series) types ---
// A single episode. Only `releaseDate` matters: a season counts as "released"
// when at least one of its episodes has a non-empty release date.
interface EpisodeInfo {
  releaseDate: string;
}

interface SeasonInfo {
  number: number;
  episodes: EpisodeInfo[];
}

interface SeasonsResponse {
  total: number;
  items: SeasonInfo[];
}

interface GitHubReleaseInfo {
  tag_name: string;
  id: number;
}

// --- Note types ---

type NoteType = "film" | "serial";

// --- Field mapping ---

interface ApiFieldDef {
  id: string;
  label: string;
}

const API_FIELDS: ApiFieldDef[] = [
  { id: "webUrl", label: "Kinopoisk URL" },
  { id: "nameRu", label: "Name (RU)" },
  { id: "nameEn", label: "Name (EN)" },
  { id: "year", label: "Year" },
  { id: "type", label: "Type" },
  { id: "filmLength", label: "Duration" },
  { id: "ratingKinopoisk", label: "Rating (Kinopoisk)" },
  { id: "ratingVoteCount", label: "Votes count" },
  { id: "ratingImdb", label: "Rating (IMDb)" },
  { id: "ratingFilmCritics", label: "Rating (Film critics)" },
  { id: "ratingMpaa", label: "Age rating (MPAA)" },
  { id: "description", label: "Description" },
  { id: "shortDescription", label: "Short description" },
  { id: "slogan", label: "Slogan" },
  { id: "countries", label: "Countries" },
  { id: "genres", label: "Genres" },
  { id: "posterUrl", label: "Poster" },
  // TV-series only (computed from the /seasons endpoint).
  { id: "seasons", label: "Seasons (total, no pilot)" },
  { id: "releasedSeasons", label: "Released seasons" },
];

interface KinopoiskPluginSettings {
  apiKeys: string[];
  posterDir: string;
  serialPosterDir: string;
  cacheDir: string;
  autoCache: boolean;
  // Legacy shared mapping (pre-0.7). Migrated into filmMapping/serialMapping
  // on load; kept here only so old data.json files still parse.
  mapping: Record<string, string>;
  filmMapping: Record<string, string>;
  serialMapping: Record<string, string>;
  overwriteExisting: boolean;
  missingProperty: "add" | "ignore";
  checkUpdatesOnStartup: boolean;
  filmNoteProperty: string;
  filmNoteValue: string;
  serialNoteProperty: string;
  serialNoteValue: string;
  // One-time flag: the 0.8.0 seasons-field migration has already run for this
  // install, so a seasons field the user later disabled is not revived on load.
  seasonsFieldsMigrated: boolean;
}

const DEFAULT_SETTINGS: KinopoiskPluginSettings = {
  apiKeys: [],
  posterDir: "Films_posters",
  serialPosterDir: "TV_series_posters",
  cacheDir: ".kinopoisk-cache",
  autoCache: true,
  mapping: {},
  filmMapping: {
    webUrl: "kinopoisk",
    ratingKinopoisk: "kp_rating",
    description: "description",
    posterUrl: "poster",
  },
  serialMapping: {
    webUrl: "kinopoisk",
    ratingKinopoisk: "kp_rating",
    description: "description",
    posterUrl: "poster",
    seasons: "seasons",
    releasedSeasons: "released_seasons",
  },
  overwriteExisting: true,
  missingProperty: "add",
  checkUpdatesOnStartup: true,
  filmNoteProperty: "type",
  filmNoteValue: "film",
  serialNoteProperty: "type",
  serialNoteValue: "serial",
  seasonsFieldsMigrated: false,
};

// --- Update check ---

const PLUGIN_REPO = "viz6411/Obsidian-Kinopoisk-plugin";

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// --- Cache helpers ---

async function getCache(
  settings: KinopoiskPluginSettings,
  app: App,
  key: string
): Promise<unknown> {
  const cachePath = `${settings.cacheDir}/${key}.json`;
  try {
    if (await app.vault.adapter.exists(cachePath)) {
      const content = await app.vault.adapter.read(cachePath);
      return JSON.parse(content);
    }
  } catch (e) {
    // cache miss is ok
  }
  return null;
}

async function setCache(
  settings: KinopoiskPluginSettings,
  app: App,
  key: string,
  data: unknown
): Promise<void> {
  try {
    const cachePath = `${settings.cacheDir}/${key}.json`;
    const dir = settings.cacheDir;
    if (!(await app.vault.adapter.exists(dir + "/"))) {
      try {
        await app.vault.adapter.mkdir(dir);
      } catch (e) {
        // dir may already exist
      }
    }
    await app.vault.adapter.write(cachePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Cache write error:", e);
  }
}

// --- API helper with graceful error handling ---

// Returns `unknown` so the API body is never treated as `any`; each caller
// narrows it to the concrete shape it expects.
async function kinopoiskRequest(
  settings: KinopoiskPluginSettings,
  endpoint: string
): Promise<unknown> {
  const keys = settings.apiKeys.map((k) => k.trim()).filter((k) => k !== "");

  if (keys.length === 0) {
    throw new Error(
      "No Kinopoisk API key configured. Please add one in plugin settings (Settings → Kinopoisk Plugin → API Keys)."
    );
  }

  let lastError: Error | null = null;

  for (const key of keys) {
    try {
      const response = await requestUrl({
        url: `https://kinopoiskapiunofficial.tech${endpoint}`,
        method: "GET",
        headers: { "X-API-KEY": key },
        throw: false,
      });

      if (response.status === 402 || response.status === 403) {
        console.warn(
          `Kinopoisk quota exhausted for key ${key.slice(0, 4)}...`
        );
        continue;
      }

      if (response.status >= 400) {
        throw new Error(`API error: ${response.status} ${endpoint}`);
      }

      // `response.json` is `any` per the Obsidian API; downcast to `unknown`.
      return response.json as unknown;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(
        `Kinopoisk request failed with key ${key.slice(0, 4)}...`,
        lastError.message
      );
    }
  }

  const errorMessage = lastError ? lastError.message : "Unknown error";
  const instructions =
    "Please check:\n" +
    "1. Your internet connection\n" +
    "2. That the Kinopoisk API is available (kinopoiskapiunofficial.tech)\n" +
    "3. That your API key is valid and has remaining quota\n" +
    "4. Try again in a few minutes";

  console.error("Kinopoisk API request failed:", errorMessage);
  throw new Error(
    `Failed to connect to Kinopoisk API: ${errorMessage}\n\n${instructions}`
  );
}

// --- Frontmatter helpers ---

interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseNote(content: string): ParsedNote {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    let frontmatter: Record<string, unknown> = {};
    try {
      frontmatter = (parseYaml(match[1]) as Record<string, unknown>) || {};
    } catch (e) {
      console.warn("Failed to parse frontmatter YAML:", e);
    }
    return { frontmatter, body: match[2] };
  }
  return { frontmatter: {}, body: content };
}

function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    // Preserve empty properties (e.g. "rating:") instead of dropping them.
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
      continue;
    }
    const str = String(value);
    // Multi-line values (e.g. a description with paragraphs) are written as a
    // YAML literal block scalar — the exact format Obsidian writes when you
    // press Shift+Enter in the properties panel:
    //   description: |-
    //     line one
    //
    //     line two
    // Obsidian's frontmatter parser renders a multi-line double-quoted value
    // as red/broken, so real newlines must never live inside a quoted scalar.
    if (str.includes("\n")) {
      const trimmed = str.replace(/\n+$/, "");
      lines.push(`${key}: |-`);
      for (const line of trimmed.split("\n")) {
        lines.push(line === "" ? "" : `  ${line}`);
      }
      continue;
    }
    if (
      str === "" ||
      str.includes(":") ||
      str.includes("#") ||
      str.startsWith(" ") ||
      str.startsWith('"')
    ) {
      const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`${key}: "${escaped}"`);
    } else {
      lines.push(`${key}: ${str}`);
    }
  }
  return lines.join("\n");
}

function rebuildNote(
  original: string,
  updates: Record<string, string>
): string {
  const { frontmatter, body } = parseNote(original);
  const merged: Record<string, unknown> = { ...frontmatter, ...updates };
  const fmStr = serializeFrontmatter(merged);
  return `---\n${fmStr}\n---\n${body}`;
}

// --- Film Selection Modal ---

class FilmSelectionModal extends Modal {
  films: FilmInfo[];
  onSelect: (film: FilmInfo) => void;
  title: string;

  constructor(
    app: App,
    films: FilmInfo[],
    onSelect: (film: FilmInfo) => void,
    title: string
  ) {
    super(app);
    this.films = films;
    this.onSelect = onSelect;
    this.title = title;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });

    this.films.forEach((film) => {
      // Layout is driven by CSS classes (added below in <style>); only the
      // per-item box model is set here, via the sanctioned setCssStyles.
      const item = contentEl.createEl("div", {
        cls: "kinopoisk-film-selection-item",
      });
      item.setCssStyles({
        margin: "10px 0",
        padding: "10px",
        border: "1px solid var(--background-modifier-border)",
        borderRadius: "6px",
        cursor: "pointer",
      });

      const title = item.createEl("div", {
        cls: "kinopoisk-film-selection-title",
        text: `${film.nameRu} (${film.year})`,
      });
      title.setCssStyles({ fontWeight: "600", marginBottom: "5px" });

      if (film.description) {
        const desc = item.createEl("div", {
          cls: "kinopoisk-film-selection-desc",
          text: film.description,
        });
        desc.setCssStyles({
          fontSize: "14px",
          color: "var(--text-muted)",
          maxHeight: "60px",
          overflow: "hidden",
        });
      }

      item.onclick = () => {
        this.onSelect(film);
        this.close();
      };
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// --- Property name suggest (type-ahead + free text) ---

class PropertySuggest extends AbstractInputSuggest<string> {
  private props: string[];

  constructor(app: App, inputEl: HTMLInputElement, props: string[]) {
    super(app, inputEl);
    this.props = props;
  }

  setProps(props: string[]): void {
    this.props = props;
  }

  getSuggestions(query: string): string[] {
    if (!query || query.trim() === "") return this.props;
    const q = query.trim().toLowerCase();
    return this.props.filter((p) => p.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent): void {
    this.setValue(value);
  }
}

// --- Plugin ---

export default class KinopoiskPlugin extends Plugin {
  settings: KinopoiskPluginSettings;

  async onload(): Promise<void> {
    const rawData: Record<string, unknown> =
      (await this.loadData()) || {};

    // Migrate old settings format (apiKey/apiKey2/apiKey3) to new (apiKeys[])
    const oldKeys: string[] = [rawData.apiKey, rawData.apiKey2, rawData.apiKey3]
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k !== "");
    delete rawData.apiKey;
    delete rawData.apiKey2;
    delete rawData.apiKey3;

    // Migrate settings that only knew films: serial detection gets its own
    // pair of fields, defaulting to type/serial when absent.
    if (typeof rawData.serialNoteProperty !== "string") {
      rawData.serialNoteProperty = "type";
    }
    if (typeof rawData.serialNoteValue !== "string") {
      rawData.serialNoteValue = "serial";
    }

    // Migrate the legacy shared mapping into per-type mappings (0.7.0).
    // Films keep the old mapping; serials start from the same defaults so an
    // upgrade does not silently change serial enrichment behavior.
    if (typeof rawData.filmMapping !== "object" || rawData.filmMapping === null) {
      const legacy =
        rawData.mapping && typeof rawData.mapping === "object"
          ? (rawData.mapping as Record<string, string>)
          : {};
      rawData.filmMapping = legacy;
    }
    if (
      typeof rawData.serialMapping !== "object" ||
      rawData.serialMapping === null
    ) {
      const legacy =
        rawData.mapping && typeof rawData.mapping === "object"
          ? (rawData.mapping as Record<string, string>)
          : {};
      rawData.serialMapping = { ...DEFAULT_SETTINGS.filmMapping, ...legacy };
    }
    delete rawData.mapping;

    if (typeof rawData.serialPosterDir !== "string") {
      rawData.serialPosterDir = "TV_series_posters";
    }

    // 0.8.0 migration: make the two TV-series-only seasons fields available in
    // the serial mapping. Add them only when the user has never configured
    // them (no key present) so a user who intentionally disabled a field is
    // not reverted on next load. Idempotent once the flag is set.
    if (!rawData.seasonsFieldsMigrated) {
      const sm = rawData.serialMapping as Record<string, string> | null | undefined;
      if (sm && !("seasons" in sm) && !("releasedSeasons" in sm)) {
        sm.seasons = "seasons";
        sm.releasedSeasons = "released_seasons";
      }
      rawData.seasonsFieldsMigrated = true;
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData);

    if (this.settings.apiKeys.length === 0 && oldKeys.length > 0) {
      this.settings.apiKeys = oldKeys;
    }
    await this.saveData(this.settings);

    this.addSettingTab(new KinopoiskSettingsTab(this.app, this));

    // Command: check for updates
    this.addCommand({
      id: "kinopoisk-check-updates",
      name: "Check for plugin updates",
      callback: async () => {
        await this.checkForUpdates(true);
      },
    });

    if (this.settings.checkUpdatesOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        // Fire-and-forget background check; swallow rejections.
        this.checkForUpdates(false).catch((e) => {
          console.warn("Startup update check failed:", e);
        });
      });
    }

    // Command: enrich current file (auto-detects film vs serial)
    this.addCommand({
      id: "kinopoisk-enrich-current",
      name: "Enrich current note (film/serial) from Kinopoisk",
      callback: async () => {
        await this.enrichCurrentFile();
      },
    });

    // Commands: enrich all film notes / serial notes / both
    this.addCommand({
      id: "kinopoisk-enrich-all-films",
      name: "Enrich all film notes from Kinopoisk",
      callback: async () => {
        await this.enrichAllNotes("film");
      },
    });
    this.addCommand({
      id: "kinopoisk-enrich-all-serials",
      name: "Enrich all serial notes from Kinopoisk",
      callback: async () => {
        await this.enrichAllNotes("serial");
      },
    });
    this.addCommand({
      id: "kinopoisk-enrich-all",
      name: "Enrich all film and serial notes from Kinopoisk",
      callback: async () => {
        await this.enrichAllNotes("all");
      },
    });

    // Command: check quota
    this.addCommand({
      id: "kinopoisk-check-quota",
      name: "Check Kinopoisk API quota",
      callback: async () => {
        await this.checkQuota();
      },
    });
  }

  onunload(): void {
    // Cleanup
  }

  // --- Update check ---

  async checkForUpdates(showResult: boolean): Promise<void> {
    const current = this.manifest.version;
    try {
      const response = await requestUrl({
        url: `https://api.github.com/repos/${PLUGIN_REPO}/releases/latest`,
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub API HTTP ${response.status}`);
      }
      const release = response.json as GitHubReleaseInfo;
      const latest = String(release.tag_name || "").replace(/^v/, "");
      if (!latest) {
        throw new Error("No release tag found");
      }
      if (compareVersions(latest, current) > 0) {
        new Notice(
          ` Update available: v${latest} (you have v${current}). Get it from ${PLUGIN_REPO}/releases.`,
          15000
        );
      } else if (showResult) {
        new Notice(`✅ You are on the latest version (v${current}).`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (showResult) {
        new Notice(`⚠️ Could not check for updates: ${message}`, 8000);
      } else {
        console.warn("Update check failed:", message);
      }
    }
  }

  // --- Note type detection (configurable per type) ---

  private matchesNote(
    frontmatter: Record<string, unknown>,
    prop: string,
    value: string
  ): boolean {
    const p = (prop || "").trim();
    if (p === "") return false;
    if (!(p in frontmatter)) return false;
    const actual = frontmatter[p];
    return String(actual).toLowerCase() === (value || "").trim().toLowerCase();
  }

  isFilmNote(frontmatter: Record<string, unknown>): boolean {
    return this.matchesNote(
      frontmatter,
      this.settings.filmNoteProperty,
      this.settings.filmNoteValue
    );
  }

  isSerialNote(frontmatter: Record<string, unknown>): boolean {
    return this.matchesNote(
      frontmatter,
      this.settings.serialNoteProperty,
      this.settings.serialNoteValue
    );
  }

  detectNoteType(frontmatter: Record<string, unknown>): NoteType | null {
    if (this.isFilmNote(frontmatter)) return "film";
    if (this.isSerialNote(frontmatter)) return "serial";
    return null;
  }

  private preferApiType(t: NoteType): string {
    return t === "serial" ? "TV_SERIES" : "FILM";
  }

  // --- Per-type settings accessors (films vs serials) ---

  /** Field→property mapping that applies to a note of the given type. */
  private mappingForType(t: NoteType): Record<string, string> {
    return t === "serial"
      ? this.settings.serialMapping
      : this.settings.filmMapping;
  }

  /** Poster directory that applies to a note of the given type. */
  private posterDirForType(t: NoteType): string {
    return t === "serial"
      ? this.settings.serialPosterDir
      : this.settings.posterDir;
  }

  // --- Enrich current file (auto-detects film vs serial) ---

  async enrichCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file. Open a film or serial note first.");
      return;
    }

    const content = await this.app.vault.read(file);
    const { frontmatter } = parseNote(content);
    const noteType = this.detectNoteType(frontmatter);

    if (!noteType) {
      new Notice(
        `This is not a film or serial note (expected "${this.settings.filmNoteProperty}" == "${this.settings.filmNoteValue}" or "${this.settings.serialNoteProperty}" == "${this.settings.serialNoteValue}").`
      );
      return;
    }

    const filmName = file.basename;
    new Notice(
      `Detected ${noteType} note. Searching Kinopoisk for "${filmName}"...`
    );

    try {
      const searchResult = (await this.searchFilms(filmName)) as SearchResult;

      if (!searchResult.films || searchResult.films.length === 0) {
        new Notice(`No entries found for "${filmName}".`);
        return;
      }

      const prefer = this.preferApiType(noteType);
      const lower = filmName.toLowerCase();
      // Exact name match, preferring the expected API type (TV_SERIES / FILM).
      let bestFilm = searchResult.films.find(
        (f) => f.nameRu.toLowerCase() === lower && f.type === prefer
      );
      if (!bestFilm) {
        bestFilm = searchResult.films.find(
          (f) => f.nameRu.toLowerCase() === lower
        );
      }

      if (!bestFilm && searchResult.films.length > 1) {
        const label = noteType === "serial" ? "serial" : "film";
        const modal = new FilmSelectionModal(
          this.app,
          searchResult.films,
          (film) => {
            // Handle rejections so the promise is not left floating.
            this.processFilmSelection(film, file, filmName, noteType).catch(
              (e) => {
                console.error("Kinopoisk enrichment error:", e);
              }
            );
          },
          `Select a ${label}`
        );
        modal.open();
        return;
      }

      if (!bestFilm) bestFilm = searchResult.films[0];
      await this.processFilmSelection(bestFilm, file, filmName, noteType);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(`❌ ${message}`, 10000);
      console.error("Kinopoisk enrichment error:", e);
    }
  }

  // --- Seasons (TV series) ---

  // Fetch the seasons payload for a TV series (cached). Returns null when the
  // series has no seasons data (e.g. a plain film) so callers can skip.
  async fetchSeasons(filmId: string): Promise<SeasonsResponse | null> {
    const cached = (await getCache(this.settings, this.app, `seasons-${filmId}`)) as
      | SeasonsResponse
      | null;
    if (cached) return cached;
    let data: SeasonsResponse;
    try {
      data = (await kinopoiskRequest(
        this.settings,
        `/api/v2.2/films/${filmId}/seasons`
      )) as SeasonsResponse;
    } catch (e) {
      console.warn(`Seasons endpoint unavailable for ${filmId}:`, e);
      return null;
    }
    if (!data || !Array.isArray(data.items)) return null;
    await setCache(this.settings, this.app, `seasons-${filmId}`, data);
    return data;
  }

  // Compute the two season counts per the user's definitions:
  //   seasons            = all seasons except the pilot (number 0)
  //   releasedSeasons    = seasons (except the pilot) that already aired,
  //                        i.e. have at least one episode with a release date.
  // Upcoming/scheduled seasons carry no release dates and are excluded.
  static computeSeasonCounts(resp: SeasonsResponse): {
    seasons: number;
    releasedSeasons: number;
  } {
    let seasons = 0;
    let releasedSeasons = 0;
    for (const s of resp.items) {
      if (s.number === 0) continue; // skip the pilot
      seasons++;
      const released = (s.episodes || []).some(
        (e) => (e.releaseDate || "").trim() !== ""
      );
      if (released) releasedSeasons++;
    }
    return { seasons, releasedSeasons };
  }

  // --- Search films/series ---

  async searchFilms(keyword: string): Promise<unknown> {
    const endpoint = `/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(
      keyword
    )}&page=1`;
    return kinopoiskRequest(this.settings, endpoint);
  }

  // --- Process film/series selection ---

  async processFilmSelection(
    film: FilmInfo,
    file: TFile,
    filmName: string,
    noteType: NoteType
  ): Promise<void> {
    try {
      new Notice(
        `Processing: "${film.nameRu}" (${film.year}). Getting details...`
      );

      let detail: FilmDetail = (await getCache(
        this.settings,
        this.app,
        `film-${film.filmId}`
      )) as FilmDetail;

      if (!detail) {
        detail = (await kinopoiskRequest(
          this.settings,
          `/api/v2.2/films/${film.filmId}`
        )) as FilmDetail;
        await setCache(this.settings, this.app, `film-${film.filmId}`, detail);
      }

      const original = await this.app.vault.read(file);
      const { frontmatter } = parseNote(original);

      const updates: Record<string, string> = {};
      const mapping = this.mappingForType(noteType);

      // TV-series only: fetch season data once and expose it as two computed
      // fields (seasons / releasedSeasons) to the mapping loop below.
      let seasonCounts: { seasons: number; releasedSeasons: number } | null =
        null;
      if (
        noteType === "serial" &&
        (mapping["seasons"] || mapping["releasedSeasons"])
      ) {
        const resp = await this.fetchSeasons(film.filmId);
        if (resp) seasonCounts = KinopoiskPlugin.computeSeasonCounts(resp);
      }

      for (const [fieldId, propName] of Object.entries(mapping)) {
        if (!propName || propName.trim() === "") continue;

        // Resolve the value: seasons fields come from the computed counts,
        // everything else from the film-detail payload.
        let val: unknown;
        if (fieldId === "seasons" || fieldId === "releasedSeasons") {
          if (!seasonCounts) continue; // no seasons data (or film note)
          val =
            fieldId === "seasons"
              ? seasonCounts.seasons
              : seasonCounts.releasedSeasons;
        } else {
          val = detail[fieldId];
        }
        if (val === null || val === undefined || val === "") continue;

        // Check existing property
        if (propName in frontmatter) {
          if (!this.settings.overwriteExisting) continue; // keep existing
        } else {
          // Property missing in note
          if (this.settings.missingProperty === "ignore") continue;
        }

        if (fieldId === "posterUrl" && typeof val === "string") {
          const posterDir = this.posterDirForType(noteType);
          const posterPath = `${posterDir}/${film.filmId}.jpg`;
          const ok = await this.downloadPoster(val, posterPath);
          if (ok) {
            updates[propName] = `[[${posterPath}]]`;
          } else {
            console.warn(`Poster download failed for film ${film.filmId}`);
          }
        } else {
          updates[propName] = String(val);
        }
      }

      if (Object.keys(updates).length > 0) {
        const newContent = rebuildNote(original, updates);
        await this.app.vault.process(file, () => newContent);
      }

      new Notice(`✅ Updated "${filmName}" with Kinopoisk data.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(`❌ ${message}`, 10000);
      console.error("Film selection processing error:", e);
    }
  }

  // --- Enrich all notes of a given type (or both) ---

  /** Property used to mark a note as already enriched (mapped webUrl, fallback "kinopoisk"). */
  private enrichedMarkerProperty(t: NoteType): string {
    const mapped = (this.mappingForType(t)["webUrl"] || "").trim();
    return mapped !== "" ? mapped : "kinopoisk";
  }

  async enrichAllNotes(kind: "film" | "serial" | "all"): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();

    if (files.length === 0) {
      new Notice("No markdown files found.");
      return;
    }

    const targets: { file: TFile; type: NoteType }[] = [];
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);
        let t: NoteType | null = null;
        if (kind === "all") {
          t = this.detectNoteType(frontmatter);
        } else if (kind === "film") {
          t = this.isFilmNote(frontmatter) ? "film" : null;
        } else {
          t = this.isSerialNote(frontmatter) ? "serial" : null;
        }
        if (t) targets.push({ file, type: t });
      } catch (e) {
        // skip unreadable files
      }
    }

    if (targets.length === 0) {
      new Notice(
        `No notes found matching ${kind === "all" ? "film or serial" : kind} detection.`
      );
      return;
    }

    new Notice(
      `Found ${targets.length} ${kind === "all" ? "film/serial" : kind} note(s). Starting enrichment...`
    );

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const { file, type } of targets) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);

        if (frontmatter[this.enrichedMarkerProperty(type)]) {
          skipped++;
          continue;
        }

        const filmName = file.basename;
        const searchResult = (await this.searchFilms(filmName)) as SearchResult;

        if (!searchResult.films || searchResult.films.length === 0) {
          failed++;
          continue;
        }

        const prefer = this.preferApiType(type);
        const lower = filmName.toLowerCase();
        const bestFilm =
          searchResult.films.find(
            (f) => f.nameRu.toLowerCase() === lower && f.type === prefer
          ) ||
          searchResult.films.find((f) => f.nameRu.toLowerCase() === lower) ||
          searchResult.films[0];

        await this.processFilmSelection(bestFilm, file, filmName, type);
        success++;

        // Popout-window-safe timer.
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      } catch (e) {
        failed++;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`Failed to enrich "${file.path}":`, message);
      }
    }

    new Notice(
      `✅ Done: ${success} enriched, ${skipped} skipped, ${failed} failed.`
    );
  }

  // --- Check quota ---

  async checkQuota(): Promise<void> {
    if (this.settings.apiKeys.length === 0) {
      new Notice("No API key configured.");
      return;
    }

    try {
      const quota = (await kinopoiskRequest(
        this.settings,
        `/api/v1/api_keys/${this.settings.apiKeys[0]}`
      )) as QuotaInfo;

      const remaining = quota.limit - quota.requestCount;
      new Notice(
        `Kinopoisk quota: ${quota.requestCount}/${quota.limit} used, ${remaining} remaining. Resets: ${quota.resetDateTime}`
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(`❌ ${message}`, 10000);
      console.error("Quota check error:", e);
    }
  }

  // --- Download poster (returns true on success) ---

  async downloadPoster(url: string, destPath: string): Promise<boolean> {
    try {
      // Check if file already exists (idempotency)
      if (await this.app.vault.adapter.exists(destPath)) {
        return true;
      }

      // Ensure directory exists
      const dir = destPath.split("/").slice(0, -1).join("/");
      if (dir && !(await this.app.vault.adapter.exists(dir + "/"))) {
        try {
          await this.app.vault.adapter.mkdir(dir);
        } catch (e) {
          // dir may already exist
        }
      }

      // Download the poster bytes (mirrors batch_enrich.ps1: plain GET, write bytes).
      // NOTE: Obsidian's requestUrl response has no `ok` property — check `status`.
      const response = await requestUrl({
        url: url,
        method: "GET",
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to download poster: HTTP ${response.status}`);
      }

      // `arrayBuffer` on RequestUrlResponsePromise is a synchronous ArrayBuffer
      // (not a Promise), so it must not be awaited.
      const buffer: ArrayBuffer = response.arrayBuffer;
      if (!buffer || buffer.byteLength === 0) {
        throw new Error("Failed to download poster: empty response body");
      }
      await this.app.vault.adapter.writeBinary(destPath, buffer);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("Poster download failed:", message);
      new Notice(`⚠️ Poster download failed: ${message}`, 8000);
      return false;
    }
  }

  // --- Collect existing property names from film and serial notes ---

  async collectPropertyNames(): Promise<string[]> {
    const props = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);
        if (this.isFilmNote(frontmatter) || this.isSerialNote(frontmatter)) {
          for (const key of Object.keys(frontmatter)) {
            props.add(key);
          }
        }
      } catch (e) {
        // skip unreadable files
      }
    }

    return Array.from(props).sort();
  }
}

// --- Settings Tab ---

class KinopoiskSettingsTab extends PluginSettingTab {
  plugin: KinopoiskPlugin;
  private apiKeysContainer: HTMLElement | null = null;
  private mappingContainer: HTMLElement | null = null;
  private mappingContentEl: HTMLElement | null = null;
  private activeMappingType: NoteType = "film";
  private actionContainer: HTMLElement | null = null;
  private mappedProps: string[] = [];

  constructor(app: App, plugin: KinopoiskPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // A section heading rendered as a proper Setting heading (the sanctioned
  // pattern), followed by a muted description line.
  private sectionHeading(
    containerEl: HTMLElement,
    title: string,
    description: string
  ): void {
    new Setting(containerEl).setName(title).setHeading();
    const desc = containerEl.createEl("p", {
      cls: "setting-item-description",
      text: description,
    });
    desc.setCssStyles({ marginTop: "-4px" });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Updates / Version ---

    this.sectionHeading(
      containerEl,
      "Updates",
      `Installed version: v${this.plugin.manifest.version}`
    );

    new Setting(containerEl)
      .setName("Check for updates")
      .setDesc("Query GitHub for the latest release of this plugin.")
      .addButton((btn) => {
        btn.setButtonText("Check now").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Checking...");
          await this.plugin.checkForUpdates(true);
          btn.setButtonText("Check now");
          btn.setDisabled(false);
        });
      });

    new Setting(containerEl)
      .setName("Check for updates on startup")
      .setDesc("Automatically check GitHub for a newer release when the plugin loads.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.checkUpdatesOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.checkUpdatesOnStartup = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    // --- Film note detection ---

    this.sectionHeading(
      containerEl,
      "Film note detection",
      "A note is treated as a film note if it has the property below and its value equals the expected value (case-insensitive)."
    );

    new Setting(containerEl)
      .setName("Property name")
      .setDesc("Frontmatter property used to detect film notes (e.g. type).")
      .addText((text) => {
        text
          .setPlaceholder("type")
          .setValue(this.plugin.settings.filmNoteProperty)
          .onChange(async (value) => {
            this.plugin.settings.filmNoteProperty = value;
            await this.plugin.saveData(this.plugin.settings);
            this.renderActions();
          });
        const suggest = new PropertySuggest(this.app, text.inputEl, []);
        this.plugin
          .collectPropertyNames()
          .then((props) => suggest.setProps(props))
          .catch(() => {
            /* empty suggest list is acceptable */
          });
      });

    new Setting(containerEl)
      .setName("Expected value")
      .setDesc("Value the property must equal for the note to count as a film (e.g. film).")
      .addText((text) => {
        text
          .setPlaceholder("film")
          .setValue(this.plugin.settings.filmNoteValue)
          .onChange(async (value) => {
            this.plugin.settings.filmNoteValue = value;
            await this.plugin.saveData(this.plugin.settings);
            this.renderActions();
          });
      });

    // --- Serial note detection ---

    this.sectionHeading(
      containerEl,
      "Serial note detection",
      "A note is treated as a serial note if it has the property below and its value equals the expected value (case-insensitive)."
    );

    new Setting(containerEl)
      .setName("Property name")
      .setDesc("Frontmatter property used to detect serial notes (e.g. type).")
      .addText((text) => {
        text
          .setPlaceholder("type")
          .setValue(this.plugin.settings.serialNoteProperty)
          .onChange(async (value) => {
            this.plugin.settings.serialNoteProperty = value;
            await this.plugin.saveData(this.plugin.settings);
            this.renderActions();
          });
      });

    new Setting(containerEl)
      .setName("Expected value")
      .setDesc("Value the property must equal for the note to count as a serial (e.g. serial).")
      .addText((text) => {
        text
          .setPlaceholder("serial")
          .setValue(this.plugin.settings.serialNoteValue)
          .onChange(async (value) => {
            this.plugin.settings.serialNoteValue = value;
            await this.plugin.saveData(this.plugin.settings);
            this.renderActions();
          });
      });

    // --- Bulk actions ---

    this.sectionHeading(containerEl, "Actions", "Bulk actions for your film and serial notes.");
    this.actionContainer = containerEl.createDiv({});
    this.renderActions();

    // --- API Keys (dynamic list) ---

    this.sectionHeading(
      containerEl,
      "Kinopoisk API Keys",
      "Add one or more API keys (from kinopoiskapiunofficial.tech). Keys are rotated on quota exhaustion (402/403)."
    );

    this.apiKeysContainer = containerEl.createDiv({
      cls: "kinopoisk-api-keys",
    });
    this.renderApiKeys();

    // --- Data Mapping (per type: films / serials) ---

    this.sectionHeading(
      containerEl,
      "Data Mapping",
      "Choose which API fields to copy into your notes, separately for films and serials. Each mapped field writes to the property you pick."
    );

    this.mappingContainer = containerEl.createDiv({
      cls: "kinopoisk-mapping",
    });
    this.renderMappingTabs();

    // --- Behavior settings ---

    new Setting(containerEl)
      .setName("Overwrite existing properties")
      .setDesc(
        "If a property is already filled in the note, overwrite it with API data."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.overwriteExisting)
          .onChange(async (value) => {
            this.plugin.settings.overwriteExisting = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Missing property behavior")
      .setDesc(
        "If a property does not exist in the note frontmatter: add it and fill, or do nothing."
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("add", "Add and fill")
          .addOption("ignore", "Do nothing")
          .setValue(this.plugin.settings.missingProperty)
          .onChange(async (value) => {
            this.plugin.settings.missingProperty = value as "add" | "ignore";
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Poster directory (films)")
      .setDesc("Directory for downloaded film posters (relative to vault root).")
      .addText((text) => {
        text
          .setPlaceholder("Films_posters")
          .setValue(this.plugin.settings.posterDir)
          .onChange(async (value) => {
            this.plugin.settings.posterDir = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Poster directory (serials)")
      .setDesc("Directory for downloaded serial/TV-series posters (relative to vault root).")
      .addText((text) => {
        text
          .setPlaceholder("TV_series_posters")
          .setValue(this.plugin.settings.serialPosterDir)
          .onChange(async (value) => {
            this.plugin.settings.serialPosterDir = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Cache directory")
      .setDesc("Directory for API cache (relative to vault root).")
      .addText((text) => {
        text
          .setPlaceholder(".kinopoisk-cache")
          .setValue(this.plugin.settings.cacheDir)
          .onChange(async (value) => {
            this.plugin.settings.cacheDir = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });
  }

  // --- Render actions (bulk buttons, visibility depends on detection settings) ---

  private renderActions(): void {
    if (!this.actionContainer) return;
    const container = this.actionContainer;
    container.empty();

    const filmProp = (this.plugin.settings.filmNoteProperty || "").trim();
    const serialProp = (this.plugin.settings.serialNoteProperty || "").trim();
    const filmOk = filmProp !== "";
    const serialOk = serialProp !== "";

    if (!filmOk && !serialOk) {
      container.createEl("div", {
        cls: "text-muted",
        text: 'Actions are disabled until note detection is configured (property names must not be empty).',
      });
      return;
    }

    const buttons: { label: string; kind: "film" | "serial" | "all"; desc: string }[] = [];
    if (filmOk) {
      buttons.push({
        label: "Enrich all film notes",
        kind: "film",
        desc: `Search Kinopoisk and enrich every note where "${filmProp}" == "${this.plugin.settings.filmNoteValue}" (skips notes that already have the mapped Kinopoisk URL property).`,
      });
    }
    if (serialOk) {
      buttons.push({
        label: "Enrich all serial notes",
        kind: "serial",
        desc: `Search Kinopoisk and enrich every note where "${serialProp}" == "${this.plugin.settings.serialNoteValue}" (skips notes that already have the mapped Kinopoisk URL property).`,
      });
    }
    buttons.push({
      label: "Enrich all film and serial notes",
      kind: "all",
      desc: "Enrich every detected film and serial note in one pass (skips already-enriched notes).",
    });

    for (const b of buttons) {
      new Setting(container)
        .setName(b.label)
        .setDesc(b.desc)
        .addButton((btn) => {
          btn
            .setButtonText("Enrich all")
            .setCta()
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("Enriching…");
              try {
                await this.plugin.enrichAllNotes(b.kind);
              } finally {
                btn.setButtonText("Enrich all");
                btn.setDisabled(false);
              }
            });
        });
    }
  }

  // --- Render dynamic API keys list ---

  private renderApiKeys(): void {
    if (!this.apiKeysContainer) return;
    const container = this.apiKeysContainer;
    container.empty();

    this.plugin.settings.apiKeys.forEach((key, index) => {
      new Setting(container)
        .setName(`Key ${index + 1}`)
        .setDesc(
          key
            ? `${key.slice(0, 8)}...${key.slice(-4)}`
            : "Enter API key"
        )
        .addText((text) => {
          text
            .setPlaceholder(`api-key-${index + 1}`)
            .setValue(key)
            .onChange(async (value) => {
              this.plugin.settings.apiKeys[index] = value;
              await this.plugin.saveData(this.plugin.settings);
              // Update the description without full re-render
              const descEl = text.inputEl.closest(".setting-item")?.querySelector(
                ".setting-item-description"
              );
              if (descEl) {
                descEl.textContent = value
                  ? `${value.slice(0, 8)}...${value.slice(-4)}`
                  : "Enter API key";
              }
            });
        })
        .addExtraButton((btn) => {
          btn
            .setTooltip("Remove key")
            .setIcon("trash")
            .onClick(async () => {
              this.plugin.settings.apiKeys.splice(index, 1);
              await this.plugin.saveData(this.plugin.settings);
              this.renderApiKeys();
            });
        });
    });

    // Add key button
    new Setting(container)
      .addButton((btn) => {
        btn
          .setButtonText("+ Add key")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.apiKeys.push("");
            await this.plugin.saveData(this.plugin.settings);
            this.renderApiKeys();
          });
      });
  }

  // --- Render data mapping (per-type tabs: films / serials) ---

  // Field→property mapping for the currently active tab.
  private mappingForActiveType(): Record<string, string> {
    return this.activeMappingType === "serial"
      ? this.plugin.settings.serialMapping
      : this.plugin.settings.filmMapping;
  }

  private renderMappingTabs(): void {
    if (!this.mappingContainer) return;
    const container = this.mappingContainer;
    container.empty();

    // Tab row: two buttons, the active one highlighted.
    const tabRow = container.createDiv({ cls: "kinopoisk-mapping-tabs" });
    const types: NoteType[] = ["film", "serial"];
    for (const t of types) {
      const label = t === "film" ? "Films" : "Serials";
      const btn = tabRow.createEl("button", { text: label });
      const active = t === this.activeMappingType;
      btn.setCssStyles({
        padding: "4px 14px",
        borderRadius: "6px",
        border: "1px solid var(--background-modifier-border)",
        background: active
          ? "var(--interactive-accent)"
          : "var(--background-secondary)",
        color: active
          ? "var(--text-on-accent)"
          : "var(--text-normal)",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: active ? "600" : "500",
        lineHeight: "1.4",
      });
      btn.onclick = () => {
        this.activeMappingType = t;
        this.renderMappingTabs();
      };
    }

    // Content area below the tabs.
    this.mappingContentEl = container.createDiv({});
    this.mappingContentEl.createEl("div", {
      text: "Loading properties...",
      cls: "text-muted",
    });

    this.plugin
      .collectPropertyNames()
      .then((props) => {
        this.mappedProps = props;
        this.renderMappingContent();
      })
      .catch((e) => {
        if (!this.mappingContentEl) return;
        this.mappingContentEl.empty();
        const message = e instanceof Error ? e.message : String(e);
        this.mappingContentEl.createEl("div", {
          text: `Failed to load property list: ${message}`,
        });
      });
  }

  private renderMappingContent(): void {
    if (!this.mappingContentEl) return;
    const content = this.mappingContentEl;
    content.empty();

    const mapping = this.mappingForActiveType();
    const mappedCount = Object.entries(mapping).filter(
      ([, v]) => (v || "").trim() !== ""
    ).length;

    const summary = content.createEl("div", {
      cls: "text-muted",
      text: `${mappedCount} of ${API_FIELDS.length} fields mapped. Type a property name to map a field; leave empty to disable it.`,
    });
    summary.setCssStyles({ marginBottom: "8px" });

    const groups: { title: string; ids: string[] }[] = [
      {
        title: "Core",
        ids: ["webUrl", "nameRu", "nameEn", "year", "type", "filmLength"],
      },
      {
        title: "Ratings",
        ids: [
          "ratingKinopoisk",
          "ratingVoteCount",
          "ratingImdb",
          "ratingFilmCritics",
          "ratingMpaa",
        ],
      },
      { title: "Text", ids: ["description", "shortDescription", "slogan"] },
      { title: "Lists", ids: ["countries", "genres"] },
      { title: "Media", ids: ["posterUrl"] },
      // TV-series only; shown on both tabs but only meaningful for serials.
      { title: "Seasons (serials)", ids: ["seasons", "releasedSeasons"] },
    ];

    for (const group of groups) {
      const heading = content.createEl("div", { text: group.title });
      heading.setCssStyles({
        fontSize: "12px",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        color: "var(--text-muted)",
        margin: "14px 0 4px 8px",
      });
      for (const id of group.ids) {
        const field = API_FIELDS.find((f) => f.id === id);
        if (!field) continue;
        const current = mapping[id] || "";
        new Setting(content)
          .setName(field.label)
          .addText((text) => {
            text
              .setPlaceholder("off")
              .setValue(current)
              .onChange(async (value) => {
                if (value.trim() === "") {
                  delete mapping[id];
                } else {
                  mapping[id] = value;
                }
                await this.plugin.saveData(this.plugin.settings);
              });
            new PropertySuggest(this.app, text.inputEl, this.mappedProps);
          });
      }
    }

    // Reset-to-defaults button for the active type.
    new Setting(content)
      .setName("Reset to defaults")
      .setDesc("Restore the default field→property mapping for this note type.")
      .addButton((btn) => {
        btn
          .setButtonText("Reset")
          .setCta()
          .onClick(async () => {
            const current = this.mappingForActiveType();
            const defaultsSource =
              this.activeMappingType === "serial"
                ? DEFAULT_SETTINGS.serialMapping
                : DEFAULT_SETTINGS.filmMapping;
            for (const k of Object.keys(current)) delete current[k];
            Object.assign(current, { ...defaultsSource });
            await this.plugin.saveData(this.plugin.settings);
            this.renderMappingContent();
          });
      });
  }
}
