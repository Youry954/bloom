import { useState, useEffect, useLayoutEffect, useMemo, useRef, memo } from "react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	Search,
	ChevronUp,
	ChevronRight,
	ChevronLeft,
	Power,
	User,
	Moon,
	RotateCcw,
	Lock,
	MoreHorizontal,
	RefreshCw
} from "lucide-react";
import "./Dock.css";
import { EdgeSurface } from "./components/EdgeSurface";
import { initTheme } from "./theme";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";

import { mergeTrayApps, selectDockTrayApps, type AppInfo, type TrayApp } from "./dockApps";
import { driveLetter, hideDrive, removeCustomFolder, type DockExtra } from "./dockExtras";
import {
	computeDockBarRect,
	createRegionSender,
	measureDockPopups,
	measureElements,
	type RegionRect,
	untransformedPopupBox
} from "./dockRegion";

// Host processes (Edge/Chrome/Brave/ApplicationFrameHost) run every PWA/UWP
// window, so their window title must be part of their identity — otherwise two
// PWAs running under the same browser collapse into a single dock item.
const HOST_PROCESSES = ["msedge.exe", "chrome.exe", "brave.exe", "applicationframehost.exe"];
export function isBrowserHost(path: string) {
	const p = path.toLowerCase();
	return HOST_PROCESSES.some((host) => p.includes(host));
}

// Stable identity for a dock item.
export function appIdentity(p: string, executable?: string, name?: string) {
	if (!p) return "";
	const normalized = p.toLowerCase().replace(/\\/g, "/");
	// Shell application ids (AUMIDs) and bare names are unique on their own.
	if (!normalized.includes("/")) return normalized;
	if (name && isBrowserHost(normalized)) {
		return `${normalized}:${name.toLowerCase()}`;
	}
	if (executable) return `${normalized}:${executable.toLowerCase()}`;
	return normalized;
}

const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name);

// WinEvent notifications can arrive for windows that do not change the dock.
// Keep the existing array when its visible content is identical so Framer
// Motion does not restart dock layout work on every notification.
function sameRunningApps(left: AppInfo[], right: AppInfo[]): boolean {
	return (
		left.length === right.length &&
		left.every((app, index) => {
			const next = right[index];
			return (
				app.name === next.name &&
				app.path === next.path &&
				app.icon === next.icon &&
				app.is_running === next.is_running &&
				app.is_background === next.is_background &&
				app.hwnd === next.hwnd &&
				app.executable === next.executable &&
				(app.tray_ids?.join("\0") ?? "") === (next.tray_ids?.join("\0") ?? "") &&
				JSON.stringify(app.all_hwnds ?? []) === JSON.stringify(next.all_hwnds ?? [])
			);
		})
	);
}

// Fuzzy identity: a running window and its installed/pinned entry often carry
// different paths (exe vs .lnk vs AUMID), so exact keys miss and the same app
// looks pinnable twice. Mirrors the dock list's own pinned↔running matching.
export function isSameApp(a: AppInfo, b: AppInfo): boolean {
	if (!a.path || !b.path) return false;
	if (itemKey(a) === itemKey(b)) return true;
	// Browser hosts run many apps under one exe — only the full identity
	// (which folds in the window/AUMID name) can match those.
	if (isBrowserHost(a.path) || isBrowserHost(b.path)) return false;
	const aId = isIdentifier(a.path);
	const bId = isIdentifier(b.path);
	// Two opaque shell ids match only exactly (checked above).
	if (aId && bId) return false;
	if (aId !== bId) {
		const fileSide = aId ? b : a;
		const idLower = (aId ? a : b).path.toLowerCase();
		const na = a.name.toLowerCase();
		const nb = b.name.toLowerCase();
		if (na !== nb && !na.includes(nb) && !nb.includes(na)) return false;
		const stem = (fileSide.executable?.toLowerCase() || fileOf(fileSide.path)).replace(
			/\.(exe|lnk)$/,
			""
		);
		return stem.length >= 3 && idLower.includes(stem);
	}
	if (appIdentity(a.path) === appIdentity(b.path)) return true;
	const normExe = (s: string) => (s.endsWith(".exe") ? s : `${s}.exe`);
	const aExe = a.executable?.toLowerCase() || fileOf(a.path);
	const bExe = b.executable?.toLowerCase() || fileOf(b.path);
	if (!aExe || !bExe) return false;
	return normExe(aExe) === normExe(bExe);
}

const fileOf = (p: string) =>
	(p.split("/").pop()?.split("\\").pop()?.toLowerCase() || "").replace(/\.lnk$/, "");

const isIdentifier = (p: string) => !p.includes("/") && !p.includes("\\");

function cleanBrandIcon(app: AppInfo): string | null {
	const name = app.name.trim().toLowerCase();
	const path = app.path.toLowerCase();
	if (name === "chatgpt" || name === "chat gpt" || /openai\.chatgpt|chatgpt\.exe|chatgpt_/.test(path)) {
		return "/brand-clean-chatgpt.svg";
	}
	if (name === "whatsapp" || /whatsapp\.exe|whatsappdesktop|whatsapp_/.test(path)) {
		return "/brand-clean-whatsapp.svg";
	}
	return null;
}

function TaskViewIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
			<rect x="3.5" y="7.5" width="13" height="13" rx="3" />
			<path d="M8 3.5h9.5a3 3 0 0 1 3 3V16" />
		</svg>
	);
}

function resolveStartIcon(startIcon: string): string {
	if (startIcon === "bloom-colorful") return "/bloom-colorful.png";
	if (startIcon === "bloom-golden") return "/bloom-golden.png";
	if (startIcon === "bloom-biscuit") return "/bloom-biscuit.png";
	if (startIcon === "windows") return "/windows-11.png";
	if (startIcon.startsWith("custom:")) return startIcon.slice("custom:".length);
	return "/bloom.png";
}

const ITEM_ENTRY_TRANSITION = {
	opacity: { duration: 0.15, delay: 0.15 },
	scale: { type: "spring" as const, stiffness: 400, damping: 25, delay: 0.15 }
};
const ITEM_INITIAL = { opacity: 0, scale: 0 };
const ITEM_ANIMATE = { opacity: 1, scale: 1 };
const ITEM_EXIT = { opacity: 0, scale: 0 };

// Elastic "Detach / Stretch" physics for context menus and window previews.
const DETACH_INITIAL = {
	scaleX: 0.3,
	scaleY: 0.1,
	y: 24,
	opacity: 0,
	borderRadius: "32px"
};
const DETACH_ANIMATE = {
	scaleX: 1,
	scaleY: 1,
	y: 0,
	opacity: 1,
	borderRadius: "16px"
};
const DETACH_EXIT = {
	scaleX: 0.35,
	scaleY: 0.12,
	y: 20,
	opacity: 0,
	borderRadius: "28px",
	transition: { duration: 0.14, ease: "easeIn" as const }
};
const DETACH_SPRING = {
	type: "spring" as const,
	stiffness: 380,
	damping: 22,
	mass: 0.8
};

type ActiveDockPanel = "start" | "search" | "tray" | "add" | null;

// One dot per open window, capped at three.
function WindowDots({ count, background }: { count: number; background?: boolean }) {
	return (
		<div
			className="window-dots"
			role="img"
			aria-label={background ? "Running in background" : `${count} open windows`}
		>
			{Array.from({ length: background ? 1 : Math.min(Math.max(count, 1), 3) }, (_, i) => (
				<div key={i} className={`active-indicator${background ? " background-indicator" : ""}`} />
			))}
		</div>
	);
}

