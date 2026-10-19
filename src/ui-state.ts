export function bindVideoReadyOverlay(video: EventTarget, overlay: { hidden: boolean | string }): void {
  for (const event of ["loadedmetadata", "playing"]) {
    video.addEventListener(event, () => { overlay.hidden = true; }, { once: true });
  }
}

export type ConsoleItem = { id?: string; name?: string; deviceName?: string; serverId?: string; powerState?: string; consoleType?: string };
type RecordObject = Record<string, unknown>;
function record(value: unknown): RecordObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordObject : undefined; }
export function extractConsoles(raw: unknown): ConsoleItem[] {
  if (Array.isArray(raw)) return raw.filter((item) => record(item)) as ConsoleItem[];
  const data = record(raw);
  const list = data?.result ?? data?.servers ?? data?.results;
  return Array.isArray(list) ? list.filter((item) => record(item)) as ConsoleItem[] : [];
}
export function resolveHomeTarget(consoleItem: ConsoleItem, rawServers: unknown, consoleCount = 0): string | undefined {
  const candidates = extractConsoles(rawServers);
  const name = (consoleItem.name ?? consoleItem.deviceName ?? "").toLocaleLowerCase();
  const match = candidates.find((server) => {
    const serverName = (server.name ?? server.deviceName ?? "").toLocaleLowerCase();
    return !!name && !!serverName && name === serverName;
  });
  if (match?.serverId || match?.id) return match.serverId ?? match.id;
  if (consoleCount === 1 && candidates.length === 1) return candidates[0].serverId ?? candidates[0].id;
  return undefined;
}
export function initialTab(authenticated: boolean): string { return authenticated ? "consoles" : "login"; }
