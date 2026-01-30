import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  fetchDepartures,
  formatDepartureLine,
  getSiteCandidates,
  getSites,
  normalizeDepartureMode,
  normalizeModesFilter,
  resolveSiteMatch,
} from "./sl";

// StreamableHttp server
const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "sl_find_site",
      {
        title: "sl_find_site",
        description: "Find SL site IDs by station name query.",
        inputSchema: z.object({
          query: z.string().min(1),
          maxResults: z.number().int().min(1).max(20).optional(),
        }),
      },
      async ({ query, maxResults }) => {
        try {
          const sites = await getSites();
          const matches = getSiteCandidates(sites, query, maxResults ?? 5);
          if (matches.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No SL sites found for "${query}". Try a different spelling or search nearby stations.`,
                },
              ],
            };
          }

          const lines = matches.map(
            (site) => `${site.name} (id: ${site.siteId})`
          );
          return {
            content: [
              {
                type: "text",
                text: `Found ${matches.length} site(s):\n${lines.join("\n")}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch SL sites. ${error instanceof Error ? error.message : "Unknown error."}`,
              },
            ],
          };
        }
      }
    );

    server.registerTool(
      "sl_departures",
      {
        title: "sl_departures",
        description: "Get SL departures for a station name or siteId.",
        inputSchema: z
          .object({
            siteId: z.coerce.number().int(),
            maxResults: z.number().int().min(1).max(30).optional(),
            modes: z.array(z.string()).optional(),
            directionContains: z.string().min(1).optional(),
          })
          .strict(),
      },
      async (params) => {
        const { station, siteId, id, maxResults, modes, directionContains } =
          params;
        const limit = maxResults ?? 8;
        const filterModes = normalizeModesFilter(modes ?? []);
        const ignoredModes = filterModes.ignoredModes;

        let resolvedSiteId = siteId ?? id;
        let resolvedSiteName = "";

        try {
          if (!resolvedSiteId && station) {
            const sites = await getSites();
            const match = resolveSiteMatch(sites, station);
            if (match.candidates) {
              const candidates = match.candidates
                .slice(0, 5)
                .map((site) => `${site.name} (id: ${site.siteId})`);
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple SL sites match "${station}". Please refine your station name or pass a siteId (or id).\n${candidates.join("\n")}`,
                  },
                ],
              };
            }
            if (!match.site) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No SL site found for "${station}". Try a different spelling or use sl_find_site to browse options.`,
                  },
                ],
              };
            }
            resolvedSiteId = match.site.siteId;
            resolvedSiteName = match.site.name;
          }

          if (!resolvedSiteId) {
            return {
              content: [
                {
                  type: "text",
                  text: "No siteId resolved. Provide a station name or siteId (or id).",
                },
              ],
            };
          }

          const departures = await fetchDepartures(resolvedSiteId);
          const filtered = departures
            .filter((departure) => {
              if (filterModes.filterSet.size === 0) {
                return true;
              }
              const modeValue = normalizeDepartureMode(departure.mode);
              return filterModes.filterSet.has(modeValue);
            })
            .filter((departure) => {
              if (!directionContains) {
                return true;
              }
              const haystack = `${departure.destination ?? ""}`.toLowerCase();
              return haystack.includes(directionContains.toLowerCase());
            })
            .slice(0, limit);

          if (filtered.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No departures found${resolvedSiteName ? ` for ${resolvedSiteName}` : ""} with the requested filters.`,
                },
              ],
            };
          }

          const headerLines = [];
          if (resolvedSiteName) {
            headerLines.push(`Departures for ${resolvedSiteName} (id: ${resolvedSiteId})`);
          }
          if (ignoredModes.length > 0) {
            headerLines.push(
              `Ignored unsupported modes: ${ignoredModes.join(", ")}.`
            );
          }
          headerLines.push("Times are in Europe/Stockholm.");

          const lines = filtered.map((departure) =>
            formatDepartureLine(departure)
          );

          return {
            content: [
              {
                type: "text",
                text: `${headerLines.join("\n")}\n${lines.join("\n")}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch SL departures. ${error instanceof Error ? error.message : "Unknown error."}`,
              },
            ],
          };
        }
      }
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  }
);

const withAuth = async (request: Request) => {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    return new Response("MCP_API_KEY is not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const headerKey = request.headers.get("x-api-key");

  if (token !== apiKey && headerKey !== apiKey) {
    return new Response("Unauthorized. Provide MCP_API_KEY.", { status: 401 });
  }

  return handler(request);
};

export { withAuth as GET, withAuth as POST, withAuth as DELETE };
