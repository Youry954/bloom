import { describe, expect, test } from "bun:test";
import { appIdentity, isBrowserBackedApp, isSameApp, mergeTrayApps, selectDockTrayApps, type AppInfo, type TrayApp } from "../src/dockApps";
const tray: TrayApp = {
	name: "Discord",
	path: "C:\\Apps\\Discord.exe",
	tray_ids: ["42"],
	window_handles: [11, 12]
};
const windowApp: AppInfo = {
	name: "Discord",
	path: "com.squirrel.Discord.Discord",
	icon: null,
	is_running: true,
	hwnd: 11,
	all_hwnds: [[11, "Discord"]]
};
describe("dock tray lifecycle", () => {
	test("does not show every tray app when the dock starts", () => {
		const selected = selectDockTrayApps([], [tray], new Set(), () => false);
		expect(selected.visible).toEqual([]);
		expect(selected.observed.size).toBe(0);
	});
	test("shows an unpinned app only after its window was observed, then forgets it on exit", () => {
		const opened = selectDockTrayApps([windowApp], [tray], new Set(), () => false);
		expect(opened.visible).toEqual([tray]);
		const background = selectDockTrayApps([], [tray], opened.observed, () => false);
		expect(mergeTrayApps([], background.visible)[0].is_background).toBe(true);
		const exited = selectDockTrayApps([], [], background.observed, () => false);
		expect(exited.observed.size).toBe(0);
		expect(selectDockTrayApps([], [tray], exited.observed, () => false).visible).toEqual([]);
	});
	test("shows a pinned app's background dot immediately at startup", () => {
		const selected = selectDockTrayApps([], [tray], new Set(), (app) => app.path === tray.path);
		expect(mergeTrayApps([], selected.visible)[0]).toMatchObject({
			is_background: true,
			tray_ids: ["42"]
		});
		expect(selected.observed.size).toBe(0);
	});
	test("does not treat an unrelated same-name window as opening the tray app", () => {
		const other = { ...windowApp, hwnd: 99, all_hwnds: [[99, "Discord"]] as [number, string][] };
		expect(selectDockTrayApps([other], [tray], new Set(), () => false).visible).toEqual([]);
	});
	test("keeps a zero-window app running with exactly the tray identity", () => {
		const apps = mergeTrayApps([], [tray]);
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({
			is_running: true,
			is_background: true,
			all_hwnds: [],
			tray_ids: ["42"]
		});
		expect(apps[0].hwnd).toBeUndefined();
	});
	test("reconciles a shell-id window with its executable tray without a duplicate", () => {
		const apps = mergeTrayApps([windowApp], [tray]);
		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({ path: windowApp.path, is_background: false, tray_ids: ["42"] });
		expect(windowApp.tray_ids).toBeUndefined();
	});
	test("returns to background and disappears after a true exit", () => {
		expect(mergeTrayApps([windowApp], [tray])[0].is_background).toBe(false);
		expect(mergeTrayApps([], [tray])[0].is_background).toBe(true);
		expect(mergeTrayApps([], [])).toEqual([]);
	});
	test("does not collapse independent PWAs or attach a shared tray to one of them", () => {
		const second = {
			...windowApp,
			name: "Other PWA",
			path: "other-id",
			hwnd: 12,
			all_hwnds: [[12, "Other"]] as [number, string][]
		};
		const apps = mergeTrayApps([windowApp, second], [tray]);
		expect(apps).toHaveLength(2);
		expect(apps.every((a) => !a.is_background && a.tray_ids === undefined)).toBe(true);
	});
	test("does not match a different process by display name", () => {
		const other = { ...windowApp, hwnd: 99, all_hwnds: [[99, "Discord"]] as [number, string][] };
		expect(mergeTrayApps([other], [tray])).toHaveLength(2);
	});
});

describe("pinned and running app reconciliation", () => {
	const app = (name: string, path: string, executable?: string): AppInfo => ({
		name, path, executable, icon: null, is_running: false
	});
	test("matches Google Chrome pinned as a shortcut to its running browser window", () => {
		const pin = app("Google Chrome", "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk", "chrome.exe");
		const running = app("Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
		expect(isSameApp(pin, running)).toBe(true);
	});
	test("matches the Chrome AppsFolder entry to the running browser window", () => {
		const pin = app("Google Chrome", "Chrome");
		const running = app("Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
		expect(isSameApp(pin, running)).toBe(true);
	});
	test("does not merge Chrome with its PWAs", () => {
		const chrome = app("Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
		const youtube = app("YouTube", "C:\\Users\\me\\Start Menu\\YouTube.lnk", "chrome.exe");
		expect(isSameApp(chrome, youtube)).toBe(false);
		expect(isBrowserBackedApp(youtube)).toBe(true);
	});
	test("matches a browser PWA shortcut to its running window", () => {
		const youtube = app("YouTube", "C:\\Users\\me\\Start Menu\\YouTube.lnk", "chrome.exe");
		const running = app("YouTube", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
		expect(isSameApp(youtube, running)).toBe(true);
	});
	test("keeps independent Chrome PWAs separate even with the same host executable", () => {
		const youtube = app("YouTube", "C:\\Users\\me\\Start Menu\\YouTube.lnk", "chrome.exe");
		const drive = app("Google Drive", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
		expect(isSameApp(youtube, drive)).toBe(false);
	});
	test("does not merge different Chrome AUMID/PWA shell identities", () => {
		expect(isSameApp(app("YouTube", "Chrome._abc!PWA1", "chrome.exe"), app("YouTube", "Chrome._def!PWA2", "chrome.exe"))).toBe(false);
	});
	test("continues matching a normal pinned .lnk with its running executable", () => {
		expect(isSameApp(app("Microsoft Word", "C:\\Users\\me\\Start Menu\\Word.lnk", "WINWORD.EXE"), app("Word", "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE", "WINWORD.EXE"))).toBe(true);
	});
	test("preserves app identity for host windows with different PWA names", () => {
		const path = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
		expect(appIdentity(path, "chrome.exe", "YouTube")).not.toBe(appIdentity(path, "chrome.exe", "Gmail"));
	});
});
