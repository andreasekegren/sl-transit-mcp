const SL_SITES_URL = "https://transport.integration.sl.se/v1/sites";
const SL_DEPARTURES_URL = (siteId: number) =>
  `https://transport.integration.sl.se/v1/sites/${siteId}/departures`;
const STOCKHOLM_TIMEZONE = "Europe/Stockholm";
const SITES_CACHE_KEY = "sl:sites:v1";

type Site = {
  siteId: number;
  name: string;
};

type RawDeparture = Record<string, unknown>;

type Departure = {
  time: string;
  mode: string;
  line: string;
  destination: string;
  platform?: string;
  timing: "realtime" | "scheduled";
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type ModeFilter = {
  filterSet: Set<string>;
  ignoredModes: string[];
};

const memoryCache = new Map<string, CacheEntry<unknown>>();

const timeFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: STOCKHOLM_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const SUPPORTED_MODES = new Set([
  "BUS",
  "METRO",
  "TRAIN",
  "TRAM",
  "SHIP",
]);

const hasKvConfig = () =>
  Boolean(
    process.env.KV_REST_API_URL &&
      (process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN)
  );

const parseTimeValue = (value: unknown): Date | null => {
  if (typeof value === "number") {
    return new Date(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/\/Date\((\d+)\)\//);
  if (match) {
    return new Date(Number(match[1]));
  }
  if (/^\d+$/.test(trimmed)) {
    return new Date(Number(trimmed));
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeText = (value: string) =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

const getMemoryCache = <T>(key: string): T | null => {
  const entry = memoryCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value as T;
};

const setMemoryCache = <T>(key: string, value: T, ttlMs: number) => {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const fetchSitesFromApi = async (): Promise<Site[]> => {
  const response = await fetch(SL_SITES_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`SL sites request failed with ${response.status}.`);
  }
  const data = (await response.json()) as Array<{
    siteId?: number | string;
    name?: string;
  }>;
  if (!Array.isArray(data)) {
    throw new Error("Unexpected SL sites response.");
  }
  return data
    .map((site) => ({
      siteId: Number(site.siteId),
      name: String(site.name ?? "").trim(),
    }))
    .filter((site) => Number.isFinite(site.siteId) && site.name.length > 0);
};

const getKv = async () => {
  if (!hasKvConfig()) {
    return null;
  }
  const { kv } = await import("@vercel/kv");
  return kv;
};

export const getSites = async (): Promise<Site[]> => {
  const memorySites = getMemoryCache<Site[]>(SITES_CACHE_KEY);
  if (memorySites) {
    return memorySites;
  }

  const kvClient = await getKv();
  if (kvClient) {
    try {
      const cachedSites = await kvClient.get<Site[]>(SITES_CACHE_KEY);
      if (cachedSites && Array.isArray(cachedSites)) {
        setMemoryCache(SITES_CACHE_KEY, cachedSites, 60 * 60 * 1000);
        return cachedSites;
      }
    } catch (error) {
      console.warn("KV sites cache failed, falling back to memory.", error);
    }
  }

  const sites = await fetchSitesFromApi();
  setMemoryCache(SITES_CACHE_KEY, sites, 60 * 60 * 1000);
  if (kvClient) {
    try {
      await kvClient.set(SITES_CACHE_KEY, sites, {
        ex: 60 * 60 * 24 * 7,
      });
    } catch (error) {
      console.warn("KV sites cache write failed.", error);
    }
  }
  return sites;
};

export const getSiteCandidates = (
  sites: Site[],
  query: string,
  maxResults: number
): Site[] => {
  const normalizedQuery = normalizeText(query);
  const scored = sites
    .map((site) => {
      const normalizedName = normalizeText(site.name);
      let score = 0;
      if (normalizedName === normalizedQuery) {
        score = 3;
      } else if (normalizedName.startsWith(normalizedQuery)) {
        score = 2;
      } else if (normalizedName.includes(normalizedQuery)) {
        score = 1;
      }
      return { site, score, length: normalizedName.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.length !== b.length) {
        return a.length - b.length;
      }
      return a.site.name.localeCompare(b.site.name, "sv");
    });
  return scored.slice(0, maxResults).map((entry) => entry.site);
};

export const resolveSiteMatch = (
  sites: Site[],
  query: string
): { site?: Site; candidates?: Site[] } => {
  const normalizedQuery = normalizeText(query);
  const scored = sites
    .map((site) => {
      const normalizedName = normalizeText(site.name);
      let score = 0;
      if (normalizedName === normalizedQuery) {
        score = 3;
      } else if (normalizedName.startsWith(normalizedQuery)) {
        score = 2;
      } else if (normalizedName.includes(normalizedQuery)) {
        score = 1;
      }
      return { site, score, length: normalizedName.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.length !== b.length) {
        return a.length - b.length;
      }
      return a.site.name.localeCompare(b.site.name, "sv");
    });

  if (scored.length === 0) {
    return {};
  }

  const topScore = scored[0].score;
  const topCandidates = scored.filter((entry) => entry.score === topScore);
  if (topScore >= 2 && topCandidates.length > 1) {
    return { candidates: topCandidates.map((entry) => entry.site) };
  }
  return { site: scored[0].site };
};

export const normalizeModesFilter = (modes: string[]): ModeFilter => {
  const filterSet = new Set<string>();
  const ignoredModes: string[] = [];
  modes.forEach((mode) => {
    const upper = mode.toUpperCase();
    if (upper === "FERRY" || upper === "SHIP/FERRY") {
      filterSet.add("SHIP");
      return;
    }
    if (SUPPORTED_MODES.has(upper)) {
      filterSet.add(upper);
      return;
    }
    ignoredModes.push(mode);
  });
  return { filterSet, ignoredModes };
};

const mapDeparture = (raw: RawDeparture): Departure | null => {
  const expected =
    raw.expectedDepartureTime ??
    raw.expected ??
    raw.realtimeDepartureTime ??
    raw.realtime ??
    raw.estimatedDepartureTime;
  const scheduled =
    raw.scheduledDepartureTime ??
    raw.plannedDepartureTime ??
    raw.scheduled ??
    raw.time;
  const expectedDate = parseTimeValue(expected);
  const scheduledDate = parseTimeValue(scheduled);
  const timeValue = expectedDate ?? scheduledDate;
  if (!timeValue) {
    return null;
  }
  const mode =
    (raw.transportMode as string) ||
    (raw.mode as string) ||
    (raw.line as { transportMode?: string })?.transportMode ||
    "";
  const lineValue =
    (raw.line as { designation?: string; name?: string })?.designation ||
    (raw.line as { name?: string })?.name ||
    (raw.line as string) ||
    (raw.lineNumber as string) ||
    "";
  const destination =
    (raw.destination as string) ||
    (raw.direction as string) ||
    (raw.destinationName as string) ||
    "";
  const platform =
    (raw.stopPoint as { designation?: string })?.designation ||
    (raw.platform as string) ||
    "";
  const timing =
    expectedDate && scheduledDate && expectedDate.getTime() !== scheduledDate.getTime()
      ? "realtime"
      : "scheduled";
  return {
    time: timeFormatter.format(timeValue),
    mode: mode.toString(),
    line: lineValue.toString(),
    destination: destination.toString(),
    platform: platform.toString(),
    timing,
  };
};

export const fetchDepartures = async (siteId: number): Promise<Departure[]> => {
  const response = await fetch(SL_DEPARTURES_URL(siteId), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`SL departures request failed with ${response.status}.`);
  }
  const data = (await response.json()) as
    | { departures?: RawDeparture[] }
    | RawDeparture[];
  const rawDepartures = Array.isArray(data) ? data : data.departures ?? [];
  if (!Array.isArray(rawDepartures)) {
    return [];
  }
  return rawDepartures.map(mapDeparture).filter(Boolean) as Departure[];
};

export const normalizeDepartureMode = (mode: string) => {
  const upper = mode.toUpperCase();
  if (upper === "FERRY" || upper === "SHIP/FERRY") {
    return "SHIP";
  }
  return upper;
};

export const formatDepartureLine = (departure: Departure): string => {
  const mode = normalizeDepartureMode(departure.mode || "UNKNOWN");
  const line = departure.line || "-";
  const destination = departure.destination || "Unknown destination";
  const platformText =
    departure.platform && departure.platform !== ""
      ? ` (platform ${departure.platform})`
      : "";
  return `${departure.time}  ${mode}  ${line} → ${destination}${platformText} [${departure.timing}]`;
};
