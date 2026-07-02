/**
 * Presence state-model tests.
 *
 * The presence layer's decisions live in pure functions (`visiblePeers`,
 * `hashColor`, `mintSessionId`) so they are exercised here with no DOM, no
 * timers, no network — per repo convention (UI is `f(state)`; test the state
 * MODEL). The heartbeat effects + roster rendering are covered by the Playwright
 * E2E, not RTL/jsdom.
 */

import { describe, expect, it } from "vitest";
import {
	hashColor,
	mintSessionId,
	PEER_PALETTE,
	PRESENCE_STALE_MS,
	presenceCanBeat,
	visiblePeers,
} from "@/lib/collab/presence";
import type { PresenceEntry } from "@/lib/collab/presenceTypes";

const NOW = 1_000_000_000;

/** A presence entry with sensible defaults, overridable per test. */
function entry(
	over: Partial<PresenceEntry> & { userId: string },
): PresenceEntry {
	return {
		sessionId: `${over.userId}-tab`,
		name: over.userId,
		color: "violet",
		location: { kind: "home" },
		updatedAt: NOW,
		...over,
	};
}

describe("visiblePeers — self-dedupe", () => {
	it("drops BOTH of the caller's own sessions, keeping only peers", () => {
		const frame: PresenceEntry[] = [
			entry({ userId: "self", sessionId: "self-a" }),
			entry({ userId: "self", sessionId: "self-b" }),
			entry({ userId: "peer" }),
		];
		const out = visiblePeers(frame, "self", NOW);
		expect(out.map((p) => p.userId)).toEqual(["peer"]);
	});

	it("shows an empty roster when only the caller is present (two tabs)", () => {
		const frame: PresenceEntry[] = [
			entry({ userId: "self", sessionId: "self-a" }),
			entry({ userId: "self", sessionId: "self-b" }),
		];
		expect(visiblePeers(frame, "self", NOW)).toEqual([]);
	});
});

describe("visiblePeers — per-user newest-wins", () => {
	it("collapses a peer's two tabs to one entry at the freshest location", () => {
		const frame: PresenceEntry[] = [
			entry({
				userId: "peer",
				sessionId: "old",
				updatedAt: NOW - 5_000,
				location: { kind: "home" },
			}),
			entry({
				userId: "peer",
				sessionId: "new",
				updatedAt: NOW - 1_000,
				location: { kind: "module", moduleUuid: "m1" as never },
			}),
		];
		const out = visiblePeers(frame, "self", NOW);
		expect(out).toHaveLength(1);
		expect(out[0].sessionId).toBe("new");
		expect(out[0].location).toEqual({ kind: "module", moduleUuid: "m1" });
	});
});

describe("visiblePeers — stale-hide", () => {
	it("hides an entry older than the stale threshold", () => {
		const frame: PresenceEntry[] = [
			entry({ userId: "fresh", updatedAt: NOW - 1_000 }),
			entry({ userId: "stale", updatedAt: NOW - PRESENCE_STALE_MS - 1 }),
		];
		expect(visiblePeers(frame, "self", NOW).map((p) => p.userId)).toEqual([
			"fresh",
		]);
	});

	it("keeps an entry exactly at the stale boundary", () => {
		const frame: PresenceEntry[] = [
			entry({ userId: "edge", updatedAt: NOW - PRESENCE_STALE_MS }),
		];
		expect(visiblePeers(frame, "self", NOW).map((p) => p.userId)).toEqual([
			"edge",
		]);
	});

	it("prefers a fresh tab over a stale one for the same peer", () => {
		const frame: PresenceEntry[] = [
			entry({
				userId: "peer",
				sessionId: "stale",
				updatedAt: NOW - PRESENCE_STALE_MS - 1,
			}),
			entry({ userId: "peer", sessionId: "fresh", updatedAt: NOW - 1_000 }),
		];
		const out = visiblePeers(frame, "self", NOW);
		expect(out).toHaveLength(1);
		expect(out[0].sessionId).toBe("fresh");
	});
});

describe("visiblePeers — ordering", () => {
	it("orders peers by userId for a stable render", () => {
		const frame: PresenceEntry[] = [
			entry({ userId: "charlie" }),
			entry({ userId: "alice" }),
			entry({ userId: "bob" }),
		];
		expect(visiblePeers(frame, "self", NOW).map((p) => p.userId)).toEqual([
			"alice",
			"bob",
			"charlie",
		]);
	});
});

describe("hashColor", () => {
	it("always returns a palette entry", () => {
		for (const id of ["a", "user-123", "", "🙂", "x".repeat(200)]) {
			expect(PEER_PALETTE).toContain(hashColor(id));
		}
	});

	it("is deterministic for the same id", () => {
		expect(hashColor("stable-user")).toBe(hashColor("stable-user"));
	});

	it("spreads across the palette (not all one bucket)", () => {
		const seen = new Set(
			Array.from({ length: 50 }, (_, i) => hashColor(`user-${i}`).id),
		);
		expect(seen.size).toBeGreaterThan(1);
	});
});

describe("mintSessionId", () => {
	it("mints a distinct id each call", () => {
		expect(mintSessionId()).not.toBe(mintSessionId());
	});
});

describe("presenceCanBeat — the heartbeat gate", () => {
	it("beats only with app id + stream + resolved name", () => {
		expect(presenceCanBeat("app-1", "Ada", true)).toBe(true);
	});

	it("does NOT beat before the app id is minted (a fresh new build)", () => {
		expect(presenceCanBeat(undefined, "Ada", true)).toBe(false);
	});

	it("FLIPS true once the app id is activated (creator joins without a reload)", () => {
		// The new-build sequence: name + stream resolved, app id arrives last.
		expect(presenceCanBeat(undefined, "Ada", true)).toBe(false);
		expect(presenceCanBeat("app-minted", "Ada", true)).toBe(true);
	});

	it("does NOT beat with an unresolved name (no blank-name POST)", () => {
		expect(presenceCanBeat("app-1", undefined, true)).toBe(false);
	});

	it("does NOT beat without a live stream (replay / dormant)", () => {
		expect(presenceCanBeat("app-1", "Ada", false)).toBe(false);
	});
});
