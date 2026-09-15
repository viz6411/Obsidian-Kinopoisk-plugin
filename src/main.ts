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
];

interface KinopoiskPluginSettings {
  apiKeys: string[];
  posterDir: string;
  cacheDir: string;
  autoCache: boolean;
  mapping: Record<string, string>;
  overwriteExisting: boolean;
  missingProperty: "add" | "ignore";
}

const DEFAULT_SETTINGS: KinopoiskPluginSettings = {
  apiKeys: [],
  posterDir: "Films_posters",
  cacheDir: ".kinopoisk-cache",
  autoCache: true,
  mapping: {
    webUrl: "kinopoisk",
    ratingKinopoisk: "kp_rating",
    description: "description",
    posterUrl: "poster",
  },
  overwriteExisting: true,
  missingProperty: "add",
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

async function kinopoiskRequest(
  settings: KinopoiskPluginSettings,
  endpoint: string
): Promise<any> {
  const keys = settings.apiKeys.map((k) => k.trim()).filter((k) => k !== "");

  if (keys.length === 0) {
    throw new Error(
      "No Kinopoisk API key configured. Please add one in plugin settings (Settings → Kinopoisk Plugin → API Keys)."
    );
  }

  let lastError: any = null;

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

      return response.json;
    } catch (e: any) {
      lastError = e;
      console.warn(
        `Kinopoisk request failed with key ${key.slice(0, 4)}...`,
        e.message
      );
    }
  }

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
    // Preserve empty properties (e.g. "rating:") instead of dropping them.
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
      continue;
    }
    const str = String(value);
    // Obsidian's frontmatter parser chokes on multi-line double-quoted values
    // (renders the property as red/broken). Flatten newlines to spaces so
    // every key stays on a single line.
    const flat = str.includes("\n") ? str.replace(/\n+/g, " ") : str;
    if (
      flat === "" ||
      flat.includes(":") ||
      flat.includes("#") ||
      flat.startsWith(" ") ||
      flat.startsWith('"')
    ) {
      const escaped = flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      lines.push(`${key}: "${escaped}"`);
    } else {
      lines.push(`${key}: ${flat}`);
    }
  }
  return lines.join("\n");
}

function rebuildNote(
  original: string,
  updates: Record<string, any>
): string {
  const { frontmatter, body } = parseNote(original);
  const merged = { ...frontmatter, ...updates };
  const fmStr = serializeFrontmatter(merged);
  return `---\n${fmStr}\n---\n${body}`;
}

// --- Film Selection Modal ---

class FilmSelectionModal extends Modal {
  films: FilmInfo[];
  onSelect: (film: FilmInfo) => void;

