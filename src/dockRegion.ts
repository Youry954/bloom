import {
	clipToWindow,
	createRegionSender,
	 type HeldRegion,
	measureElements,
	nextRegion,
	notchPillBox,
	onPixelRatioChange,
	padRect,
	type RegionRect,
	type RegionState
} from "./windowRegion";

export {
	clipToWindow,
	createRegionSender,
	type HeldRegion,
	measureElements,
	nextRegion,
	notchPillBox,
	onPixelRatioChange,
	padRect,
	type RegionRect,
	type RegionState
};

/** Exact 0px CSS gap maintained between maximized windows and the top edge of the Dock. */
export const DOCK_MAXIMIZED_GAP_PX = 0;

/** Selectors and shadow padding for all interactive Dock panels, popups, and context menus. */
export const DOCK_POPUP_SELECTORS: [string, number][] = [
	[".dock-island-panel", 18],
	[".dock-search-popup", 18],
	[".tray-overflow-popup", 16],
	[".add-app-popup", 16],
	[".dock-context-menu", 14],
	[".dock-tooltip-popup", 12],
	[".dock-detach-bubble", 12]
];

export interface DockBarRegionInput {
	windowWidth: number;
	windowHeight: number;
	dockRect: RegionRect | null;
	isVisible: boolean;
	isExpanded: boolean;
	isHidden: boolean;
	isDockedExpanded: boolean;
	adaptiveWidth: boolean;
	peekStripHeight?: number;
	dockPad?: number;
}

/**
 * Computes the clickable region rectangle(s) for the Dock bar itself, taking into account
 * auto-hide peek strip, standard floating pill, `isDockedExpanded` horizontal expansion,
 * and full-width adaptive mode, without blocking clicks outside the Dock.
 */
export function computeDockBarRect(input: DockBarRegionInput): RegionRect[] {
	const {
		windowWidth,
		windowHeight,
		dockRect,
		isVisible,
		isExpanded,
		isHidden,
		isDockedExpanded,
		adaptiveWidth,
		peekStripHeight = 18,
		dockPad = 14
	} = input;

	if (!isVisible || windowWidth <= 0 || windowHeight <= 0) {
		return [];
	}

	if (!isExpanded || isHidden) {
		return [
			{
				x: 0,
				y: Math.max(0, windowHeight - peekStripHeight),
				width: windowWidth,
				height: peekStripHeight
			}
		];
	}

	if (!dockRect || dockRect.width <= 0 || dockRect.height <= 0) {
		return [];
	}

	const effectivePad = isDockedExpanded ? Math.max(dockPad, 16) : dockPad;

	if (isDockedExpanded || adaptiveWidth) {
		const padded = padRect(dockRect, effectivePad);
		const topY = Math.max(0, padded.y);
		return [
			{
				x: 0,
				y: topY,
				width: windowWidth,
				height: Math.max(padded.height, windowHeight - topY)
			}
		];
	}

	return [padRect(dockRect, effectivePad)];
}

/**
 * Computes a bounding rectangle that covers both an element's current transformed
 * `getBoundingClientRect()` and its full untransformed layout size (`offsetWidth`/`offsetHeight`)
 * anchored at `bottom center`. This guarantees that popups animating from
 * `scaleX: 0.3, scaleY: 0.1, y: 24` have their full target area clickable in `SetWindowRgn`
 * from the very first frame of the spring animation.
 */
export function untransformedPopupBox(
	rect: RegionRect,
	untransformedWidth: number,
	untransformedHeight: number,
	pad: number
): RegionRect {
	const targetW = Math.max(rect.width, untransformedWidth);
	const targetH = Math.max(rect.height, untransformedHeight);
	const centerX = rect.x + rect.width / 2;
	const bottomY = rect.y + rect.height;

	const left = Math.min(rect.x, centerX - targetW / 2);
	const right = Math.max(rect.x + rect.width, centerX + targetW / 2);
	const top = Math.min(rect.y, bottomY - targetH - 24);
	const bottom = Math.max(bottomY, rect.y + targetH);

	return padRect(
		{
			x: left,
			y: top,
			width: right - left,
			height: bottom - top
		},
		pad
	);
}

/**
 * Measures all active Dock popups and elastic detach bubbles in the DOM, returning
 * their clickable regions (including untransformed target bounds during elastic animations).
 */
export function measureDockPopups(
	selectors: [string, number][] = DOCK_POPUP_SELECTORS,
	scale = 1
): RegionRect[] {
	if (typeof document === "undefined") return [];
	const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
	return selectors.flatMap(([selector, pad]) =>
		Array.from(document.querySelectorAll(selector)).map((el) => {
			const r = el.getBoundingClientRect();
			const htmlEl = el as HTMLElement;
			const rawW = (htmlEl.offsetWidth || r.width) * zoom;
			const rawH = (htmlEl.offsetHeight || r.height) * zoom;
			return untransformedPopupBox(
				{ x: r.left, y: r.top, width: r.width, height: r.height },
				rawW,
				rawH,
				pad
			);
		})
	);
}
