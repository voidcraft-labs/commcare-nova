import type { Page } from "@playwright/test";

/**
 * Tile a headed Chromium window onto the left or right half of its screen —
 * the two-user "watch both sides at once" view for the multiplayer suite
 * (`MP_TILE=1`) and the manual dual-session mode (`npm run mp:manual`).
 *
 * Screen geometry comes from the page's own `window.screen` (`avail*`
 * excludes the macOS menu bar / Dock), so the window tiles onto whichever
 * display it actually opened on. Positioning rides CDP `Browser.setWindowBounds`
 * — Chromium-only, and the un-maximize ships as its own call first because
 * Chrome ignores bounds sent to a maximized/fullscreen window.
 *
 * BEST-EFFORT by design: a purely visual nicety must never fail a test run,
 * and headless shells reject window-bounds commands — so every failure is
 * swallowed into a single warn.
 */
export async function tileWindow(
	page: Page,
	side: "left" | "right",
): Promise<void> {
	try {
		const screen = await page.evaluate(() => ({
			left: (window.screen as { availLeft?: number }).availLeft ?? 0,
			top: (window.screen as { availTop?: number }).availTop ?? 0,
			width: window.screen.availWidth,
			height: window.screen.availHeight,
		}));
		const half = Math.floor(screen.width / 2);
		const cdp = await page.context().newCDPSession(page);
		try {
			const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
				windowId: number;
			};
			await cdp.send("Browser.setWindowBounds", {
				windowId,
				bounds: { windowState: "normal" },
			});
			await cdp.send("Browser.setWindowBounds", {
				windowId,
				bounds: {
					left: side === "left" ? screen.left : screen.left + half,
					top: screen.top,
					width: half,
					height: screen.height,
					windowState: "normal",
				},
			});
		} finally {
			await cdp.detach().catch(() => undefined);
		}
	} catch (err) {
		console.warn(
			`[windowTiling] could not tile the ${side} window (headless, or a non-Chromium browser?): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