  constructor(
    app: App,
    films: FilmInfo[],
    onSelect: (film: FilmInfo) => void
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
      const item = contentEl.createEl("div", {
        cls: "film-selection-item",
      });
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

// --- Property name suggest (type-ahead + free text) ---

class PropertySuggest extends AbstractInputSuggest<string> {
  private props: string[];

  constructor(app: App, inputEl: HTMLInputElement, props: string[]) {
    super(app, inputEl);
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
    const rawData: any = (await this.loadData()) || {};

    // Migrate old settings format (apiKey/apiKey2/apiKey3) to new (apiKeys[])
    const oldKeys = [rawData.apiKey, rawData.apiKey2, rawData.apiKey3]
      .map((k: any) => (typeof k === "string" ? k.trim() : ""))
      .filter((k: string) => k !== "");
    delete rawData.apiKey;
    delete rawData.apiKey2;
    delete rawData.apiKey3;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData);

    if (this.settings.apiKeys.length === 0 && oldKeys.length > 0) {
      this.settings.apiKeys = oldKeys;
    }
    await this.saveData(this.settings);

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

  // --- Enrich current file ---

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

    const filmName = file.basename;

    new Notice(`Searching Kinopoisk for "${filmName}"...`);

    try {
      const searchResult = await this.searchFilms(filmName);

      if (!searchResult.films || searchResult.films.length === 0) {
        new Notice(`No films found for "${filmName}".`);
        return;
      }

      let bestFilm = searchResult.films[0];
      let foundExactMatch = false;

      for (const film of searchResult.films) {
        if (film.nameRu.toLowerCase() === filmName.toLowerCase()) {
          bestFilm = film;
          foundExactMatch = true;
          break;
        }
      }

      if (!foundExactMatch && searchResult.films.length > 1) {
        const modal = new FilmSelectionModal(this.app, searchResult.films, (film) => {
          this.processFilmSelection(film, file, filmName);
        });
        modal.open();
        return;
      }

      await this.processFilmSelection(bestFilm, file, filmName);
    } catch (e: any) {
      new Notice(`❌ ${e.message}`, 10000);
      console.error("Kinopoisk enrichment error:", e);
    }
  }

  // --- Search films ---

  async searchFilms(keyword: string): Promise<SearchResult> {
    const endpoint = `/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(
      keyword
    )}&page=1`;
    return kinopoiskRequest(this.settings, endpoint);
  }

  // --- Process film selection ---

  async processFilmSelection(
    film: FilmInfo,
    file: TFile,
    filmName: string
  ): Promise<void> {
    try {
      new Notice(
        `Processing: "${film.nameRu}" (${film.year}). Getting details...`
      );

      let detail = await getCache(this.settings, this.app, `film-${film.filmId}`);

      if (!detail) {
        detail = await kinopoiskRequest(
          this.settings,
          `/api/v2.2/films/${film.filmId}`
        );
        await setCache(this.settings, this.app, `film-${film.filmId}`, detail);
      }

      const original = await this.app.vault.read(file);
      const { frontmatter } = parseNote(original);

      const updates: Record<string, any> = {};

      for (const [fieldId, propName] of Object.entries(this.settings.mapping)) {
        if (!propName || propName.trim() === "") continue;
        const val = detail[fieldId as keyof FilmInfo];
        if (val === null || val === undefined || val === "") continue;

        // Check existing property
        if (propName in frontmatter) {
          if (!this.settings.overwriteExisting) continue; // keep existing
        } else {
          // Property missing in note
          if (this.settings.missingProperty === "ignore") continue;
        }

        if (fieldId === "posterUrl" && typeof val === "string") {
          const posterPath = `${this.settings.posterDir}/${film.filmId}.jpg`;
          const ok = await this.downloadPoster(val, posterPath);
          if (ok) {
            updates[propName] = `[[${posterPath}]]`;
          } else {
            console.warn(`Poster download failed for film ${film.filmId}`);
          }
        } else {
          updates[propName] = val;
        }
      }

      if (Object.keys(updates).length > 0) {
        const newContent = rebuildNote(original, updates);
        await this.app.vault.process(file, () => newContent);
      }

      new Notice(
        `✅ Updated "${filmName}" with Kinopoisk data.`
      );
    } catch (e: any) {
      new Notice(`❌ ${e.message}`, 10000);
      console.error("Film selection processing error:", e);
    }
  }

  // --- Enrich all films ---

  async enrichAllFilms(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();

    if (files.length === 0) {
      new Notice("No markdown files found.");
      return;
    }

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

        const bestFilm = searchResult.films[0];
        await this.processFilmSelection(bestFilm, file, filmName);
        success++;

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

  // --- Check quota ---

  async checkQuota(): Promise<void> {
    if (this.settings.apiKeys.length === 0) {
      new Notice("No API key configured.");
      return;
    }

    try {
      const quota = await kinopoiskRequest(
        this.settings,
        `/api/v1/api_keys/${this.settings.apiKeys[0]}`
      );

      const remaining = quota.limit - quota.requestCount;
      new Notice(
        `Kinopoisk quota: ${quota.requestCount}/${quota.limit} used, ${remaining} remaining. Resets: ${quota.resetDateTime}`
      );
    } catch (e: any) {
      new Notice(`❌ ${e.message}`, 10000);
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

      const buffer = await response.arrayBuffer;
      if (!buffer || buffer.byteLength === 0) {
        throw new Error("Failed to download poster: empty response body");
      }
      await this.app.vault.adapter.writeBinary(destPath, buffer);
      return true;
    } catch (e: any) {
      console.warn("Poster download failed:", e.message);
      new Notice(`⚠️ Poster download failed: ${e.message}`, 8000);
      return false;
    }
  }

  // --- Collect existing property names from film notes ---

  async collectPropertyNames(): Promise<string[]> {
    const props = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const { frontmatter } = parseNote(content);
        if (frontmatter.type === "film") {
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
  private mappedProps: string[] = [];

  constructor(app: App, plugin: KinopoiskPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- API Keys (dynamic list) ---

    new Setting(containerEl)
      .setName("Kinopoisk API Keys")
      .setDesc(
        "Add one or more API keys (from kinopoiskapiunofficial.tech). Keys are rotated on quota exhaustion (402/403)."
      );

    this.apiKeysContainer = containerEl.createDiv({
      cls: "kinopoisk-api-keys",
    });
    this.renderApiKeys();

    // --- Data Mapping ---

    new Setting(containerEl)
      .setName("Data Mapping")
      .setDesc(
        "Select which API fields to map to note properties. For each field, choose the property name."
      );

    this.mappingContainer = containerEl.createDiv({
      cls: "kinopoisk-mapping",
    });
    this.renderMapping();

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

  // --- Render data mapping ---

  private renderMapping(): void {
    if (!this.mappingContainer) return;
    const container = this.mappingContainer;
    container.empty();
    container.createEl("div", {
      text: "Loading properties...",
      cls: "text-muted",
    });

    this.plugin
      .collectPropertyNames()
      .then((props) => {
        this.mappedProps = props;
        this.buildMappingRows(container, props);
      })
      .catch((e) => {
        container.empty();
        container.createEl("div", {
          text: `Failed to load property list: ${e.message}`,
        });
      });
  }

  private buildMappingRows(container: HTMLElement, props: string[]): void {
    container.empty();
    const selectedFields = Object.keys(this.plugin.settings.mapping);

    API_FIELDS.forEach((field) => {
      const isSelected = selectedFields.includes(field.id);

      new Setting(container)
        .setName(field.label)
        .setDesc(isSelected ? "Mapped" : "Not mapped")
        .addToggle((toggle) => {
          toggle
            .setValue(isSelected)
            .onChange(async (value) => {
              if (value) {
                if (!this.plugin.settings.mapping[field.id]) {
                  this.plugin.settings.mapping[field.id] = "";
                }
              } else {
                delete this.plugin.settings.mapping[field.id];
              }
              await this.plugin.saveData(this.plugin.settings);
              this.renderMapping();
            });
        });

      if (isSelected) {
        const propName = this.plugin.settings.mapping[field.id] || "";

        new Setting(container)
          .setName(`→ Property for: ${field.label}`)
          .setDesc(
            propName === ""
              ? "Type a property name (existing or new)"
              : `Property: ${propName}`
          )
          .addText((text) => {
            text
              .setPlaceholder("property-name")
              .setValue(propName)
              .onChange(async (value) => {
                this.plugin.settings.mapping[field.id] = value;
                await this.plugin.saveData(this.plugin.settings);
              });
            new PropertySuggest(this.app, text.inputEl, props);
          });
      }
    });
  }
}