const Dock = memo(function Dock() {
	useEffect(() => {
		return initTheme();
	}, []);

	const [pinnedApps, setPinnedApps] = useState<AppInfo[]>([]);
	const [activeApps, setActiveApps] = useState<AppInfo[]>([]);
	const [installedApps, setInstalledApps] = useState<AppInfo[]>([]);
	const [currentUser, setCurrentUser] = useState("Utilisateur");
	const iconsRef = useRef<Record<string, string>>({});
	const [, setIconsTick] = useState(0);
	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("bloom-dock-mode") || "smart";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dockPreviewEnabled, setDockPreviewEnabled] = useState(
		() => localStorage.getItem("bloom-dock-preview-enabled") !== "false"
	);
	const [dockIconOnly, setDockIconOnly] = useState(
		() => localStorage.getItem("bloom-dock-icon-only") === "true"
	);
	const [dockSeparatorEnabled, setDockSeparatorEnabled] = useState(
		() => localStorage.getItem("bloom-dock-separator-enabled") !== "false"
	);
	const [dockAdaptive, setDockAdaptive] = useState(
		() => localStorage.getItem("bloom-dock-adaptive") === "true"
	);
	const [dockTaskView, setDockTaskView] = useState(
		() => localStorage.getItem("bloom-dock-task-view") === "true"
	);
	const [startIcon, setStartIcon] = useState(
		() => localStorage.getItem("bloom-start-icon") || "default"
	);
	const [dockExtrasPosition, setDockExtrasPosition] = useState(
		() => localStorage.getItem("bloom-dock-extras-position") || "off"
	);
	const [dockExtras, setDockExtras] = useState<DockExtra[]>([]);
	const [dockExtrasRevision, setDockExtrasRevision] = useState(0);
	const [isMaximized, setIsMaximized] = useState(false);
	const [previewData, setPreviewData] = useState<{
		id: string;
		previews: { hwnd: number; title: string; image: string }[];
	} | null>(null);
	const [isDockHovered, setIsDockHovered] = useState(false);
	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [isVisible, setIsVisible] = useState(true);
	const [activePanel, setActivePanel] = useState<ActiveDockPanel>(null);
	const [trayItems, setTrayItems] = useState<TrayApp[]>([]);
	const [trayIcons, setTrayIcons] = useState<Record<string, string>>({});
	const [trayLoading, setTrayLoading] = useState(false);
	const [nativeMenuOpen, setNativeMenuOpen] = useState(false);
	const [detachingId, setDetachingId] = useState<string | null>(null);
	const detachTimerRef = useRef<any>(null);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		app: AppInfo | null;
		extra?: DockExtra | null;
		taskView?: boolean;
	} | null>(null);
	const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
	const [activeOrder, setActiveOrder] = useState<string[]>([]);
	const observedTrayPathsRef = useRef(new Set<string>());
	const [isDragging, setIsDragging] = useState(false);
	const [hoveredApp, setHoveredApp] = useState<string | null>(null);
	const [pressedApp, setPressedApp] = useState<string | null>(null);
	const [isReady, setIsReady] = useState(false);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);
	const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
	const [toast, setToast] = useState<string | null>(null);
	const iconPickerTargetRef = useRef<string | null>(null);
	const toastTimerRef = useRef<any>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	const barRowRef = useRef<HTMLDivElement>(null);
	const islandPanelRef = useRef<HTMLDivElement>(null);
	const pinnedItemsRef = useRef<AppInfo[]>([]);
	const handleAppClickRef = useRef<(app: AppInfo) => void>(() => {});
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("bloom-scale") || "1.0")
	);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);

	useEffect(() => {
		const onResize = () => {
			setViewportWidth(window.innerWidth);
			setViewportHeight(window.innerHeight);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// Enable real keyboard focus on the Dock window when a Dynamic Island panel with an input is open.
	useEffect(() => {
		const needsFocus = activePanel === "start" || activePanel === "search" || activePanel === "add";
		if (!needsFocus) return;
		let mounted = true;
		invoke("set_dock_popup_focus", { active: true })
			.then(() => {
				if (mounted) {
					setTimeout(() => {
						document.querySelector<HTMLInputElement>(".popup-search-input")?.focus();
					}, 30);
				}
			})
			.catch((error) => console.error("Could not focus dock panel:", error));
		return () => {
			mounted = false;
			invoke("set_dock_popup_focus", { active: false }).catch(() => {});
		};
	}, [activePanel]);

	const isCurrentlyHovered = isDockHovered || isEdgeHovered;
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const isAnyInteraction =
		isCurrentlyHovered ||
		!!contextMenu ||
		activePanel !== null ||
		nativeMenuOpen;

	const previewTimerRef = useRef<any>(null);
	const isPreviewHoveredRef = useRef(false);
	const hoveredAppRef = useRef<string | null>(null);

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	const isHidden =
		!startupAnimating &&
		((dockMode === "smart" && isOverlapped && interactionState === "none") ||
			(dockMode === "peek" && interactionState === "none"));

	// 100% full-width taskbar with 0px gap when a window is maximized or occupies the work area.
	const isDockedExpanded =
		(isMaximized || (dockMode === "fixed" && isOverlapped)) &&
		isExpanded &&
		!isHidden &&
		isVisible;

	const isAdaptive =
		dockAdaptive && dockMode === "fixed" && isMaximized && isExpanded && !isHidden && isVisible;

	// Exact 100vw pre-scale width so visual width after `scale` transform is 100% of viewportWidth with 0px left/right gap.
	const fullScreenWidth = Math.ceil(viewportWidth / (scale || 1));

	useEffect(() => {
		let cleared = false;

		const checkVisibility = async (): Promise<boolean> => {
			try {
				const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
				const visible = await getCurrentWebviewWindow().isVisible();
				if (visible) {
					setStartupAnimating(true);
					setIsReady(true);
					setTimeout(() => setIsImpacted(true), 280);
					setTimeout(() => setIsExpanded(true), 350);
					setTimeout(() => setStartupAnimating(false), 1500);
					return true;
				}
			} catch (_) {}
			return false;
		};

		const interval = setInterval(async () => {
			if (cleared) return;
			if (await checkVisibility()) {
				clearInterval(interval);
				cleared = true;
			}
		}, 200);

		checkVisibility().then((ok) => {
			if (ok) {
				clearInterval(interval);
				cleared = true;
			}
		});

		return () => {
			clearInterval(interval);
			cleared = true;
		};
	}, []);

	useEffect(() => {
		const updateRect = () => {
			if (dockRef.current) {
				const rect = dockRef.current.getBoundingClientRect();
				const hasPreview = !!previewData;
				invoke("update_dock_rect", {
					rect: {
						x: Math.round(rect.x) - (hasPreview ? 500 : 0),
						y: Math.round(rect.y) - (hasPreview ? 320 : 0),
						width: Math.round(rect.width) + (hasPreview ? 1000 : 0),
						height: Math.round(rect.height) + (hasPreview ? 320 : 0)
					}
				}).catch(() => {});
			}
		};

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (dockRef.current) observer.observe(dockRef.current);

		let rafId = 0;
		const start = performance.now();
		const tick = (now: number) => {
			updateRect();
			if (now - start < 520) {
				rafId = requestAnimationFrame(tick);
			}
		};
		rafId = requestAnimationFrame(tick);

		return () => {
			cancelAnimationFrame(rafId);
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [
		pinnedApps,
		activeApps,
		isHidden,
		isExpanded,
		isDockedExpanded,
		isAdaptive,
		activePanel,
		previewData,
		scale
	]);

	useEffect(() => {
		const init = async () => {
			const settings: any = await invoke("load_settings").catch(() => ({}));
			if (await reloadIfMirrorWasStale(settings)) return;
			const getVal = (key: string, fallback: string | null = null) => {
				const val = settings[key];
				if (val !== undefined && val !== null) return String(val);
				const local = localStorage.getItem(key);
				if (local !== null) return local;
				return fallback;
			};

			const dMode = getVal("bloom-dock-mode", "smart");
			if (dMode) {
				const mapped = dMode === "auto-hide" ? "smart" : dMode;
				setDockMode(mapped);
			}

			const preview = getVal("bloom-dock-preview-enabled", "true");
			setDockPreviewEnabled(preview === "true");

			const iconOnly = getVal("bloom-dock-icon-only", "false");
			setDockIconOnly(iconOnly === "true");

			const separator = getVal("bloom-dock-separator-enabled", "true");
			setDockSeparatorEnabled(separator === "true");

			const adaptive = getVal("bloom-dock-adaptive", "false");
			setDockAdaptive(adaptive === "true");
			setDockTaskView(getVal("bloom-dock-task-view", "false") === "true");

			const startIconVal = getVal("bloom-start-icon", "default") || "default";
			setStartIcon(startIconVal);

			const extrasPosition = getVal("bloom-dock-extras-position", "off");
			if (extrasPosition) setDockExtrasPosition(extrasPosition);

			const scaleVal = getVal("bloom-scale");
			if (scaleVal !== null) setScale(parseFloat(scaleVal));

			const pinned = await invoke<AppInfo[]>("load_pinned_apps");
			setPinnedApps(pinned.map((a) => ({ ...a, is_pinned: true })));
			pinned.forEach((app) => fetchIcon(app.path));

			invoke<string>("get_current_user")
				.then((u) => {
					if (u) setCurrentUser(u);
				})
				.catch(() => {});

			invoke<AppInfo[]>("get_installed_apps")
				.then((apps) => {
					setInstalledApps(apps.sort((a, b) => a.name.localeCompare(b.name)));
				})
				.catch(() => {});

			try {
				const icons = await invoke<Record<string, string>>("get_custom_icons");
				setCustomIcons(icons);
			} catch (_) {}
		};
		init();

		const unlistenInstalledApps = listen("installed-apps-updated", async () => {
			try {
				const [refreshed, allInstalled] = await Promise.all([
					invoke<AppInfo[]>("load_pinned_apps"),
					invoke<AppInfo[]>("get_installed_apps").catch(() => [] as AppInfo[])
				]);
				if (allInstalled.length > 0) {
					setInstalledApps(allInstalled.sort((a, b) => a.name.localeCompare(b.name)));
				}
				const names = new Map(refreshed.map((a) => [a.path, a.name]));
				setPinnedApps((prev) => {
					const next = prev.map((a) => ({ ...a, name: names.get(a.path) ?? a.name }));
					if (!next.some((a, i) => a.name !== prev[i].name)) return prev;
					queueMicrotask(() => {
						invoke("save_pinned_apps", { apps: next }).catch(console.error);
					});
					return next;
				});
			} catch (_) {}
		});

		const unlistenOverlap = listen<boolean>("dock-overlap", (event) => {
			setIsOverlapped(event.payload);
		});

		const unlistenEdgeHover = listen<boolean>("dock-edge-hover", (event) => {
			setIsEdgeHovered(event.payload);
		});

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenMaximized = listen<boolean>("dock-maximized", (event) => {
			setIsMaximized(event.payload);
		});

		return () => {
			unlistenOverlap.then((f) => f());
			unlistenInstalledApps.then((f) => f());
			unlistenEdgeHover.then((f) => f());
			unlistenVisibility.then((f) => f());
			unlistenMaximized.then((f) => f());
		};
	}, []);

	useSettingsSync({
		"bloom-dock-mode": setDockMode,
		"bloom-dock-preview-enabled": setDockPreviewEnabled,
		"bloom-dock-icon-only": setDockIconOnly,
		"bloom-dock-separator-enabled": setDockSeparatorEnabled,
		"bloom-dock-adaptive": setDockAdaptive,
		"bloom-dock-task-view": setDockTaskView,
		"bloom-start-icon": setStartIcon,
		"bloom-scale": setScale,
		"bloom-dock-extras-position": setDockExtrasPosition,
		"bloom-dock-extras-drives": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-recycle-bin": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-hidden-drives": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-folders": () => setDockExtrasRevision((r) => r + 1),
		"bloom-dock-extras-custom-folders": () => setDockExtrasRevision((r) => r + 1)
	});

	useEffect(() => {
		if (dockExtrasPosition === "off") {
			setDockExtras([]);
			return;
		}
		let stopped = false;
		let loadSeq = 0;
		const load = async () => {
			const seq = ++loadSeq;
			try {
				const extras = await invoke<DockExtra[]>("get_dock_extras");
				if (!stopped && seq === loadSeq) setDockExtras(extras);
			} catch (e) {
				console.error("Failed to load dock extras:", e);
			}
		};
		load();

		const interval = setInterval(load, 10000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [dockExtrasPosition, dockExtrasRevision]);

	useEffect(() => {
		let pollSeq = 0;
		let stopped = false;

		const poll = async () => {
			if (isDragging) return;
			const seq = ++pollSeq;
			let windows: AppInfo[];
			let tray: TrayApp[];
			try {
				[windows, tray] = await Promise.all([
					invoke<AppInfo[]>("get_active_windows"),
					invoke<TrayApp[]>("get_tray_apps").catch(() => [])
				]);
			} catch (error) {
				console.error("Failed to refresh dock apps:", error);
				return;
			}
			if (stopped || seq !== pollSeq) return;
			setTrayItems(tray.filter((app) => app.tray_ids.length > 0));
			const selected = selectDockTrayApps(windows, tray, observedTrayPathsRef.current, (app) =>
				pinnedApps.some((pinned) =>
					isSameApp(pinned, {
						name: app.name,
						path: app.path,
						icon: app.icon ?? null,
						is_running: true,
						executable: fileOf(app.path)
					})
				)
			);
			observedTrayPathsRef.current = selected.observed;
			const running = mergeTrayApps(windows, selected.visible);
			setActiveApps((prev) => (sameRunningApps(prev, running) ? prev : running));

			setActiveOrder((prev) => {
				const newPaths = running.map((r) => appIdentity(r.path, r.executable, r.name));
				const existingPaths = prev.filter((p) => newPaths.includes(p));
				const addedPaths = newPaths.filter((p) => !prev.includes(p));
				const next = [...existingPaths, ...addedPaths];
				return next.length === prev.length && next.every((path, i) => path === prev[i])
					? prev
					: next;
			});

			running.forEach((app) => fetchIcon(app.path, app.name, app.hwnd));
		};

		poll();

		const unlistenWindowChange = listen("windows-changed", () => {
			poll();
		});

		const interval = setInterval(poll, 10000);

		return () => {
			stopped = true;
			clearInterval(interval);
			unlistenWindowChange.then((f) => f());
		};
	}, [isDragging, pinnedApps]);

	const fetchIcon = async (path: string, name?: string, hwnd?: number, retryCount = 0) => {
		const isHost = isBrowserHost(path);
		const cacheKey =
			isHost && name ? `${path}:${name.toLowerCase()}` : hwnd ? `${path}-${hwnd}` : path;

		if (iconsRef.current[cacheKey]) return;
		try {
			const icon = await invoke<string | null>("get_app_icon", {
				path,
				name: name || null,
				hwnd: hwnd || null
			});
			if (icon) {
				iconsRef.current[cacheKey] = icon;
				if (!isHost) iconsRef.current[path] = icon;
				setIconsTick((t) => t + 1);
			} else if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		} catch (e) {
			console.error(`Failed to fetch icon for ${path}:`, e);
			if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		}
	};

	const handleClearIconCache = async () => {
		try {
			await invoke("clear_icon_cache");
			iconsRef.current = {};
			setIconsTick((t) => t + 1);
			pinnedApps.forEach((app) => fetchIcon(app.path));
		} catch (e) {
			console.error("Failed to clear icon cache:", e);
		}
	};

	const handleIconFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		const target = iconPickerTargetRef.current;
		if (!file || !target) return;

		const reader = new FileReader();
		reader.onload = async () => {
			const dataUri = reader.result as string;
			try {
				const newIcon = await invoke<string>("set_custom_icon", {
					cacheKey: target,
					iconData: dataUri
				});
				setCustomIcons((prev) => ({ ...prev, [target]: newIcon }));
			} catch (err) {
				const msg = typeof err === "string" ? err : "Failed to set icon";
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
				setToast(msg);
				toastTimerRef.current = setTimeout(() => setToast(null), 4000);
			}
		};
		reader.readAsDataURL(file);
		e.target.value = "";
	};

	const handleRemoveCustomIcon = async (app: AppInfo) => {
		try {
			await invoke("remove_custom_icon", { path: app.path, name: app.name || null });
			const isHost = isBrowserHost(app.path);
			const ck =
				isHost && app.name
					? `${app.path}:${app.name.toLowerCase()}`
					: app.hwnd
						? `${app.path}-${app.hwnd}`
						: app.path;
			setCustomIcons((prev) => {
				const next = { ...prev };
				delete next[ck];
				delete next[app.path];
				return next;
			});
			delete iconsRef.current[ck];
			delete iconsRef.current[app.path];
			if (app.hwnd) delete iconsRef.current[`${app.path}-${app.hwnd}`];
			setIconsTick((t) => t + 1);
			fetchIcon(app.path, app.name, app.hwnd);
		} catch (err) {
			console.error("Failed to remove custom icon:", err);
		}
	};

	const handleClosePreview = async (e: React.MouseEvent, hwnd: number) => {
		e.stopPropagation();
		try {
			await invoke("close_window", { hwnd });
			setPreviewData((prev) => {
				if (!prev) return null;
				const remaining = prev.previews.filter((p) => p.hwnd !== hwnd);
				if (remaining.length === 0) {
					setHoveredApp(null);
					return null;
				}
				return { ...prev, previews: remaining };
			});
		} catch (err) {
			console.error("Failed to close window:", err);
		}
	};

	const toggleDockPanel = (panel: Exclude<ActiveDockPanel, null>) => {
		setContextMenu(null);
		setActiveSubmenu(null);
		setPreviewData(null);
		setActivePanel((current) => (current === panel ? null : panel));
	};

	const handleAppClick = async (app: AppInfo) => {
		try {
			if (app.path === "start") {
				toggleDockPanel("start");
			} else if (app.is_background && app.tray_ids?.length === 1) {
				await invoke("activate_tray_icon", { trayId: app.tray_ids[0] });
			} else if (app.all_hwnds && app.all_hwnds.length > 1) {
				await invoke("focus_app_windows", { hwnds: app.all_hwnds.map(([hwnd]) => hwnd) });
			} else if (app.hwnd) {
				await invoke("focus_window", { hwnd: app.hwnd });
			} else {
				await invoke("open_app", { appName: app.path });
			}
		} catch (e) {
			console.error(`Failed to interact with ${app.name}:`, e);
			showActionError(e);
		}
	};

	const handleNewInstance = async (app: AppInfo) => {
		if (!app || app.path === "start") return;
		try {
			await invoke("launch_new_instance", { appPath: app.path, appName: app.name });
		} catch (e) {
			console.error(`Failed to launch a new instance of ${app.name}:`, e);
		}
	};

	const handleMiddleClick = (e: React.MouseEvent, app: AppInfo) => {
		if (e.button !== 1) return;
		e.preventDefault();
		e.stopPropagation();
		handleNewInstance(app);
	};

	const togglePin = async (app: AppInfo) => {
		let newPinned;
		if (app.is_pinned) {
			newPinned = pinnedApps.filter((a) => itemKey(a) !== itemKey(app));
		} else {
			if (pinnedApps.some((a) => isSameApp(a, app))) return;
			newPinned = [...pinnedApps, { ...app, is_pinned: true, is_running: false, hwnd: undefined }];
			fetchIcon(app.path, app.name);
		}
		setPinnedApps(newPinned);
		await invoke("save_pinned_apps", { apps: newPinned });
		closeMenu();
	};

	const menuRef = useRef<HTMLDivElement>(null);

	const triggerDetachEffect = (id: string) => {
		if (detachTimerRef.current) clearTimeout(detachTimerRef.current);
		setDetachingId(id);
		detachTimerRef.current = setTimeout(() => setDetachingId(null), 320);
	};

	const showActionError = (error: unknown) => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToast(typeof error === "string" ? error : "Could not complete this action.");
		toastTimerRef.current = setTimeout(() => setToast(null), 5000);
	};

	const openTrayMenu = async (trayId: string) => {
		setNativeMenuOpen(true);
		closeMenu();
		setPreviewData(null);
		try {
			await invoke("show_tray_context_menu", { trayId });
		} catch (error) {
			showActionError(error);
		} finally {
			setNativeMenuOpen(false);
		}
	};

	const handleContextMenu = (e: React.MouseEvent, app: AppInfo | null) => {
		e.stopPropagation();
		e.preventDefault();
		if (app && app.path !== "start") triggerDetachEffect(itemKey(app));
		setContextMenu({ x: e.clientX, y: e.clientY, app });
	};

	const handleExtraClick = (extra: DockExtra) => {
		triggerDetachEffect(extra.id);
		invoke("open_dock_extra", { kind: extra.kind, path: extra.path }).catch(showActionError);
	};

	const handleExtraContextMenu = (e: React.MouseEvent, extra: DockExtra) => {
		e.stopPropagation();
		e.preventDefault();
		triggerDetachEffect(extra.id);
		setContextMenu({ x: e.clientX, y: e.clientY, app: null, extra });
	};

	const ejectExtra = (extra: DockExtra) => {
		closeMenu();
		invoke("eject_dock_extra", { path: extra.path }).catch(showActionError);
	};

	const removeExtraFromDock = (extra: DockExtra) => {
		const next = removeCustomFolder(
			localStorage.getItem("bloom-dock-extras-custom-folders"),
			extra.path
		);
		localStorage.setItem("bloom-dock-extras-custom-folders", next);
		invoke("save_setting", {
			key: "bloom-dock-extras-custom-folders",
			value: next
		}).catch(console.error);
		closeMenu();
	};

	const hideDriveFromDock = (extra: DockExtra) => {
		const letter = driveLetter(extra);
		if (!letter) return;
		const next = hideDrive(localStorage.getItem("bloom-dock-extras-hidden-drives"), letter);
		localStorage.setItem("bloom-dock-extras-hidden-drives", next);
		invoke("save_setting", { key: "bloom-dock-extras-hidden-drives", value: next }).catch(
			showActionError
		);
		closeMenu();
	};

	const openTaskView = () => {
		triggerDetachEffect("task-view");
		invoke("open_system_action", { action: "task-view" }).catch(showActionError);
	};

	const hideTaskView = () => {
		setDockTaskView(false);
		localStorage.setItem("bloom-dock-task-view", "false");
		invoke("save_setting", { key: "bloom-dock-task-view", value: "false" }).catch(
			showActionError
		);
		closeMenu();
	};

	const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!contextMenu || !menuRef.current) {
			setMenuPos(null);
			return;
		}
		const margin = 8;
		const el = menuRef.current;
		const r = el.getBoundingClientRect();
		const fullW = Math.max(r.width, (el.offsetWidth || 180) * scale);
		const fullH = Math.max(r.height, (el.offsetHeight || 160) * scale);
		setMenuPos({
			left: Math.max(margin, Math.min(contextMenu.x, window.innerWidth - fullW - margin)),
			top: Math.max(margin, contextMenu.y - fullH - margin)
		});
	}, [contextMenu, scale]);

	const closeMenu = () => {
		setContextMenu(null);
		setActiveSubmenu(null);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => {});
	};

	const closePopup = () => {
		setActivePanel(null);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => {});
	};

	// Refresh live Windows notification icons whenever the Tray Dynamic Island panel is open.
	useEffect(() => {
		if (activePanel !== "tray") return;
		let active = true;
		const load = async () => {
			try {
				const items = await invoke<TrayApp[]>("get_tray_apps");
				if (!active) return;
				setTrayItems(items.filter((app) => app.tray_ids.length > 0));
				setTrayLoading(false);
				const uniquePaths = [...new Set(items.filter((a) => !a.icon).map((app) => app.path))];
				if (uniquePaths.length > 0) {
					const icons = await Promise.all(
						uniquePaths.map(async (path) => {
							try {
								return [path, await invoke<string | null>("get_app_icon", { path })] as const;
							} catch {
								return [path, null] as const;
							}
						})
					);
					if (active) {
						setTrayIcons((prev) => ({
							...prev,
							...Object.fromEntries(
								icons.filter((pair): pair is readonly [string, string] => !!pair[1])
							)
						}));
					}
				}
			} catch (error) {
				if (active) {
					setTrayLoading(false);
					console.error("Could not enumerate system tray apps:", error);
					showActionError(error);
				}
			}
		};
		setTrayLoading(true);
		load();
		const interval = setInterval(load, 4000);
		return () => {
			active = false;
			clearInterval(interval);
		};
	}, [activePanel]);

	useEffect(() => {
		const unlisten = listen("dock-dismiss-menu", () => {
			setContextMenu(null);
			setActiveSubmenu(null);
			setActivePanel(null);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	const dockItems = useMemo(() => {
		const runningMap = new Map();
		activeApps.forEach((a) => {
			const id = appIdentity(a.path, a.executable, a.name);
			if (!runningMap.has(id)) runningMap.set(id, a);
		});

		const matchedRunningKeys = new Set<string>();

		const findRunningApp = (p: AppInfo) => {
			const id = appIdentity(p.path, p.executable, p.name);
			let running = runningMap.get(id);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			const pathId = appIdentity(p.path);
			running = runningMap.get(pathId);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			if (p.executable) {
				const targetExe = p.executable.toLowerCase();
				const found = activeApps.find(
					(a) => !isIdentifier(a.path) && a.executable?.toLowerCase() === targetExe
				);
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			const pinFilename = p.path.split("/").pop()?.split("\\").pop()?.toLowerCase() || "";
			if (pinFilename) {
				const found = activeApps.find((a) => {
					if (isIdentifier(a.path)) return false;
					const runExe =
						a.executable?.toLowerCase() ||
						a.path.split("/").pop()?.split("\\").pop()?.toLowerCase() ||
						"";
					return (
						runExe === pinFilename ||
						runExe === `${pinFilename}.exe` ||
						`${runExe}.exe` === pinFilename
					);
				});
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			const equivalent = activeApps.find(
				(app) => !matchedRunningKeys.has(itemKey(app)) && isSameApp(p, app)
			);
			if (equivalent) {
				matchedRunningKeys.add(itemKey(equivalent));
				return equivalent;
			}
			return undefined;
		};

		const pinned: AppInfo[] = [
			{
				name: "Démarrer",
				path: "start",
				icon: null,
				is_running: false,
				is_pinned: true,
				hwnd: undefined,
				all_hwnds: undefined,
				executable: undefined
			},
			...pinnedApps.map((p) => {
				const running = findRunningApp(p);
				return {
					...p,
					is_running: !!running,
					hwnd: running?.hwnd,
					all_hwnds: running?.all_hwnds,
					tray_ids: running?.tray_ids,
					is_background: running?.is_background
				};
			})
		];

		const unpinned = activeOrder
			.map((id) => activeApps.find((a) => appIdentity(a.path, a.executable, a.name) === id))
			.filter(
				(a): a is AppInfo =>
					!!a && !matchedRunningKeys.has(appIdentity(a.path, a.executable, a.name))
			);

		return [...pinned, ...unpinned];
	}, [pinnedApps, activeApps, activeOrder]);

	const startItem = useMemo(
		() => dockItems.find((i) => i.path === "start") as AppInfo,
		[dockItems]
	);
	const pinnedItems = useMemo(
		() => dockItems.filter((i) => i.path !== "start" && i.is_pinned),
		[dockItems]
	);
	const unpinnedItems = useMemo(() => dockItems.filter((i) => !i.is_pinned), [dockItems]);

	// Dynamic Island target dimensions when a panel is open inside the Dock container.
	const naturalBarWidth = useMemo(() => {
		const count = pinnedItems.length + unpinnedItems.length + dockExtras.length + (dockTaskView ? 1 : 0);
		return Math.max(360, 210 + count * 44);
	}, [pinnedItems.length, unpinnedItems.length, dockExtras.length, dockTaskView]);

	const maxAvailableHeight = Math.max(340, Math.floor((viewportHeight - 16) / (scale || 1)));

	const islandTarget = useMemo(() => {
		if (!activePanel) return null;
		if (activePanel === "start") {
			return {
				width: Math.max(600, naturalBarWidth),
				height: Math.min(540, maxAvailableHeight)
			};
		}
		if (activePanel === "search") {
			return {
				width: Math.max(560, naturalBarWidth),
				height: Math.min(490, maxAvailableHeight)
			};
		}
		if (activePanel === "tray") {
			return {
				width: Math.max(430, naturalBarWidth),
				height: Math.min(340, maxAvailableHeight)
			};
		}
		return {
			width: Math.max(480, naturalBarWidth),
			height: Math.min(470, maxAvailableHeight)
		};
	}, [activePanel, naturalBarWidth, maxAvailableHeight]);

	const dockBandHeightRef = useRef(0);
	const sendDockRegion = useMemo(
		() =>
			createRegionSender((rects) => {
				invoke("set_window_region", { rects }).catch(() => {});
			}),
		[]
	);

	// Synchronize SetWindowRgn with the Dock bar (including 100% full-width taskbar
	// and upward Dynamic Island expansion).
	const computeAndSendDockRegion = () => {
		const bar = dockRef.current?.getBoundingClientRect();
		if (bar && isExpanded && !isHidden && isVisible) {
			dockBandHeightRef.current = Math.max(dockBandHeightRef.current, Math.min(bar.height, 90));
		}
		const liftRoom = 56 * scale;
		const wanted: RegionRect[] = [];

		if (bar && isExpanded && !isHidden && isVisible && !startupAnimating) {
			wanted.push(
				...computeDockBarRect({
					windowWidth: window.innerWidth,
					windowHeight: window.innerHeight,
					dockRect: {
						x: bar.left,
						y: bar.top - liftRoom,
						width: bar.width,
						height: bar.height + liftRoom
					},
					isVisible,
					isExpanded,
					isHidden,
					isDockedExpanded: isDockedExpanded || isAdaptive,
					adaptiveWidth: isDockedExpanded || isAdaptive,
					dockPad: isDockedExpanded ? 20 : 16
				})
			);
		} else {
			const band = (dockBandHeightRef.current || 72 * scale) + 64 * scale;
			wanted.push({ x: 0, y: window.innerHeight - band, width: window.innerWidth, height: band });
		}

		// When a Dynamic Island panel is open or opening, immediately include its full target box
		// in SetWindowRgn so every button/input inside the stretched Dock is clickable right away.
		if (islandTarget) {
			const targetW = islandTarget.width * scale + 32;
			const targetH = islandTarget.height * scale + 32;
			wanted.push({
				x: Math.max(0, Math.round((window.innerWidth - targetW) / 2)),
				y: Math.max(0, Math.round(window.innerHeight - targetH)),
				width: Math.min(window.innerWidth, Math.round(targetW)),
				height: Math.min(window.innerHeight, Math.round(targetH))
			});
		}

		if (isDragging) {
			wanted.push({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
		}
		wanted.push(
			...measureElements([
				[".preview-tooltip", 40],
				[".context-menu", 34],
				[".submenu", 34],
				[".dock-toast", 20]
			]),
			...measureDockPopups(undefined, scale)
		);

		sendDockRegion(wanted);
	};

	useEffect(() => {
		computeAndSendDockRegion();
	});

	useEffect(() => {
		let rafId = 0;
		const start = performance.now();
		const step = (now: number) => {
			computeAndSendDockRegion();
			if (now - start < 520) {
				rafId = requestAnimationFrame(step);
			}
		};
		rafId = requestAnimationFrame(step);
		return () => cancelAnimationFrame(rafId);
	}, [
		isDockedExpanded,
		isAdaptive,
		isExpanded,
		isHidden,
		activePanel,
		contextMenu,
		scale,
		viewportWidth,
		viewportHeight
	]);

	useEffect(() => {
		let open = false;
		let rect = null;

		if (contextMenu && menuRef.current) {
			const el = menuRef.current;
			const r = el.getBoundingClientRect();
			const fullW = Math.max(r.width, (el.offsetWidth || 180) * scale);
			const fullH = Math.max(r.height, (el.offsetHeight || 160) * scale);
			const box = untransformedPopupBox(
				{ x: r.left, y: r.top, width: r.width, height: r.height },
				fullW + (activeSubmenu ? 160 : 0),
				fullH,
				10
			);
			rect = {
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(box.width),
				height: Math.round(box.height)
			};
			open = true;
		} else if (islandTarget && dockRef.current) {
			const r = dockRef.current.getBoundingClientRect();
			const targetW = Math.max(r.width, islandTarget.width * scale);
			const targetH = Math.max(r.height, islandTarget.height * scale);
			const x = Math.round(Math.min(r.left, (window.innerWidth - targetW) / 2) - 12);
			const y = Math.round(Math.min(r.top, window.innerHeight - targetH) - 12);
			rect = {
				x: Math.max(0, x),
				y: Math.max(0, y),
				width: Math.round(targetW + 24),
				height: Math.round(targetH + 24)
			};
			open = true;
		}

		invoke("set_menu_open", { open, rect }).catch(() => {});
	}, [
		contextMenu,
		menuPos,
		activePanel,
		islandTarget,
		trayItems,
		pinnedApps,
		activeApps,
		activeSubmenu,
		scale
	]);

	useEffect(() => {
		pinnedItemsRef.current = pinnedItems;
		handleAppClickRef.current = handleAppClick;
	});

	useEffect(() => {
		const unlisten = listen<number>("dock-win-number", (event) => {
			const app = pinnedItemsRef.current[event.payload];
			if (app) handleAppClickRef.current(app);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	const handleReorder = (newKeys: string[]) => {
		const oldKeys = pinnedApps.map(itemKey);
		if (JSON.stringify(newKeys) !== JSON.stringify(oldKeys)) {
			const reordered = newKeys
				.map((key) => pinnedApps.find((p) => itemKey(p) === key))
				.filter((p): p is AppInfo => !!p);
			setPinnedApps(reordered);
		}
	};

	const handleDragEnd = () => {
		setIsDragging(false);
		setPressedApp(null);
		invoke("save_pinned_apps", { apps: pinnedApps }).catch(console.error);
	};

	useEffect(() => {
		invoke("set_dock_hovered", { hovered: isDockHovered }).catch(() => {});
	}, [isDockHovered]);

	useEffect(() => {
		const handleBlur = () => {
			closeMenu();
			closePopup();
		};
		window.addEventListener("blur", handleBlur);
		return () => window.removeEventListener("blur", handleBlur);
	}, []);

	useEffect(() => {
		if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		isPreviewHoveredRef.current = false;
		hoveredAppRef.current = hoveredApp;

		if (!hoveredApp || activePanel !== null) {
			const timer = setTimeout(() => setPreviewData(null), 100);
			return () => clearTimeout(timer);
		}

		if (hoveredApp && !isDragging) {
			const app = dockItems.find((a) => itemKey(a) === hoveredApp);
			if (app && app.is_running && !app.is_background) {
				const hwndsToCapture = app.all_hwnds || (app.hwnd ? [[app.hwnd, app.name]] : []);

				previewTimerRef.current = setTimeout(async () => {
					try {
						const results = await Promise.all(
							hwndsToCapture.map(async ([hwnd, title]) => {
								try {
									const res = await invoke<[string, number] | null>("capture_window_thumbnail", {
										hwnd,
										maxWidth: 320,
										maxHeight: 200
									});
									if (res) {
										const [image, lastFocused] = res;
										return { hwnd, title, image, lastFocused };
									}
								} catch {}
								return null;
							})
						);

						const captured = results
							.filter(
								(r): r is { hwnd: number; title: string; image: string; lastFocused: number } =>
									r !== null
							)
							.sort((a, b) => b.lastFocused - a.lastFocused)
							.map(({ hwnd, title, image }) => ({ hwnd, title, image }));

						const currentHovered = hoveredAppRef.current;
						if (captured.length > 0 && currentHovered === itemKey(app)) {
							setPreviewData({ id: itemKey(app), previews: captured });
						} else if (currentHovered === itemKey(app)) {
							setPreviewData(null);
						}
					} catch (e) {
						console.error("Failed to capture thumbnails:", e);
						setPreviewData(null);
					}
				}, 300);
			} else {
				setPreviewData(null);
			}
		}

		return () => {
			if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		};
	}, [hoveredApp, isDragging, dockItems, activePanel]);

	const iconVariants = {
		idle: { y: 0, scaleX: 1, scaleY: 1, scale: 1 },
		hover: {
			y: -5,
			scaleX: 1.06,
			scaleY: 1.1,
			scale: 1,
			transition: { type: "spring" as const, stiffness: 420, damping: 20 }
		},
		drag: { y: -10, scaleX: 1.08, scaleY: 1.08, scale: 1.1, opacity: 0.8 },
		tap: {
			y: 2,
			scaleX: 1.18,
			scaleY: 0.82,
			scale: 0.96,
			transition: { type: "spring" as const, stiffness: 520, damping: 18 }
		},
		detach: {
			y: -7,
			scaleX: 0.88,
			scaleY: 1.22,
			scale: 1,
			transition: { type: "spring" as const, stiffness: 380, damping: 16, mass: 0.7 }
		}
	};

	const renderExtra = (extra: DockExtra) => (
		<motion.div
			key={extra.id}
			layout
			initial={{ opacity: 0, scale: 0 }}
			animate={{ opacity: 1, scale: 1 }}
			exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
			className="dock-icon-wrapper"
			onContextMenu={(e) => handleExtraContextMenu(e, extra)}
			onMouseEnter={() => setHoveredApp(extra.id)}
			onMouseLeave={() => {
				setHoveredApp(null);
				setPressedApp(null);
			}}
			onMouseDown={(e) => {
				if (e.button === 1) e.preventDefault();
			}}
			onClick={(e) => {
				e.stopPropagation();
				handleExtraClick(extra);
			}}
		>
			{hoveredApp === extra.id && <div className="tooltip">{extra.name}</div>}
			<motion.div
				className="dock-icon"
				variants={iconVariants}
				animate={
					detachingId === extra.id
						? "detach"
						: pressedApp === extra.id
							? "tap"
							: hoveredApp === extra.id
								? "hover"
								: "idle"
				}
				onPointerDown={() => setPressedApp(extra.id)}
				onPointerUp={() => setPressedApp(null)}
				onPointerCancel={() => setPressedApp(null)}
			>
				{extra.icon ? (
					<img src={extra.icon} alt={extra.name} draggable={false} />
				) : (
					<div className="fallback-icon">{extra.name[0]}</div>
				)}
			</motion.div>
		</motion.div>
	);

	const isFullWidthTaskbar = (isDockedExpanded || isAdaptive) && activePanel === null;
	const targetDockWidth =
		!isExpanded || isHidden || !isVisible
			? 34
			: islandTarget
				? islandTarget.width
				: isFullWidthTaskbar
					? fullScreenWidth
					: "auto";
	const targetDockHeight =
		!isExpanded || isHidden || !isVisible
			? 34
			: islandTarget
				? islandTarget.height
				: 52;
	const targetTopRadius =
		!isImpacted && !isExpanded
			? 17
			: isHidden || !isVisible
				? 17
				: islandTarget
					? 22
					: isFullWidthTaskbar
						? 0
						: 18;

	return (
		<div
			className={`dock-container ${isDragging ? "dragging" : ""} ${isFullWidthTaskbar ? "dock-container-fullwidth" : ""}`}
			onClick={() => {
				closeMenu();
				if (activePanel !== null) closePopup();
			}}
		>
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					justifyContent: "center",
					alignItems: "flex-end"
				}}
			>
				<motion.div
					ref={dockRef}
					layout
					className={`dock ${isExpanded && !isHidden ? "dock-expanded" : ""} ${isImpacted && !isExpanded && !isHidden ? "dock-impacted" : ""} ${dockIconOnly ? "dock-icon-only" : ""} ${isFullWidthTaskbar ? "dock-maximized-expanded dock-fullwidth" : ""} ${activePanel ? `dock-island-open dock-island-${activePanel}` : ""}`}
					onMouseEnter={() => setIsDockHovered(true)}
					onMouseLeave={() => {
						setIsDockHovered(false);
						setHoveredApp(null);
						setPressedApp(null);
					}}
					onClick={(e) => e.stopPropagation()}
					initial={{
						y: -800,
						opacity: 1,
						width: 34,
						height: 34,
						paddingLeft: 0,
						paddingRight: 0,
						borderTopLeftRadius: 17,
						borderTopRightRadius: 17,
						borderBottomLeftRadius: 17,
						borderBottomRightRadius: 17
					}}
					animate={{
						y: !isReady ? -800 : isVisible ? (isHidden ? 100 : 0) : 150,
						width: targetDockWidth,
						height: targetDockHeight,
						paddingLeft: isExpanded && !isHidden && isVisible ? 14 : 0,
						paddingRight: isExpanded && !isHidden && isVisible ? 14 : 0,
						borderTopLeftRadius: targetTopRadius,
						borderTopRightRadius: targetTopRadius,
						borderBottomLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						borderBottomRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						opacity: isVisible ? 1 : 0,
						scale: scale
					}}
					transition={{
						y: { type: "spring", stiffness: 400, damping: 35, mass: 0.8 },
						width: { type: "spring", stiffness: 320, damping: 28, mass: 0.8 },
						height: { type: "spring", stiffness: 340, damping: 28, mass: 0.8 },
						paddingLeft: { type: "spring", stiffness: 320, damping: 24, mass: 0.85 },
						paddingRight: { type: "spring", stiffness: 320, damping: 24, mass: 0.85 },
						layout: isDragging ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 28 },
						borderTopLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderTopRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						opacity: { type: "tween", duration: 0.2 },
						scale: { duration: 0 }
					}}
					style={{ originX: 0.5, originY: 1, minWidth: 34 }}
					onContextMenu={(e) => handleContextMenu(e, null)}
				>
					<EdgeSurface
						edge="bottom"
						flares={isExpanded && !isHidden && !isFullWidthTaskbar}
					/>

					{/* Upper Dynamic Island stretched area inside the Dock itself */}
					<AnimatePresence mode="wait">
						{isExpanded && activePanel === "start" && (
							<DockStartMenuPanel
								key="island-start"
								panelRef={islandPanelRef}
								pinnedApps={pinnedItems}
								installedApps={installedApps}
								customIcons={customIcons}
								cachedIcons={iconsRef.current}
								currentUser={currentUser}
								onLaunchApp={(app) => {
									closePopup();
									handleAppClick(app);
								}}
								onSystemAction={(action) => {
									closePopup();
									invoke("open_system_action", { action }).catch(showActionError);
								}}
								onClose={closePopup}
							/>
						)}
						{isExpanded && activePanel === "search" && (
							<DockSearchPanel
								key="island-search"
								panelRef={islandPanelRef}
								runningApps={activeApps}
								installedApps={installedApps}
								onLaunchApp={(app) => {
									closePopup();
									handleAppClick(app);
								}}
								onNativeWindowsSearch={() => {
									closePopup();
									invoke("open_system_action", { action: "search" }).catch(showActionError);
								}}
								onClose={closePopup}
							/>
						)}
						{isExpanded && activePanel === "tray" && (
							<DockTrayPanel
								key="island-tray"
								panelRef={islandPanelRef}
								trayItems={trayItems}
								trayIcons={trayIcons}
								trayLoading={trayLoading}
								onRefresh={() => {
									setTrayLoading(true);
									invoke<TrayApp[]>("get_tray_apps")
										.then((items) => setTrayItems(items.filter((app) => app.tray_ids.length > 0)))
										.catch(showActionError)
										.finally(() => setTrayLoading(false));
								}}
								onActivate={(trayId) => {
									closePopup();
									invoke("activate_tray_icon", { trayId }).catch(showActionError);
								}}
								onContextMenu={(trayId) => {
									closePopup();
									void openTrayMenu(trayId);
								}}
								onOpenTaskManager={() => {
									closePopup();
									invoke("open_system_action", { action: "task-manager" }).catch(showActionError);
								}}
								onClose={closePopup}
							/>
						)}
						{isExpanded && activePanel === "add" && (
							<DockAddAppPanel
								key="island-add"
								panelRef={islandPanelRef}
								runningApps={activeApps}
								installedApps={installedApps}
								pinned={pinnedApps}
								onAdd={(app) => {
									togglePin(app);
									closePopup();
								}}
								onClose={closePopup}
							/>
						)}
					</AnimatePresence>

					{/* Bottom Dock icon bar — stays anchored at the bottom of the stretched block */}
					<AnimatePresence>
						{isExpanded && (
							<motion.div
								ref={barRowRef}
								key="dock-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								className={`dock-reorder-container ${activePanel ? "dock-bar-with-island" : ""}`}
							>
								{/* 1. Start / Windows button — 100% static (no bounce, zoom, or y movement) */}
								{startItem && (
									<div
										className="dock-icon-wrapper dock-system-wrapper"
										onContextMenu={(e) => handleContextMenu(e, startItem)}
										onMouseEnter={() => setHoveredApp(itemKey(startItem))}
										onMouseLeave={() => {
											setHoveredApp(null);
											setPressedApp(null);
										}}
									>
										{(!dockPreviewEnabled ||
											(dockPreviewEnabled && hoveredApp === itemKey(startItem))) &&
											activePanel === null && (
												<div className="tooltip">{startItem.name}</div>
											)}
										<div
											className={`dock-icon dock-start-btn${activePanel === "start" ? " is-open" : ""}`}
											role="button"
											tabIndex={0}
											aria-label="Menu Démarrer"
											aria-expanded={activePanel === "start"}
											onClick={(e) => {
												e.stopPropagation();
												toggleDockPanel("start");
											}}
										>
											<img
												src={resolveStartIcon(startIcon)}
												alt="Start"
												className="bloom-icon-img"
												style={
													startIcon.startsWith("custom:") ? { borderRadius: "8px" } : undefined
												}
												draggable={false}
											/>
										</div>
									</div>
								)}

								{/* 2. Search pill — 100% static (no bounce, zoom, or y movement) */}
								<button
									type="button"
									className={`dock-search-pill${activePanel === "search" ? " is-open" : ""}`}
									title="Rechercher dans Bloom et sur Windows"
									aria-label="Rechercher dans Bloom et sur Windows"
									aria-expanded={activePanel === "search"}
									onClick={(e) => {
										e.stopPropagation();
										toggleDockPanel("search");
									}}
								>
									<Search size={15} aria-hidden="true" />
									<span>Recherche</span>
								</button>

								{/* 3. Background apps chevron ^ — 100% static (no bounce, zoom, or y movement) */}
								<button
									type="button"
									className={`dock-tray-toggle${activePanel === "tray" ? " is-open" : ""}`}
									title="Applications en arrière-plan"
									aria-label="Afficher les applications en arrière-plan"
									aria-expanded={activePanel === "tray"}
									onClick={(e) => {
										e.stopPropagation();
										toggleDockPanel("tray");
									}}
								>
									<ChevronUp size={18} aria-hidden="true" />
								</button>

								{dockTaskView && (
									<motion.div
										key="task-view"
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
										className="dock-icon-wrapper"
										onContextMenu={(e) => {
											e.stopPropagation();
											e.preventDefault();
											setContextMenu({ x: e.clientX, y: e.clientY, app: null, taskView: true });
										}}
										onMouseEnter={() => setHoveredApp("task-view")}
										onMouseLeave={() => {
											setHoveredApp(null);
											setPressedApp(null);
										}}
									>
										{(!dockPreviewEnabled || hoveredApp === "task-view") && (
											<div className="tooltip">Task View</div>
										)}
										<motion.div
											className="dock-icon"
											variants={iconVariants}
											animate={
												detachingId === "task-view"
													? "detach"
													: pressedApp === "task-view"
														? "tap"
														: hoveredApp === "task-view"
															? "hover"
															: "idle"
											}
											onPointerDown={() => setPressedApp("task-view")}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e) => {
												e.stopPropagation();
												openTaskView();
											}}
										>
											<TaskViewIcon />
										</motion.div>
									</motion.div>
								)}

								{dockExtrasPosition === "left" && dockExtras.length > 0 && (
									<>
										{dockExtras.map((extra) => renderExtra(extra))}
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
									</>
								)}

								<Reorder.Group
									as="div"
									axis="x"
									values={pinnedItems.map(itemKey)}
									onReorder={handleReorder}
									className="dock-reorder-group"
								>
									{pinnedItems.map((app) => (
										<Reorder.Item
											as="div"
											key={itemKey(app)}
											value={itemKey(app)}
											style={{ position: "relative" }}
											onDragStart={() => {
												setIsDragging(true);
												setHoveredApp(null);
												setPressedApp(null);
											}}
											onDragEnd={handleDragEnd}
											onContextMenu={(e) => handleContextMenu(e, app)}
											onMouseDown={(e) => {
												if (e.button === 1) e.preventDefault();
											}}
											onAuxClick={(e) => handleMiddleClick(e, app)}
											onClick={(e) => {
												e.stopPropagation();
												if (!isDragging) {
													triggerDetachEffect(itemKey(app));
													if (activePanel !== null) closePopup();
													handleAppClick(app);
												}
											}}
										>
											<motion.div
												className="dock-icon-wrapper"
												initial={ITEM_INITIAL}
												animate={ITEM_ANIMATE}
												exit={ITEM_EXIT}
												transition={ITEM_ENTRY_TRANSITION}
												onMouseEnter={() => setHoveredApp(itemKey(app))}
												onMouseLeave={() => {
													if (!isPreviewHoveredRef.current) {
														setHoveredApp(null);
														setPressedApp(null);
													}
												}}
											>
												<AnimatePresence>
													{dockPreviewEnabled &&
														activePanel === null &&
														previewData &&
														previewData.id === itemKey(app) &&
														hoveredApp === itemKey(app) && (
															<motion.div
																className={`preview-tooltip dock-tooltip-popup ${previewData.previews.length > 1 ? "multi" : ""}`}
																style={{ transformOrigin: "bottom center" }}
																initial={DETACH_INITIAL}
																animate={DETACH_ANIMATE}
																exit={DETACH_EXIT}
																transition={DETACH_SPRING}
																onMouseEnter={() => {
																	isPreviewHoveredRef.current = true;
																}}
																onMouseLeave={() => {
																	isPreviewHoveredRef.current = false;
																	setHoveredApp(null);
																	setPressedApp(null);
																}}
															>
																<div className="preview-items">
																	{previewData.previews.map((prev, idx) => (
																		<div
																			key={prev.hwnd}
																			className="preview-item"
																			onClick={() => invoke("focus_window", { hwnd: prev.hwnd })}
																		>
																			<img src={prev.image} alt={`Preview ${idx}`} />
																			<div className="preview-label">{prev.title || app.name}</div>
																			<button
																				className="preview-close-btn"
																				onClick={(e) => handleClosePreview(e, prev.hwnd)}
																				title="Close Window"
																			>
																				<svg
																					width="10"
																					height="10"
																					viewBox="0 0 24 24"
																					fill="none"
																					stroke="currentColor"
																					strokeWidth="3"
																					strokeLinecap="round"
																				>
																					<line x1="18" y1="6" x2="6" y2="18"></line>
																					<line x1="6" y1="6" x2="18" y2="18"></line>
																				</svg>
																			</button>
																		</div>
																	))}
																</div>
															</motion.div>
														)}
												</AnimatePresence>

												{activePanel === null &&
													(!dockPreviewEnabled ||
														(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
														<div className="tooltip">{app.name}</div>
													)}
												<motion.div
													className="dock-icon"
													variants={iconVariants}
													animate={
														detachingId === itemKey(app)
															? "detach"
															: pressedApp === itemKey(app)
																? "tap"
																: isDragging && !app.is_pinned
																	? "idle"
																	: hoveredApp === itemKey(app) && !isDragging
																		? "hover"
																		: "idle"
													}
													whileDrag="drag"
													onPointerDown={() => setPressedApp(itemKey(app))}
													onPointerUp={() => setPressedApp(null)}
													onPointerCancel={() => setPressedApp(null)}
												>
													{(() => {
														const isHost = isBrowserHost(app.path);
														const cacheKey = isHost
															? `${app.path}:${app.name.toLowerCase()}`
															: app.hwnd
																? `${app.path}-${app.hwnd}`
																: app.path;
														const allowPathFallback = !isHost || !app.is_running;
														const brandIcon = cleanBrandIcon(app);
														const icon =
															customIcons[cacheKey] ||
															(allowPathFallback && customIcons[app.path]) ||
															brandIcon ||
															iconsRef.current[cacheKey] ||
															(allowPathFallback && iconsRef.current[app.path]) ||
															app.icon;

														const isBloomOrSettings =
															app.name.toLowerCase() === "settings" ||
															app.name.toLowerCase() === "bloom" ||
															app.path.toLowerCase().includes("bloom.exe");

														return icon ? (
															<img
																src={icon}
																alt={app.name}
																className={
																	brandIcon
																		? "dock-brand-icon"
																		: isBloomOrSettings
																			? "bloom-icon-img"
																			: ""
																}
																draggable={false}
															/>
														) : (
															<div className="fallback-icon">{app.name[0]}</div>
														);
													})()}
												</motion.div>
												{app.is_running && (
													<WindowDots
														count={app.all_hwnds?.length ?? 1}
														background={app.is_background}
													/>
												)}
											</motion.div>
										</Reorder.Item>
									))}
								</Reorder.Group>

								{dockSeparatorEnabled &&
									unpinnedItems.length > 0 &&
									(pinnedItems.length > 0 || startItem) && (
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
									)}

								{unpinnedItems.map((app) => (
									<motion.div
										key={itemKey(app)}
										layout
										initial={{ opacity: 0, scale: 0 }}
										animate={{
											opacity: 1,
											scale: 1,
											transition: {
												opacity: { duration: 0.15, delay: 0.15 },
												scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.15 }
											}
										}}
										exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
										className="dock-icon-wrapper"
										onContextMenu={(e) => handleContextMenu(e, app)}
										onMouseEnter={() => setHoveredApp(itemKey(app))}
										onMouseLeave={() => {
											if (!isPreviewHoveredRef.current) {
												setHoveredApp(null);
												setPressedApp(null);
											}
										}}
										onMouseDown={(e) => {
											if (e.button === 1) e.preventDefault();
										}}
										onAuxClick={(e) => handleMiddleClick(e, app)}
										onClick={(e) => {
											e.stopPropagation();
											triggerDetachEffect(itemKey(app));
											if (activePanel !== null) closePopup();
											handleAppClick(app);
										}}
									>
										<AnimatePresence>
											{dockPreviewEnabled &&
												activePanel === null &&
												previewData &&
												previewData.id === itemKey(app) &&
												hoveredApp === itemKey(app) && (
													<motion.div
														className={`preview-tooltip dock-tooltip-popup ${previewData.previews.length > 1 ? "multi" : ""}`}
														style={{ transformOrigin: "bottom center" }}
														initial={DETACH_INITIAL}
														animate={DETACH_ANIMATE}
														exit={DETACH_EXIT}
														transition={DETACH_SPRING}
														onMouseEnter={() => {
															isPreviewHoveredRef.current = true;
														}}
														onMouseLeave={() => {
															isPreviewHoveredRef.current = false;
															setHoveredApp(null);
															setPressedApp(null);
														}}
													>
														<div className="preview-items">
															{previewData.previews.map((prev, idx) => (
																<div
																	key={prev.hwnd}
																	className="preview-item"
																	onClick={() => invoke("focus_window", { hwnd: prev.hwnd })}
																>
																	<img src={prev.image} alt={`Preview ${idx}`} />
																	<div className="preview-label">{prev.title || app.name}</div>
																	<button
																		className="preview-close-btn"
																		onClick={(e) => handleClosePreview(e, prev.hwnd)}
																		title="Close Window"
																	>
																		<svg
																			width="10"
																			height="10"
																			viewBox="0 0 24 24"
																			fill="none"
																			stroke="currentColor"
																			strokeWidth="3"
																			strokeLinecap="round"
																		>
																			<line x1="18" y1="6" x2="6" y2="18"></line>
																			<line x1="6" y1="6" x2="18" y2="18"></line>
																		</svg>
																	</button>
																</div>
															))}
														</div>
													</motion.div>
												)}
										</AnimatePresence>
										{activePanel === null &&
											(!dockPreviewEnabled ||
												(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
												<div className="tooltip">{app.name}</div>
											)}
										<motion.div
											className="dock-icon"
											variants={iconVariants}
											animate={
												detachingId === itemKey(app)
													? "detach"
													: pressedApp === itemKey(app)
														? "tap"
														: hoveredApp === itemKey(app) && !isDragging
															? "hover"
															: "idle"
											}
											onPointerDown={() => setPressedApp(itemKey(app))}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
										>
											{(() => {
												const isHost = isBrowserHost(app.path);
												const cacheKey = isHost
													? `${app.path}:${app.name.toLowerCase()}`
													: app.hwnd
														? `${app.path}-${app.hwnd}`
														: app.path;
												const allowPathFallback = !isHost || !app.is_running;
												const brandIcon = cleanBrandIcon(app);
												const icon =
													customIcons[cacheKey] ||
													(allowPathFallback && customIcons[app.path]) ||
													brandIcon ||
													iconsRef.current[cacheKey] ||
													(allowPathFallback && iconsRef.current[app.path]) ||
													app.icon;
												const isBloomOrSettings =
													app.name.toLowerCase() === "settings" ||
													app.name.toLowerCase() === "bloom" ||
													app.path.toLowerCase().includes("bloom.exe");
												return icon ? (
													<img
														src={icon}
														alt={app.name}
														className={
															brandIcon
																? "dock-brand-icon"
																: isBloomOrSettings
																	? "bloom-icon-img"
																	: ""
														}
														draggable={false}
													/>
												) : (
													<div className="fallback-icon">{app.name[0]}</div>
												);
											})()}
										</motion.div>
										{app.is_running && (
											<WindowDots
												count={app.all_hwnds?.length ?? 1}
												background={app.is_background}
											/>
										)}
									</motion.div>
								))}

								{dockExtrasPosition === "right" && dockExtras.length > 0 && (
									<>
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
										{dockExtras.map((extra) => renderExtra(extra))}
									</>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</div>

			<AnimatePresence>
				{contextMenu && (
					<motion.div
						key="dock-context-menu"
						ref={menuRef}
						className="context-menu dock-context-menu"
						style={{
							left: (menuPos?.left ?? contextMenu.x) / scale,
							top: (menuPos?.top ?? contextMenu.y) / scale,
							visibility: menuPos ? "visible" : "hidden",
							zoom: scale,
							transformOrigin: "bottom center"
						}}
						initial={DETACH_INITIAL}
						animate={DETACH_ANIMATE}
						exit={DETACH_EXIT}
						transition={DETACH_SPRING}
						onClick={(e) => e.stopPropagation()}
					>
						{!contextMenu.extra &&
							!contextMenu.taskView &&
							(!contextMenu.app || contextMenu.app.path === "start") && (
								<div
									style={{
										maxHeight: Math.max(64, window.innerHeight / scale - 200),
										overflowY: "auto"
									}}
								>
									{(contextMenu.app
										? [
												["installed-apps", "Installed Apps"],
												["power-options", "Power Options"],
												["device-manager", "Device Manager"],
												["network-connections", "Network Connections"],
												["disk-management", "Disk Management"],
												["computer-management", "Computer Management"],
												["task-manager", "Task Manager"],
												["settings", "Settings"]
											]
										: [
												["task-manager", "Task Manager"],
												["taskbar-settings", "Taskbar Settings"]
											]
									).map(([action, label]) => (
										<div
											key={action}
											className="menu-item"
											onClick={() => {
												closeMenu();
												invoke("open_system_action", { action }).catch(showActionError);
											}}
										>
											{label}
										</div>
									))}
									<div className="menu-divider" />
								</div>
							)}
						{contextMenu.extra ? (
							<>
								<div
									className="menu-item"
									onClick={() => {
										const extra = contextMenu.extra!;
										closeMenu();
										handleExtraClick(extra);
									}}
								>
									Open
								</div>
								{contextMenu.extra.kind === "drive" && contextMenu.extra.removable && (
									<div className="menu-item" onClick={() => ejectExtra(contextMenu.extra!)}>
										Eject
									</div>
								)}
								{contextMenu.extra.kind === "drive" && (
									<>
										<div className="menu-divider" />
										<div
											className="menu-item quit"
											onClick={() => hideDriveFromDock(contextMenu.extra!)}
										>
											Remove from Dock
										</div>
									</>
								)}
								{contextMenu.extra.kind === "custom" && (
									<>
										<div className="menu-divider" />
										<div
											className="menu-item quit"
											onClick={() => removeExtraFromDock(contextMenu.extra!)}
										>
											Remove from Dock
										</div>
									</>
								)}
							</>
						) : contextMenu.taskView ? (
							<>
								<div
									className="menu-item"
									onClick={() => {
										closeMenu();
										openTaskView();
									}}
								>
									Open Task View
								</div>
								<div className="menu-divider" />
								<div className="menu-item" onClick={hideTaskView}>
									Hide Task View
								</div>
							</>
						) : contextMenu.app ? (
							<>
								<div className="menu-item" onClick={() => togglePin(contextMenu.app!)}>
									{contextMenu.app.is_pinned ? "Unpin from Dock" : "Pin to Dock"}
								</div>
								{contextMenu.app.is_pinned && contextMenu.app.path !== "start" && (
									<>
										<div className="menu-divider" />
										<div
											className="menu-item"
											onClick={() => {
												const isHost = isBrowserHost(contextMenu.app!.path);
												const ck = isHost
													? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
													: contextMenu.app!.path;
												iconPickerTargetRef.current = ck;
												closeMenu();
												setTimeout(() => {
													document.getElementById("icon-file-input")?.click();
												}, 50);
											}}
										>
											Change Icon...
										</div>
										{(() => {
											const isHost = isBrowserHost(contextMenu.app!.path);
											const ck = isHost
												? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
												: contextMenu.app!.path;
											return customIcons[ck] ? (
												<div
													className="menu-item"
													onClick={() => {
														handleRemoveCustomIcon(contextMenu.app!);
														closeMenu();
													}}
												>
													Reset Icon
												</div>
											) : null;
										})()}
									</>
								)}
								<div className="menu-divider" />
								<div
									className="menu-item"
									onClick={() => {
										closeMenu();
										setActivePanel("add");
									}}
								>
									Add App to Dock...
								</div>
								<div
									className="menu-item has-submenu"
									onMouseEnter={() => setActiveSubmenu("bloom")}
									onMouseLeave={() => setActiveSubmenu(null)}
								>
									Bloom Options
									<span className="submenu-arrow">▶</span>
									<div className="submenu">
										<div
											className="menu-item"
											onClick={() => {
												invoke("open_settings_window");
												closeMenu();
											}}
										>
											Open Settings
										</div>
										<div className="menu-item" onClick={() => invoke("restart_bloom")}>
											Restart Bloom
										</div>
										<div
											className="menu-item"
											onClick={() => {
												handleClearIconCache();
												closeMenu();
											}}
										>
											Clear Icon Cache
										</div>
										<div className="menu-divider" />
										<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
											Quit Bloom
										</div>
									</div>
								</div>
								{(() => {
									const app = contextMenu.app!;
									const canOpenNew = app.is_running && app.path !== "start";
									if (!app.tray_ids?.length && !canOpenNew) return null;
									return (
										<>
											<div className="menu-divider" />
											{app.tray_ids?.map((id, index, ids) => (
												<div key={id} className="menu-item" onClick={() => void openTrayMenu(id)}>
													{ids.length > 1 ? `Tray menu ${index + 1}` : "App tray menu"}
												</div>
											))}
											{canOpenNew && (
												<div
													className="menu-item"
													onClick={() => {
														handleNewInstance(app);
														closeMenu();
													}}
												>
													Open New Instance
												</div>
											)}
										</>
									);
								})()}
								{contextMenu.app.is_running && !contextMenu.app.is_background && (
									<>
										{contextMenu.app.path === "start" && !contextMenu.app.tray_ids?.length && (
											<div className="menu-divider" />
										)}
										<div
											className="menu-item quit"
											onClick={async () => {
												const app = contextMenu.app;
												const hwnds =
													app?.all_hwnds?.map(([hwnd]) => hwnd) ?? (app?.hwnd ? [app.hwnd] : []);
												await Promise.all(hwnds.map((hwnd) => invoke("close_window", { hwnd })));
												closeMenu();
											}}
										>
											Close{" "}
											{contextMenu.app.all_hwnds && contextMenu.app.all_hwnds.length > 1
												? "all windows"
												: "window"}
										</div>
									</>
								)}
							</>
						) : (
							<>
								<div
									className="menu-item"
									onClick={() => {
										closeMenu();
										setActivePanel("add");
									}}
								>
									Add App to Dock...
								</div>
								<div
									className="menu-item has-submenu"
									onMouseEnter={() => setActiveSubmenu("bloom")}
									onMouseLeave={() => setActiveSubmenu(null)}
								>
									Bloom Options
									<span className="submenu-arrow">▶</span>
									<div className="submenu">
										<div
											className="menu-item"
											onClick={() => {
												invoke("open_settings_window");
												closeMenu();
											}}
										>
											Open Settings
										</div>
										<div className="menu-item" onClick={() => invoke("restart_bloom")}>
											Restart Bloom
										</div>
										<div
											className="menu-item"
											onClick={() => {
												handleClearIconCache();
												closeMenu();
											}}
										>
											Clear Icon Cache
										</div>
										<div className="menu-divider" />
										<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
											Quit Bloom
										</div>
									</div>
								</div>
							</>
						)}
					</motion.div>
				)}
			</AnimatePresence>

			<input
				id="icon-file-input"
				type="file"
				accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
				style={{ display: "none" }}
				onChange={handleIconFileSelect}
			/>

			<AnimatePresence>
				{toast && (
					<motion.div
						className="dock-toast"
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 10 }}
						transition={{ duration: 0.2 }}
						style={{ zoom: scale }}
					>
						{toast}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});

/**
 * Integrated Start Menu inside the stretched Dynamic Island Dock.
 * Contains:
 * - Search bar at the top,
 * - Pinned / primary apps grid with real icons,
 * - "Toutes les applications >" button switching to the complete alphabetical list,
 * - Bottom bar (just above the Dock icons) with the user profile and Power menu (Arrêter, Redémarrer, Veille, Verrouiller).
 */
function DockStartMenuPanel({
	panelRef,
	pinnedApps,
	installedApps,
	customIcons,
	cachedIcons,
	currentUser,
	onLaunchApp,
	onSystemAction,
	onClose
}: {
	panelRef: React.RefObject<HTMLDivElement | null>;
	pinnedApps: AppInfo[];
	installedApps: AppInfo[];
	customIcons: Record<string, string>;
	cachedIcons: Record<string, string>;
	currentUser: string;
	onLaunchApp: (app: AppInfo) => void;
	onSystemAction: (action: string) => void;
	onClose: () => void;
}) {
	const [apps, setApps] = useState<AppInfo[]>(installedApps);
	const [search, setSearch] = useState("");
	const [allAppsView, setAllAppsView] = useState(false);
	const [powerMenuOpen, setPowerMenuOpen] = useState(false);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (installedApps.length > 0) {
			setApps(installedApps);
			return;
		}
		let active = true;
		invoke<AppInfo[]>("get_installed_apps")
			.then((res) => {
				if (active) setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [installedApps]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (powerMenuOpen) {
					setPowerMenuOpen(false);
				} else if (allAppsView && !search.trim()) {
					setAllAppsView(false);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose, powerMenuOpen, allAppsView, search]);

	// Primary pinned grid (up to 18 apps: user pinned apps first, then popular installed apps).
	const primaryGridApps = useMemo(() => {
		const out: AppInfo[] = [...pinnedApps];
		for (const inst of apps) {
			if (out.length >= 18) break;
			if (inst.path === "start") continue;
			if (!out.some((p) => isSameApp(p, inst))) {
				out.push(inst);
			}
		}
		return out.slice(0, 18);
	}, [pinnedApps, apps]);

	const filteredApps = useMemo(() => {
		const q = search.trim().toLowerCase();
		const base = apps.filter((a) => a.path !== "start");
		if (!q) return base;
		return base
			.filter((a) => a.name.toLowerCase().includes(q))
			.sort((x, y) => {
				const xs = x.name.toLowerCase().startsWith(q) ? 0 : 1;
				const ys = y.name.toLowerCase().startsWith(q) ? 0 : 1;
				return xs - ys || x.name.localeCompare(y.name);
			});
	}, [apps, search]);

	const alphabeticalGroups = useMemo(() => {
		const groups = new Map<string, AppInfo[]>();
		for (const app of filteredApps) {
			const firstChar = app.name.trim().charAt(0).toUpperCase();
			const letter = /[A-Z]/.test(firstChar) ? firstChar : "#";
			const list = groups.get(letter) ?? [];
			list.push(app);
			groups.set(letter, list);
		}
		return Array.from(groups.entries()).sort(([a], [b]) => {
			if (a === "#") return -1;
			if (b === "#") return 1;
			return a.localeCompare(b);
		});
	}, [filteredApps]);

	const resolveAppIcon = (app: AppInfo) => {
		const brand = cleanBrandIcon(app);
		return (
			customIcons[app.path] ||
			brand ||
			cachedIcons[app.path] ||
			listIcons[app.path] ||
			app.icon
		);
	};

	useEffect(() => {
		let active = true;
		const visiblePool =
			allAppsView || search.trim() ? filteredApps.slice(0, 48) : primaryGridApps;
		const missing = visiblePool.filter((a) => !resolveAppIcon(a));
		if (missing.length === 0) return;

		Promise.all(
			missing.map(async (app) => {
				try {
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch {
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) {
				setListIcons((prev) => ({ ...prev, ...batch }));
			}
		});
		return () => {
			active = false;
		};
	}, [allAppsView, search, filteredApps, primaryGridApps]);

	const showListMode = allAppsView || search.trim().length > 0;

	return (
		<motion.div
			ref={panelRef}
			className="dock-island-panel dock-start-panel"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			onClick={() => {
				if (powerMenuOpen) setPowerMenuOpen(false);
			}}
		>
			{/* Top Search Bar */}
			<div className="start-search-bar">
				<Search className="popup-search-icon" size={16} aria-hidden="true" />
				<input
					ref={inputRef}
					type="text"
					className="popup-search-input dock-search-input"
					placeholder="Rechercher des applications, paramètres et documents…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && filteredApps.length > 0) {
							onLaunchApp(filteredApps[0]);
						}
					}}
				/>
				{search && (
					<button
						type="button"
						className="start-search-clear"
						onClick={() => setSearch("")}
					>
						Effacer
					</button>
				)}
			</div>

			{/* Section Header */}
			<div className="start-section-header">
				<span className="start-section-title">
					{search.trim()
						? `Résultats (${filteredApps.length})`
						: allAppsView
							? "Toutes les applications"
							: "Épinglé"}
				</span>
				{!search.trim() && (
					<button
						type="button"
						className="start-all-apps-btn"
						onClick={() => setAllAppsView((v) => !v)}
					>
						{allAppsView ? (
							<>
								<ChevronLeft size={14} />
								<span>Retour</span>
							</>
						) : (
							<>
								<span>Toutes les applications</span>
								<ChevronRight size={14} />
							</>
						)}
					</button>
				)}
			</div>

			{/* Main Content Area: Pinned Grid OR Alphabetical All-Apps List */}
			<div className="start-body-scroll">
				{!showListMode ? (
					<div className="start-pinned-grid">
						{primaryGridApps.map((app) => {
							const icon = resolveAppIcon(app);
							return (
								<button
									key={`${app.path}::${app.name}`}
									type="button"
									className="start-grid-item"
									onClick={() => onLaunchApp(app)}
									title={app.name}
								>
									<div className="start-grid-icon">
										{icon ? (
											<img src={icon} alt="" draggable={false} />
										) : (
											<span className="start-grid-initial">{app.name.charAt(0)}</span>
										)}
									</div>
									<span className="start-grid-name">{app.name}</span>
								</button>
							);
						})}
					</div>
				) : filteredApps.length === 0 ? (
					<div className="popup-empty">
						Aucune application trouvée pour « {search.trim()} »
					</div>
				) : (
					<div className="start-alpha-list">
						{alphabeticalGroups.map(([letter, items]) => (
							<div key={letter} className="start-alpha-group">
								<div className="start-alpha-letter">{letter}</div>
								{items.map((app) => {
									const icon = resolveAppIcon(app);
									return (
										<button
											key={`${app.path}::${app.name}`}
											type="button"
											className="start-alpha-row"
											onClick={() => onLaunchApp(app)}
										>
											<div className="start-alpha-icon">
												{icon ? (
													<img src={icon} alt="" draggable={false} />
												) : (
													<span className="popup-app-initial">{app.name.charAt(0)}</span>
												)}
											</div>
											<span className="start-alpha-name">{app.name}</span>
										</button>
									);
								})}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Bottom Bar: User Profile & Power Menu (just above the Dock icons) */}
			<div className="start-footer-bar">
				<button
					type="button"
					className="start-user-badge"
					onClick={() => onSystemAction("settings")}
					title="Ouvrir les paramètres du compte Windows"
				>
					<div className="start-user-avatar">
						<User size={15} />
					</div>
					<span className="start-user-name">{currentUser}</span>
				</button>

				<div className="start-power-wrapper" onClick={(e) => e.stopPropagation()}>
					<AnimatePresence>
						{powerMenuOpen && (
							<motion.div
								className="start-power-popover"
								initial={{ opacity: 0, y: 8, scale: 0.95 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={{ opacity: 0, y: 8, scale: 0.95 }}
								transition={{ duration: 0.14 }}
							>
								<button
									type="button"
									className="start-power-option"
									onClick={() => onSystemAction("lock")}
								>
									<Lock size={14} />
									<span>Verrouiller</span>
								</button>
								<button
									type="button"
									className="start-power-option"
									onClick={() => onSystemAction("sleep")}
								>
									<Moon size={14} />
									<span>Mise en veille</span>
								</button>
								<button
									type="button"
									className="start-power-option"
									onClick={() => onSystemAction("restart")}
								>
									<RotateCcw size={14} />
									<span>Redémarrer</span>
								</button>
								<button
									type="button"
									className="start-power-option start-power-danger"
									onClick={() => onSystemAction("shutdown")}
								>
									<Power size={14} />
									<span>Arrêter</span>
								</button>
							</motion.div>
						)}
					</AnimatePresence>
					<button
						type="button"
						className={`start-power-btn${powerMenuOpen ? " is-open" : ""}`}
						title="Marche/Arrêt"
						aria-label="Marche/Arrêt"
						aria-expanded={powerMenuOpen}
						onClick={() => setPowerMenuOpen((v) => !v)}
					>
						<Power size={16} />
					</button>
				</div>
			</div>
		</motion.div>
	);
}

/**
 * Large-format Search integrated inside the stretched Dynamic Island Dock.
 */
function DockSearchPanel({
	panelRef,
	runningApps,
	installedApps,
	onLaunchApp,
	onNativeWindowsSearch,
	onClose
}: {
	panelRef: React.RefObject<HTMLDivElement | null>;
	runningApps: AppInfo[];
	installedApps: AppInfo[];
	onLaunchApp: (app: AppInfo) => void;
	onNativeWindowsSearch: () => void;
	onClose: () => void;
}) {
	const [apps, setApps] = useState<AppInfo[]>(installedApps);
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(installedApps.length === 0);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (installedApps.length > 0) {
			setApps(installedApps);
			setLoading(false);
			return;
		}
		let mounted = true;
		invoke<AppInfo[]>("get_installed_apps")
			.then((res) => {
				if (mounted) {
					setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
				}
			})
			.finally(() => {
				if (mounted) setLoading(false);
			});
		return () => {
			mounted = false;
		};
	}, [installedApps]);

	const sections = useMemo(() => {
		const q = search.trim().toLowerCase();
		const active = runningApps.filter(
			(a) => a.path !== "start" && (!q || a.name.toLowerCase().includes(q))
		);
		const activeKeys = new Set(active.map((a) => itemKey(a)));
		const installed = apps
			.filter(
				(a) =>
					a.path !== "start" &&
					!activeKeys.has(itemKey(a)) &&
					(!q || a.name.toLowerCase().includes(q))
			)
			.sort((x, y) => {
				if (!q) return x.name.localeCompare(y.name);
				const xs = x.name.toLowerCase().startsWith(q) ? 0 : 1;
				const ys = y.name.toLowerCase().startsWith(q) ? 0 : 1;
				return xs - ys || x.name.localeCompare(y.name);
			})
			.slice(0, q ? 36 : 24);

		const out: { title: string; items: AppInfo[]; isRunning?: boolean }[] = [];
		if (active.length > 0) {
			out.push({ title: "Fenêtres actives", items: active.slice(0, 10), isRunning: true });
		}
		if (installed.length > 0) {
			out.push({ title: "Applications", items: installed });
		}
		return out;
	}, [apps, runningApps, search]);

	const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
	const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [search]);

	useEffect(() => {
		if (!listRef.current) return;
		const row = listRef.current.querySelector(
			`[data-idx="${selectedIndex}"]`
		) as HTMLElement | null;
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (e.ctrlKey || e.metaKey || flat.length === 0) {
					onNativeWindowsSearch();
					return;
				}
				const target = flat[selectedIndex];
				if (target) onLaunchApp(target);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose, flat, selectedIndex, onLaunchApp, onNativeWindowsSearch]);

	useEffect(() => {
		let active = true;
		const targets = flat.slice(0, 28).filter((a) => !listIcons[a.path]);
		if (targets.length === 0) return;
		Promise.all(
			targets.map(async (app) => {
				try {
					const brand = cleanBrandIcon(app);
					if (brand) return [app.path, brand] as const;
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch {
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		});
		return () => {
			active = false;
		};
	}, [flat, listIcons]);

	return (
		<motion.div
			ref={panelRef}
			className="dock-island-panel dock-search-panel"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<div className="popup-search-row dock-search-header">
				<Search className="popup-search-icon" size={16} aria-hidden="true" />
				<input
					ref={inputRef}
					type="text"
					className="popup-search-input dock-search-input"
					placeholder="Rechercher une application, une fenêtre ou sur Windows…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<span className="dock-search-kbd">Entrée</span>
			</div>
			<div className="popup-apps-scroll dock-search-results" ref={listRef}>
				{loading && flat.length === 0 ? (
					<div className="popup-empty">Chargement de l’index des applications…</div>
				) : flat.length > 0 ? (
					sections.map((sec) => (
						<div key={sec.title}>
							<div className="popup-section-label">{sec.title}</div>
							{sec.items.map((app) => {
								const gi = flatIndex.get(app) ?? 0;
								const icon = cleanBrandIcon(app) || listIcons[app.path] || app.icon;
								return (
									<div
										key={`${app.path}::${app.name}`}
										data-idx={gi}
										className={`popup-app-row${gi === selectedIndex ? " selected" : ""}`}
										onClick={() => onLaunchApp(app)}
										onMouseEnter={() => setSelectedIndex(gi)}
									>
										<div className="popup-app-icon">
											{icon ? (
												<img src={icon} alt="" draggable={false} />
											) : (
												<span className="popup-app-initial">{app.name[0]}</span>
											)}
										</div>
										<span className="popup-app-name">{app.name}</span>
										{sec.isRunning ? (
											<span className="dock-search-badge">Actif</span>
										) : (
											<span className="dock-search-open-hint">Ouvrir ↵</span>
										)}
									</div>
								);
							})}
						</div>
					))
				) : (
					<div className="popup-empty">
						Aucune application locale pour « {search.trim()} » — appuyez sur Entrée pour rechercher sur Windows
					</div>
				)}
			</div>
			<div className="dock-search-footer">
				<button
					type="button"
					className="dock-search-win-btn"
					onClick={onNativeWindowsSearch}
				>
					<Search size={13} aria-hidden="true" />
					<span>Recherche Windows approfondie (Win+S)</span>
				</button>
			</div>
		</motion.div>
	);
}

/**
 * Integrated System Tray Grid inside the stretched Dynamic Island Dock.
 * Displays notification icons directly in Bloom's dark theme (no grey Windows popup).
 */
function DockTrayPanel({
	panelRef,
	trayItems,
	trayIcons,
	trayLoading,
	onRefresh,
	onActivate,
	onContextMenu,
	onOpenTaskManager,
	onClose
}: {
	panelRef: React.RefObject<HTMLDivElement | null>;
	trayItems: TrayApp[];
	trayIcons: Record<string, string>;
	trayLoading: boolean;
	onRefresh: () => void;
	onActivate: (trayId: string) => void;
	onContextMenu: (trayId: string) => void;
	onOpenTaskManager: () => void;
	onClose: () => void;
}) {
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<motion.div
			ref={panelRef}
			className="dock-island-panel dock-tray-panel"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<div className="tray-overflow-header">
				<span>Applications en arrière-plan</span>
				<button
					type="button"
					className="tray-refresh"
					aria-label="Actualiser les applications"
					onClick={onRefresh}
				>
					<RefreshCw size={15} />
				</button>
			</div>
			<div className="tray-grid-scroll">
				{trayLoading && trayItems.length === 0 ? (
					<div className="tray-empty">Chargement des icônes de notification…</div>
				) : trayItems.length === 0 ? (
					<div className="tray-empty">Aucune application en arrière-plan détectée.</div>
				) : (
					<div className="tray-icon-grid">
						{trayItems.map((app) => {
							const iconSrc = app.icon || trayIcons[app.path];
							return (
								<div
									key={app.path}
									className="tray-grid-card"
									title={`${app.name} — Clic gauche : ouvrir • Clic droit : options`}
									onClick={() => onActivate(app.tray_ids[0])}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										onContextMenu(app.tray_ids[0]);
									}}
								>
									<div className="tray-grid-icon-box">
										{iconSrc ? (
											<img src={iconSrc} alt="" draggable={false} />
										) : (
											<span className="tray-overflow-initial">{app.name.charAt(0)}</span>
										)}
									</div>
									<span className="tray-grid-label">{app.name}</span>
									<button
										type="button"
										className="tray-grid-more"
										title={`Menu contextuel de ${app.name}`}
										aria-label={`Menu contextuel de ${app.name}`}
										onClick={(e) => {
											e.stopPropagation();
											onContextMenu(app.tray_ids[0]);
										}}
									>
										<MoreHorizontal size={13} />
									</button>
								</div>
							);
						})}
					</div>
				)}
			</div>
			<div className="tray-overflow-footer">
				<button type="button" onClick={onOpenTaskManager}>
					Gestionnaire des tâches
				</button>
				<span>Clic gauche : ouvrir • Clic droit : menu</span>
			</div>
		</motion.div>
	);
}

/**
 * Integrated Add-App panel inside the stretched Dynamic Island Dock.
 */
function DockAddAppPanel({
	panelRef,
	runningApps,
	installedApps,
	pinned,
	onAdd,
	onClose
}: {
	panelRef: React.RefObject<HTMLDivElement | null>;
	runningApps: AppInfo[];
	installedApps: AppInfo[];
	pinned: AppInfo[];
	onAdd: (app: AppInfo) => void;
	onClose: () => void;
}) {
	const [apps, setApps] = useState<AppInfo[]>(installedApps);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(installedApps.length === 0);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 150);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedSearch]);

	useEffect(() => {
		if (installedApps.length > 0) {
			setApps(installedApps);
			setLoading(false);
			return;
		}
		const load = async () => {
			try {
				const res = await invoke<AppInfo[]>("get_installed_apps");
				setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			} finally {
				setLoading(false);
			}
		};
		load();
	}, [installedApps]);

	const runningSuggestions = useMemo(
		() => runningApps.filter((a) => a.path !== "start" && !pinned.some((p) => isSameApp(p, a))),
		[runningApps, pinned]
	);

	const sections = useMemo(() => {
		const s = debouncedSearch.trim().toLowerCase();
		if (!s) {
			const runningIds = new Set(runningSuggestions.map((a) => itemKey(a)));
			const rest = apps
				.filter(
					(a) =>
						a.path !== "start" &&
						!pinned.some((p) => isSameApp(p, a)) &&
						!runningIds.has(itemKey(a))
				)
				.slice(0, 60);
			const out: { title: string | null; items: AppInfo[] }[] = [];
			if (runningSuggestions.length > 0) out.push({ title: "Running", items: runningSuggestions });
			if (rest.length > 0) out.push({ title: "All apps", items: rest });
			return out;
		}
		const starts: AppInfo[] = [];
		const contains: AppInfo[] = [];
		for (const a of apps) {
			if (a.path === "start") continue;
			const n = a.name.toLowerCase();
			if (n.startsWith(s)) starts.push(a);
			else if (n.includes(s)) contains.push(a);
		}
		const byName = (x: AppInfo, y: AppInfo) => x.name.localeCompare(y.name);
		starts.sort(byName);
		contains.sort(byName);
		return [{ title: null, items: [...starts, ...contains].slice(0, 50) }];
	}, [apps, debouncedSearch, pinned, runningSuggestions]);

	const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
	const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

	useEffect(() => {
		setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
	}, [flat.length]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const target = flat[selectedIndex];
				if (!target) return;
				if (pinned.some((p) => isSameApp(p, target))) onClose();
				else onAdd(target);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose, flat, selectedIndex, onAdd, pinned]);

	useEffect(() => {
		let active = true;
		const targets = flat.slice(0, 25).filter((a) => !listIcons[a.path]);
		if (targets.length === 0) return;
		Promise.all(
			targets.map(async (app) => {
				try {
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch {
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		});
		return () => {
			active = false;
		};
	}, [flat, listIcons]);

	return (
		<motion.div
			ref={panelRef}
			className="dock-island-panel dock-add-panel"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<div className="popup-search-row">
				<Search className="popup-search-icon" size={15} aria-hidden="true" />
				<input
					ref={inputRef}
					type="text"
					className="popup-search-input"
					placeholder="Épingler une application au Dock…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>
			<div className="popup-apps-scroll" ref={listRef}>
				{loading ? (
					<div className="popup-empty">Chargement…</div>
				) : flat.length > 0 ? (
					sections.map((sec) => (
						<div key={sec.title ?? "all"}>
							{sec.title && <div className="popup-section-label">{sec.title}</div>}
							{sec.items.map((app) => {
								const gi = flatIndex.get(app) ?? 0;
								const icon = listIcons[app.path];
								const alreadyPinned = pinned.some((p) => isSameApp(p, app));
								return (
									<div
										key={`${app.path}::${app.name}`}
										data-idx={gi}
										className={`popup-app-row${gi === selectedIndex ? " selected" : ""}${alreadyPinned ? " is-pinned" : ""}`}
										onClick={() => (alreadyPinned ? onClose() : onAdd(app))}
										onMouseEnter={() => setSelectedIndex(gi)}
									>
										<div className="popup-app-icon">
											{icon ? (
												<img src={icon} alt="" draggable={false} />
											) : (
												<span className="popup-app-initial">{app.name[0]}</span>
											)}
										</div>
										<span className="popup-app-name">{app.name}</span>
										<span className="popup-app-pin">{alreadyPinned ? "✓" : "+"}</span>
									</div>
								);
							})}
						</div>
					))
				) : (
					<div className="popup-empty">Aucun résultat</div>
				)}
			</div>
		</motion.div>
	);
}

export default Dock;
