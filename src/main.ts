import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  parseYaml,
} from "obsidian";

// --- API types ---

interface FilmSearchResult {
  filmId: string;
  nameRu: string;
  nameEn: string;
  year: number;
  type: string;
  description: string;
  filmLength: string;
  posterUrl: string;
  ratingKinopoisk: string;
  ratingVoteCount: string;
  countries: string[];
  genres: string[];
}

interface FilmDetail {
  filmId: string;
  webUrl: string;
  description: string;
  shortDescription: string;
  ratingKinopoisk: string;
  ratingImdb: string;
  posterUrl: string;
  nameRu: string;
  year: number;
  countries: string[];
  genres: string[];
}

interface SearchResult {
  pagesCount: number;
  searchFilmsCountResult: number;
  films: FilmSearchResult[];
}

interface QuotaInfo {
  limit: number;
  quota: number;
  requestCount: number;
  resetDateTime: string;
}

// --- Settings ---

interface KinopoiskPluginSettings {
  apiKey: string;
  apiKey2: string;
  apiKey3: string;
  posterDir: string;
  cacheDir: string;
  autoCache: boolean;
}

const DEFAULT_SETTINGS: KinopoiskPluginSettings = {
  apiKey: "",
  apiKey2: "",
  apiKey3: "",
  posterDir: "Films_posters",
  cacheDir: ".kinopoisk-cache",
  autoCache: true,
};

// --- Cache helpers ---

