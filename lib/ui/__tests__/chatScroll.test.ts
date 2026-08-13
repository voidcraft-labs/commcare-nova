import { describe, expect, it } from "vitest";
import {
	ANCHOR_MARGIN_PX,
	distanceFromBottom,
	modeAfterUserScroll,
	PIN_REENTRY_SLOP_PX,
	pinnedScrollTarget,
} from "@/lib/ui/chatScroll";

const metrics = (
	scrollTop: number,
	scrollHeight = 2000,
	clientHeight = 600,
) => ({ scrollTop, scrollHeight, clientHeight });

describe("distanceFromBottom", () => {
	it("measures the gap and clamps at zero", () => {
		expect(distanceFromBottom(metrics(1400))).toBe(0);
		expect(distanceFromBottom(metrics(1000))).toBe(400);
		/* Overscroll bounce can momentarily exceed the bottom. */
		expect(distanceFromBottom(metrics(1450))).toBe(0);
	});
});

describe("modeAfterUserScroll", () => {
	it("escapes on ANY upward scroll, however small", () => {
		expect(modeAfterUserScroll(1400, metrics(1399))).toBe("free");
		expect(modeAfterUserScroll(1400, metrics(600))).toBe("free");
	});

	it("re-enters pinned mode on a downward scroll near the bottom, with leeway", () => {
		const nearBottom = 1400 - PIN_REENTRY_SLOP_PX;
		expect(modeAfterUserScroll(600, metrics(nearBottom))).toBe("pinned");
		expect(modeAfterUserScroll(600, metrics(1400))).toBe("pinned");
	});

	it("stays free on a downward scroll that ends above the leeway", () => {
		expect(
			modeAfterUserScroll(600, metrics(1400 - PIN_REENTRY_SLOP_PX - 1)),
		).toBe("free");
	});
});

describe("pinnedScrollTarget", () => {
	it("targets the literal bottom with no anchor", () => {
		expect(pinnedScrollTarget(metrics(0), null)).toBe(1400);
	});

	it("keeps the literal bottom when the anchored card fits the viewport", () => {
		/* Card top at 1500 in a 2000-tall content, 600 viewport: the bottom
		 * position (1400) already shows the card from its top. */
		expect(pinnedScrollTarget(metrics(0), 1500)).toBe(1400);
	});

	it("caps at the card's top when the card outgrows the viewport", () => {
		/* Card top at 900: pinning to the bottom would open the card at its
		 * tail, so the target holds its top (minus breathing room) instead. */
		expect(pinnedScrollTarget(metrics(0), 900)).toBe(900 - ANCHOR_MARGIN_PX);
	});

	it("never targets above the top", () => {
		expect(pinnedScrollTarget(metrics(0, 500, 600), 4)).toBe(0);
	});
});
