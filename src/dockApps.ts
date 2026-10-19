export interface AppInfo {
	name: string;
	path: string;
	icon: string | null;
	is_running: boolean;
	is_pinned?: boolean;
	hwnd?: number;
	executable?: string;
	all_hwnds?: [number, string][];
	tray_ids?: string[];
	is_background?: boolean;
}


// Match pinned shortcuts and visible windows without conflating a browser
// with PWAs hosted by that same browser process.
const HOST_PROCESSES = ["msedge.exe", "chrome.exe", "brave.exe", "applicationframehost.exe"];
const fileOf = (path: string) =>
	(path.split("/").pop()?.split("\\").pop()?.toLowerCase() || "").replace(/\.lnk$/, "");
const isIdentifier = (path: string) => !path.includes("/") && !path.includes("\\");

export function isBrowserHost(path: string): boolean {
	const normalized = path.toLowerCase();
	return HOST_PROCESSES.some((host) => normalized.includes(host));
}

export function appIdentity(path: string, executable?: string, name?: string): string {
	if (!path) return "";
	const normalized = path.toLowerCase().replace(/\\/g, "/");
	if (!normalized.includes("/")) return normalized;
	if (name && isBrowserHost(normalized)) return `${normalized}:${name.toLowerCase()}`;
	if (executable) return `${normalized}:${executable.toLowerCase()}`;
	return normalized;
}

const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name);

// The pinned browser may be an AppsFolder/AUMID entry with no executable,
// while a running browser exposes the full executable path.
function browserHostExecutable(app: AppInfo): string | undefined {
	const executable = (app.executable || (isIdentifier(app.path) ? "" : fileOf(app.path))).toLowerCase();
	const found = HOST_PROCESSES.find((host) => executable === host);
	if (found) return found;
	const name = app.name.trim().toLowerCase();
	if (name === "google chrome" || name === "chrome") return "chrome.exe";
	if (name === "microsoft edge" || name === "edge") return "msedge.exe";
	if (name === "brave" || name === "brave browser") return "brave.exe";
	return undefined;
}

export function isBrowserBackedApp(app: AppInfo): boolean {
	return browserHostExecutable(app) !== undefined;
}

function hostAppName(name: string, host: string): string {
	const value = name.trim().toLowerCase();
	if (host === "chrome.exe" && (value === "chrome" || value === "google chrome")) return "@browser";
	if (host === "msedge.exe" && (value === "edge" || value === "microsoft edge")) return "@browser";
	if (host === "brave.exe" && (value === "brave" || value === "brave browser")) return "@browser";
	return value;
}

// A pinned shortcut and its window can have different paths (.lnk,
// executable path or AUMID). Do not compare browser hosts by executable alone:
// different installed web apps can share Chrome/Edge/Brave.
export function isSameApp(a: AppInfo, b: AppInfo): boolean {
	if (!a.path || !b.path) return false;
	if (itemKey(a) === itemKey(b)) return true;
	const aId = isIdentifier(a.path);
	const bId = isIdentifier(b.path);
	// Distinct opaque shell app IDs must remain distinct even if they share a host.
	if (aId && bId) return false;

	const aHost = browserHostExecutable(a);
	const bHost = browserHostExecutable(b);
	if (aHost || bHost) {
		return !!aHost && aHost === bHost &&
			hostAppName(a.name, aHost) === hostAppName(b.name, bHost!);
	}

	if (aId !== bId) {
		const fileSide = aId ? b : a;
		const idLower = (aId ? a : b).path.toLowerCase();
		const na = a.name.toLowerCase();
		const nb = b.name.toLowerCase();
		if (na !== nb && !na.includes(nb) && !nb.includes(na)) return false;
		const stem = (fileSide.executable?.toLowerCase() || fileOf(fileSide.path)).replace(
			/\.(exe|lnk)$/, ""
		);
		return stem.length >= 3 && idLower.includes(stem);
	}
	if (appIdentity(a.path) === appIdentity(b.path)) return true;
	const normExe = (s: string) => (s.endsWith(".exe") ? s : `${s}.exe`);
	const aExe = a.executable?.toLowerCase() || fileOf(a.path);
	const bExe = b.executable?.toLowerCase() || fileOf(b.path);
	return !!aExe && !!bExe && normExe(aExe) === normExe(bExe);
}

export interface TrayApp {
	name: string;
	path: string;
	tray_ids: string[];
	window_handles: number[];
}

const trayPath = (app: TrayApp) => app.path.toLowerCase().replace(/\\/g, "/");

const ownsVisibleWindow = (window: AppInfo, tray: TrayApp) =>
	(window.all_hwnds ?? (window.hwnd ? [[window.hwnd, window.name]] : [])).some(([hwnd]) =>
		tray.window_handles.includes(hwnd as number)
	);

// An unpinned notification icon becomes a dock item only after its app has
// appeared with a window. Pinned apps are eligible immediately at startup.
// Forget observed apps when their tray icon exits, so a later tray-only launch
// does not inherit a previous session's dock slot.
export function selectDockTrayApps(
	windows: AppInfo[],
	tray: TrayApp[],
	previouslyOpened: Set<string>,
	isPinned: (app: TrayApp) => boolean
): { visible: TrayApp[]; observed: Set<string> } {
	const observed = new Set<string>();
	for (const app of tray) {
		const path = trayPath(app);
		if (previouslyOpened.has(path) || windows.some((window) => ownsVisibleWindow(window, app))) {
			observed.add(path);
		}
	}
	return {
		visible: tray.filter((app) => observed.has(trayPath(app)) || isPinned(app)),
		observed
	};
}

// Associate through actual owner windows, including AUMID/PWA entries whose
// launch path differs from their executable. Never attach a tray to a different
// app just because it has the same display name or executable basename.
export function mergeTrayApps(windows: AppInfo[], tray: TrayApp[]): AppInfo[] {
	const result = windows.map((app) => ({
		...app,
		is_background: false,
		tray_ids: undefined as string[] | undefined
	}));
	for (const app of tray) {
		const owners = result.filter((item) => ownsVisibleWindow(item, app));
		if (owners.length) {
			// A browser tray can own several unrelated PWAs. Keep the running
			// items distinct and don't give any one PWA the browser's tray menu.
			if (owners.length === 1) owners[0].tray_ids = app.tray_ids;
			continue;
		}
		result.push({
			name: app.name,
			path: app.path,
			icon: null,
			is_running: true,
			is_background: true,
			all_hwnds: [],
			tray_ids: app.tray_ids,
			executable: app.path.split(/[\\/]/).pop()
		});
	}
	return result;
}