async function getCache(
  settings: KinopoiskPluginSettings,
  app: App,
  key: string
): Promise<any> {
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
  data: any
): Promise<void> {
  try {
    const cachePath = `${settings.cacheDir}/${key}.json`;
    // Ensure cache dir exists
    const dir = settings.cacheDir;
    if (!(await app.vault.adapter.exists(dir + "/"))) {
      try {
        await app.vault.adapter.mkdir(dir);
      } catch (e) {
        // dir may already exist, that's fine
      }
    }
    await app.vault.adapter.write(cachePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Cache write error:", e);
  }
}

// --- API helper with graceful error handling ---

async function kinopoiskRequest(
  settings: KinopoiskPluginSettings,
  endpoint: string,
  signal?: AbortSignal
): Promise<any> {
  const keys = [settings.apiKey, settings.apiKey2, settings.apiKey3].filter(
    (k) => k.trim()
  );

  if (keys.length === 0) {
    throw new Error(
      "No Kinopoisk API key configured. Please add one in plugin settings (Settings → Kinopoisk Plugin → API Key)."
    );
  }

  let lastError: any = null;

  for (const key of keys) {
    try {
      const response = await fetch(
        `https://kinopoiskapiunofficial.tech${endpoint}`,
        {
          headers: {
            "X-API-KEY": key.trim(),
          },
          signal,
        }
      );

      if (response.status === 402 || response.status === 403) {
        // Quota exhausted for this key, try next
        console.warn(
          `Kinopoisk quota exhausted for key ${key.slice(0, 4)}...`
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (e: any) {
      lastError = e;
      if (e.name === "AbortError") {
        throw e;
      }
      console.warn(
        `Kinopoisk request failed with key ${key.slice(0, 4)}...`,
        e.message
      );
    }
  }

  // Graceful error handling: show clear message with instructions
  const errorMessage = lastError?.message || "Unknown error";
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
  frontmatter: Record<string, any>;
  body: string;
}

function parseNote(content: string): ParsedNote {
  // Use Obsidian's built-in frontmatter parsing
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    let frontmatter: Record<string, any> = {};
    try {
      frontmatter = parseYaml(match[1]) || {};
    } catch (e) {
      console.warn("Failed to parse frontmatter YAML:", e);
    }
    return { frontmatter, body: match[2] };
  }
  return { frontmatter: {}, body: content };
}

function serializeFrontmatter(data: Record<string, any>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const str = String(value);
    // Quote strings that contain special characters
    if (
      str === "" ||
      str.includes(":") ||
      str.includes("#") ||
      str.includes("\n") ||
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

function rebuildNote(original: string, updates: Record<string, any>): string {
  const { frontmatter, body } = parseNote(original);
  const merged = { ...frontmatter, ...updates };
  const fmStr = serializeFrontmatter(merged);
  return `---\n${fmStr}\n---\n${body}`;
}

// --- Film Selection Modal ---

class FilmSelectionModal extends Modal {
  films: FilmSearchResult[];
  onSelect: (film: FilmSearchResult) => void;

  constructor(
    app: App,
    films: FilmSearchResult[],
    onSelect: (film: FilmSearchResult) => void
  ) {
    super(app);
    this.films = films;
    this.onSelect = onSelect;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Select a film" });

    this.films.forEach((film) => {
      const item = contentEl.createEl("div", { cls: "film-selection-item" });
      item.style.margin = "10px 0";
      item.style.padding = "10px";
      item.style.border = "1px solid var(--background-modifier-border)";
      item.style.borderRadius = "6px";
      item.style.cursor = "pointer";

      const title = item.createEl("div", {
        text: `${film.nameRu} (${film.year})`,
      });
      title.style.fontWeight = "600";
      title.style.marginBottom = "5px";

      if (film.description) {
        const desc = item.createEl("div", { text: film.description });
        desc.style.fontSize = "14px";
        desc.style.color = "var(--text-muted)";
        desc.style.maxHeight = "60px";
        desc.style.overflow = "hidden";
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

// --- Plugin ---

export default class KinopoiskPlugin extends Plugin {
  settings: KinopoiskPluginSettings;

  async onload(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    this.addSettingTab(new KinopoiskSettingsTab(this.app, this));

    // Command: enrich current file
    this.addCommand({
      id: "kinopoisk-enrich-current",
      name: "Enrich current film note from Kinopoisk",
      callback: async () => {
        await this.enrichCurrentFile();
      },
    });

    // Command: enrich all film notes
    this.addCommand({
      id: "kinopoisk-enrich-all",
      name: "Enrich all film notes from Kinopoisk",
      callback: async () => {
        await this.enrichAllFilms();
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

  async enrichCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file. Open a film note first.");
      return;
    }

    const content = await this.app.vault.read(file);
    const { frontmatter } = parseNote(content);

    if (frontmatter.type !== "film") {
      new Notice("This is not a film note (type != film).");
      return;
    }

    // Get film name from file name
    const filmName = file.basename;

    new Notice(`Searching Kinopoisk for "${filmName}"...`);

    try {
      const searchResult = await this.searchFilms(filmName);

      if (!searchResult.films || searchResult.films.length === 0) {
        new Notice(`No films found for "${filmName}".`);
        return;
      }

      // Find best match (prefer exact name match)
      let bestFilm = searchResult.films[0];
      let foundExactMatch = false;

      for (const film of searchResult.films) {
        if (film.nameRu.toLowerCase() === filmName.toLowerCase()) {
          bestFilm = film;
          foundExactMatch = true;
          break;
        }
      }

      // If no exact match and multiple results, show selection modal
      if (!foundExactMatch && searchResult.films.length > 1) {
        const modal = new FilmSelectionModal(
          this.app,
          searchResult.films,
          (film) => {
            // User selected a film from the modal
            this.processFilmSelection(film, file, filmName);
          }
        );
        modal.open();
        return;
      }

      // If exact match or only one result, process directly
      await this.processFilmSelection(bestFilm, file, filmName);
    } catch (e: any) {
      // Graceful error handling
      new Notice(`❌ ${e.message}`, 10000);
      console.error("Kinopoisk enrichment error:", e);
    }
  }

  async searchFilms(keyword: string): Promise<SearchResult> {
    const endpoint = `/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(
      keyword
    )}&page=1`;
    return kinopoiskRequest(this.settings, endpoint);
  }

  async processFilmSelection(
    film: FilmSearchResult,
    file: TFile,
    filmName: string
  ): Promise<void> {
    try {
      new Notice(
        `Processing: "${film.nameRu}" (${film.year}). Getting details...`
      );

      // Check cache first
      let detail = await getCache(this.settings, this.app, `film-${film.filmId}`);

      if (!detail) {
        detail = await kinopoiskRequest(
          this.settings,
          `/api/v2.2/films/${film.filmId}`
        );
        await setCache(this.settings, this.app, `film-${film.filmId}`, detail);
      }

      // Build updates
      const updates: Record<string, any> = {};

      if (detail.webUrl) {
        updates.kinopoisk = detail.webUrl;
      }

      if (detail.ratingKinopoisk) {
        updates.kp_rating = detail.ratingKinopoisk;
      }

      if (detail.description) {
        updates.description = detail.description;
      }

      // Download poster
      if (detail.posterUrl) {
        const posterPath = `${this.settings.posterDir}/${film.filmId}.jpg`;
        await this.downloadPoster(detail.posterUrl, posterPath);
        updates.poster = `[[${posterPath}]]`;
      }

      // Write updates
      const original = await this.app.vault.read(file);
      const newContent = rebuildNote(original, updates);
      await this.app.vault.process(file, () => newContent);

      new Notice(`✅ Updated "${filmName}" with Kinopoisk data.`);
    } catch (e: any) {
      // Graceful error handling
      new Notice(`❌ ${e.message}`, 10000);
      console.error("Film selection processing error:", e);
    }
  }

  async enrichAllFilms(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();

    if (files.length === 0) {
      new Notice("No markdown files found.");
      return;
    }

    // Filter to film notes only
    const filmFiles: TFile[] = [];
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);
        if (frontmatter.type === "film") {
          filmFiles.push(file);
        }
      } catch (e) {
        // skip unreadable files
      }
    }

    if (filmFiles.length === 0) {
      new Notice("No film notes found (type: film).");
      return;
    }

    new Notice(
      `Found ${filmFiles.length} film notes. Starting enrichment...`
    );

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of filmFiles) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);

        if (frontmatter.kinopoisk) {
          skipped++;
          continue;
        }

        const filmName = file.basename;
        const searchResult = await this.searchFilms(filmName);

        if (!searchResult.films || searchResult.films.length === 0) {
          failed++;
          continue;
        }

        // In batch mode, take the first result (no modal)
        const bestFilm = searchResult.films[0];
        await this.processFilmSelection(bestFilm, file, filmName);
        success++;

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (e: any) {
        failed++;
        console.error(`Failed to enrich "${file.path}":`, e.message);
      }
    }

    new Notice(
      `✅ Done: ${success} enriched, ${skipped} skipped, ${failed} failed.`
    );
  }

  async checkQuota(): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("No API key configured.");
      return;
    }

    try {
      const quota = await kinopoiskRequest(
        this.settings,
        `/api/v1/api_keys/${this.settings.apiKey}`
      );

      const remaining = quota.limit - quota.requestCount;
      new Notice(
        `Kinopoisk quota: ${quota.requestCount}/${quota.limit} used, ${remaining} remaining. Resets: ${quota.resetDateTime}`
      );
    } catch (e: any) {
      // Graceful error handling
      new Notice(`❌ ${e.message}`, 10000);
      console.error("Quota check error:", e);
    }
  }

  async downloadPoster(url: string, destPath: string): Promise<void> {
    try {
      // Ensure directory exists
      const dir = destPath.split("/").slice(0, -1).join("/");
      if (dir && !(await this.app.vault.adapter.exists(dir + "/"))) {
        try {
          await this.app.vault.adapter.mkdir(dir);
        } catch (e) {
          // dir may already exist, that's fine
        }
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download poster: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      await this.app.vault.adapter.writeBinary(destPath, buffer);
    } catch (e: any) {
      // Graceful error handling
      console.warn("Poster download failed:", e.message);
      new Notice(`⚠️ Poster download failed: ${e.message}`, 8000);
    }
  }
}

// --- Settings Tab ---

class KinopoiskSettingsTab extends PluginSettingTab {
  plugin: KinopoiskPlugin;

  constructor(app: App, plugin: KinopoiskPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Kinopoisk API Key")
      .setDesc(
        "Your Kinopoisk Unofficial API key (from kinopoiskapiunofficial.tech). Required."
      )
      .addText((text) => {
        text
          .setPlaceholder("your-api-key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Secondary API Key")
      .setDesc("Optional secondary key for rotation.")
      .addText((text) => {
        text
          .setPlaceholder("secondary-key")
          .setValue(this.plugin.settings.apiKey2)
          .onChange(async (value) => {
            this.plugin.settings.apiKey2 = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Tertiary API Key")
      .setDesc("Optional tertiary key for rotation.")
      .addText((text) => {
        text
          .setPlaceholder("tertiary-key")
          .setValue(this.plugin.settings.apiKey3)
          .onChange(async (value) => {
            this.plugin.settings.apiKey3 = value;
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName("Poster directory")
      .setDesc("Directory for downloaded posters (relative to vault root).")
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
}
