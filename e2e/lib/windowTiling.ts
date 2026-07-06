import type { CDPSession, Page } from "@playwright/test";

/**
 * Tile a headed Chromium window onto the left or right half of its screen —
 * the two-user "watch both sides at once" view for the multiplayer suite
 * (`MP_TILE=1`) and the manual dual-session mode (`npm run mp:manual`).
 *
 * The screen work-area CANNOT be read from the page: under Playwright's
 * fixed-viewport device emulation `window.screen` is emulated too (it
 * reports the viewport, not the display). So the helper measures the real
 * display by MAXIMIZING the window via CDP and reading the resulting bounds
 * back, then splits that rectangle.
 *
 * Returns the half-window's approximate CONTENT size (window minus browser
 * chrome) so the caller can pick a page zoom that fits — see
 * {@link applyPageZoom}. It deliberately does NOT scale via
 * `Emulation.setDeviceMetricsOverride`: that scale destabilizes the
 * builder's own canvas scroll management (the canvas oscillates and
 * Playwright actionability never converges — verified empirically), so the
 * zoom rides plain CSS instead.
 *
 * BEST-EFFORT by design: a purely visual nicety must never fail a test run,
 * and headless shells reject window-bounds commands — so every failure is
 * swallowed into a single warn (returning undefined: don't zoom what didn't
 * tile).
 */
/** Where a window lands: the two half-screen slots (two-user sessions) or
 *  the four quadrants (four-user sessions). */
export type TileSlot =
	| "left"
	| "right"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export async function tileWindow(
	page: Page,
	slot: TileSlot,
): Promise<{ width: number; height: number } | undefined> {
	try {
		const cdp = await page.context().newCDPSession(page);
		const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
			windowId: number;
		};

		// Measure the real work area: maximize, then read the bounds back.
		// Maximizing animates, so poll briefly until the state lands.
		await cdp.send("Browser.setWindowBounds", {
			windowId,
			bounds: { windowState: "maximized" },
		});
		const work = await pollWindowBounds(cdp, page, windowId, "maximized");

		const halfW = Math.floor(work.width / 2);
		const halfH = Math.floor(work.height / 2);
		const onRight = slot === "right" || slot.endsWith("-right");
		const isQuadrant = slot !== "left" && slot !== "right";
		const onBottom = slot.startsWith("bottom");
		const bounds = {
			left: onRight ? work.left + halfW : work.left,
			top: onBottom ? work.top + halfH : work.top,
			width: halfW,
			height: isQuadrant ? halfH : work.height,
		};
		await cdp.send("Browser.setWindowBounds", {
			windowId,
			bounds: { windowState: "normal" },
		});
		await cdp.send("Browser.setWindowBounds", {
			windowId,
			bounds: { ...bounds, windowState: "normal" },
		});
		await cdp.detach().catch(() => undefined);

		// Approximate browser chrome (tab strip + toolbar) eats ~96px of height.
		return { width: bounds.width, height: Math.max(200, bounds.height - 96) };
	} catch (err) {
		console.warn(
			`[windowTiling] could not tile the ${slot} window (headless, or a non-Chromium browser?): ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

/**
 * Zoom the app content by `zoom` (e.g. 0.55) via CSS `zoom` — the browser
 * Cmd-minus effect, so a half-screen window on a 13" laptop shows the WHOLE
 * builder layout.
 *
 * CSS zoom REFLOWS: the effective layout width becomes viewport/zoom (wider
 * than CI's 1280), which modern Chromium exposes consistently through
 * `getBoundingClientRect`, hit-testing, and input — nothing is emulated, so
 * Playwright actions behave natively (unlike a device-metrics `scale`).
 *
 * The zoom lands on the BODY CHILDREN PRESENT AT LOAD, never the root:
 * floating-ui measures anchors in visual (post-zoom) pixels, so a popup
 * portaled into a zoomed root gets its coordinates re-scaled on render and
 * drifts by `anchor × zoom` toward the top-left (probe-verified: tooltips
 * and popovers landed at ~0.57× their anchor). Base UI appends its portal
 * containers to `<body>` AFTER load, so they stay unzoomed — the popup
 * renders full-size at natively correct coordinates next to the scaled
 * content. Registered as an init script so client-side navigations and
 * reloads keep the zoom.
 */
export async function applyPageZoom(page: Page, zoom: number): Promise<void> {
	await page.addInitScript((z) => {
		const apply = () => {
			for (const el of Array.from(document.body.children)) {
				if (el instanceof HTMLElement) el.style.zoom = String(z);
			}
		};
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", apply);
		} else {
			apply();
		}
	}, zoom);
}

/** Poll `Browser.getWindowBounds` until `windowState` matches (~1s cap). */
async function pollWindowBounds(
	cdp: CDPSession,
	page: Page,
	windowId: number,
	state: "maximized" | "normal",
): Promise<{ left: number; top: number; width: number; height: number }> {
	let bounds = { left: 0, top: 0, width: 0, height: 0 };
	for (let attempt = 0; attempt < 10; attempt++) {
		const res = (await cdp.send("Browser.getWindowBounds", { windowId })) as {
			bounds: {
				left?: number;
				top?: number;
				width?: number;
				height?: number;
				windowState?: string;
			};
		};
		bounds = {
			left: res.bounds.left ?? 0,
			top: res.bounds.top ?? 0,
			width: res.bounds.width ?? 0,
			height: res.bounds.height ?? 0,
		};
		if (res.bounds.windowState === state && bounds.width > 0) break;
		await page.waitForTimeout(100);
	}
	return bounds;
}
