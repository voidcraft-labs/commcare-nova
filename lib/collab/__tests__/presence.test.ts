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

describe("visiblePeers — the real /stream wire shape (updatedAt is epoch millis)", () => {
	// The /stream route PROJECTS a `PresenceDoc` to `PresenceEntry`, converting
	// `updatedAt` from a Firestore `Timestamp` to epoch millis (`.toMillis()`).
	// `visiblePeers` does numeric arithmetic on it (`now − updatedAt` for
	// stale-hide, `>` for newest-wins) — so the wire value MUST be a number, or
	// both computations silently break. This mirrors what the projected frame
	// carries, so a regression at either seam (route stops projecting, or the
	// contract drifts back to a raw Timestamp) fails here.

	/** What the route's `projectPresence` produces: epoch millis, not a Timestamp. */
	function projected(
		userId: string,
		sessionId: string,
		atMs: number,
	): PresenceEntry {
		return {
			userId,
			sessionId,
			name: userId,
			color: "violet",
			location: { kind: "home" },
			updatedAt: atMs,
		};
	}

	it("stale-hide fires on the projected millis shape (a crashed peer fades)", () => {
		const frame: PresenceEntry[] = [
			projected("live", "live-tab", NOW - 1_000),
			projected("crashed", "crashed-tab", NOW - PRESENCE_STALE_MS - 1),
		];
		// The crashed peer (last beat > stale threshold ago) is hidden; the live
		// one survives — the arithmetic works because `updatedAt` is a number.
		expect(visiblePeers(frame, "self", NOW).map((p) => p.userId)).toEqual([
			"live",
		]);
	});

	it("newest-wins dedup fires on the projected millis shape (two tabs → freshest)", () => {
		const frame: PresenceEntry[] = [
			projected("peer", "old-tab", NOW - 5_000),
			projected("peer", "new-tab", NOW - 1_000),
		];
		const out = visiblePeers(frame, "self", NOW);
		expect(out).toHaveLength(1);
		expect(out[0].sessionId).toBe("new-tab");
	});

	it("a RAW Firestore-Timestamp-shaped updatedAt (the bug) defeats BOTH — the regression this guards", () => {
		// The pre-fix route shipped `d.data()` raw, so `updatedAt` reached the
		// client as a serialized Timestamp object. `now − object` is NaN, so
		// `NaN > PRESENCE_STALE_MS` is false → a crashed peer is NEVER hidden, and
		// `object > object` is false → newest-wins picks whichever came first, not
		// the freshest. Pin that this shape is broken so the projection can't
		// silently regress.
		const rawTs = { _seconds: 1, _nanoseconds: 0 } as unknown as number;
		const crashed: PresenceEntry = {
			userId: "crashed",
			sessionId: "crashed-tab",
			name: "crashed",
			color: "violet",
			location: { kind: "home" },
			updatedAt: rawTs, // an OBJECT, not millis — the bug
		};
		// Stale-hide should have hidden a long-crashed peer, but `now − object` is
		// NaN, so it lingers.
		expect(visiblePeers([crashed], "self", NOW - 0)).toHaveLength(1);
		expect(Number.isNaN(NOW - (rawTs as unknown as number))).toBe(true);
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
