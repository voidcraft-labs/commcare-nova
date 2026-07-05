/**
 * Presence — this tab's heartbeat + the live peer roster.
 *
 * The tracker mints a per-tab `sessionId` (so a user's two tabs are two
 * presence rows and one tab's `DELETE` never drops the other), heartbeats
 * `POST /api/apps/{id}/presence` on a fixed cadence AND promptly on every
 * `useLocation()` change, and `DELETE`s on unmount / `beforeunload`. Inbound
 * `event: presence` roster frames arrive over the single shared `EventSource`
 * via the reconciler provider's `subscribePresence(cb)` seam (P6).
 *
 * The pure half — `visiblePeers`, `hashColor`, `mintSessionId` — carries every
 * decision (self-dedupe by `userId`, per-user newest-wins, stale-hide, color)
 * so it is exercised as a state model with no DOM, no timers, no network. The
 * React hook `usePresence` is the thin effect shell around it.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import type { PresenceEntry, PresenceFrame } from "@/lib/collab/presenceTypes";
import { serializePath } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

// ── Cadence ─────────────────────────────────────────────────────────────

/** Fixed heartbeat interval. Comfortably inside the server's `PRESENCE_TTL_MS`
 *  (~60 s), so a live tab's row never lapses between beats. */
export const HEARTBEAT_MS = 15_000;

/** Debounce before a location-change heartbeat fires, so sweeping through a
 *  handful of fields in under a third of a second POSTs once (the last one),
 *  not once per intermediate selection. */
export const LOCATION_HEARTBEAT_DEBOUNCE_MS = 300;

/** An entry older than this is treated as gone and hidden from the roster —
 *  a tab that stopped heartbeating (backgrounded, crashed, offline) fades out
 *  well before the server's 60 s TTL reaps its row. Two missed beats. */
export const PRESENCE_STALE_MS = HEARTBEAT_MS * 2;

// ── Palette ─────────────────────────────────────────────────────────────

/**
 * The peer-color palette — five self-contained hue token pairs (a fill `bg`
 * that carries dark text + a border/ring accent), so a peer reads consistently
 * across the roster avatar and every canvas marker. The five are drawn from
 * the XPath editor's syntax family (violet-bright / periwinkle / iris /
 * orchid / lavender — the theme's violet-monochrome identity), NEVER the
 * semantic success/warning/error hues, which the theme reserves for meaning
 * (a rose peer would read as "something's wrong"). All are light fills that
 * take dark text per the theme contrast rules; each entry names the CSS token
 * it derives from. A presence row stored under a RETIRED palette id resolves
 * through the `hashColor` fallback in `paletteColor`, so renaming an entry
 * never strands a live roster (rows also TTL out within minutes).
 */
export interface PeerColor {
	/** Stable id, used as the map key + a debugging handle. */
	readonly id: string;
	/** Solid fill class (avatar background, marker dot). Dark text on it. */
	readonly bg: string;
	/** Accent class for a border / "editing this" ring. */
	readonly ring: string;
	/** Text class for a name label that sits ON the surface (not the fill). */
	readonly text: string;
}

export const PEER_PALETTE: readonly PeerColor[] = [
	{
		id: "violet",
		bg: "bg-nova-violet-bright",
		ring: "ring-nova-violet-bright",
		text: "text-nova-violet-bright",
	},
	{
		id: "periwinkle",
		bg: "bg-nova-periwinkle",
		ring: "ring-nova-periwinkle",
		text: "text-nova-periwinkle",
	},
	{
		id: "iris",
		bg: "bg-nova-iris",
		ring: "ring-nova-iris",
		text: "text-nova-iris",
	},
	{
		id: "orchid",
		bg: "bg-nova-orchid",
		ring: "ring-nova-orchid",
		text: "text-nova-orchid",
	},
	{
		id: "lavender",
		bg: "bg-nova-lavender",
		ring: "ring-nova-lavender",
		text: "text-nova-lavender",
	},
] as const;

/**
 * Deterministically map a user id to a palette entry — the same user is the
 * same color for everyone, this tab and its peers, with no server round-trip.
 * A small FNV-1a hash over the id keeps the distribution even across the short
 * palette; the client picks its own color at heartbeat time and the server
 * stores it, so a peer's row already carries the resolved color, but a caller
 * that only holds a `userId` (self, before the first frame) resolves the same
 * one here.
 */
export function hashColor(userId: string): PeerColor {
	let hash = 0x811c9dc5;
	for (let i = 0; i < userId.length; i++) {
		hash ^= userId.charCodeAt(i);
		// FNV prime multiply, kept in 32-bit unsigned range.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return PEER_PALETTE[hash % PEER_PALETTE.length];
}

// ── Session id ──────────────────────────────────────────────────────────

/** Mint a fresh per-tab session id. Two tabs of one user get distinct ids so
 *  their presence rows don't clobber and one tab's `DELETE` leaves the other. */
export function mintSessionId(): string {
	return crypto.randomUUID();
}

// ── Roster reduction (the pure state model) ─────────────────────────────

/**
 * Reduce a raw roster frame to the peers a tab should DISPLAY.
 *
 * Three rules, applied in order:
 *  1. Drop the caller (`selfUserId`) — the roster shows OTHER people; a tab
 *     never renders a marker or avatar for itself. Dedupe is by `userId`, so
 *     BOTH of the caller's own sessions drop, never just the current tab's.
 *  2. Hide a stale entry — `now − updatedAt > PRESENCE_STALE_MS` — a tab that
 *     stopped heartbeating fades before the server TTL reaps it.
 *  3. Collapse a peer's multiple sessions (two tabs) to ONE avatar, keeping
 *     the freshest (`updatedAt`) — its location is where that peer most
 *     recently was, and the roster dedupes a peer to a single presence.
 *
 * Pure + deterministic: the same frame + `selfUserId` + `now` always yields
 * the same list, ordered by `userId` for a stable render.
 */
export function visiblePeers(
	frame: PresenceFrame,
	selfUserId: string,
	now: number,
): PresenceEntry[] {
	const freshestByUser = new Map<string, PresenceEntry>();
	for (const entry of frame) {
		if (entry.userId === selfUserId) continue;
		if (now - entry.updatedAt > PRESENCE_STALE_MS) continue;
		const existing = freshestByUser.get(entry.userId);
		if (!existing || entry.updatedAt > existing.updatedAt) {
			freshestByUser.set(entry.userId, entry);
		}
	}
	return [...freshestByUser.values()].sort((a, b) =>
		a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
	);
}

/**
 * Estimate the client↔server clock offset from the caller's OWN presence
 * entries in a frame: `updatedAt` is SERVER-stamped (Firestore
 * `serverTimestamp`) while the stale-hide compares against the client's local
 * clock — raw `Date.now()` skewed past `PRESENCE_STALE_MS` (30 s, an entirely
 * ordinary desktop-clock error) hides every live peer (clock fast) or never
 * hides a dead one (clock slow). Self is the anchor because its beat cadence
 * bounds the estimate's error at one heartbeat (≈0 in practice — a frame
 * arrives BECAUSE a write landed, so self's stamp is fresh in the frame its
 * own beat triggered), and a long-dead peer's stale row can never drag the
 * anchor backward. `undefined` until the caller's first beat round-trips
 * (fall back to the raw local clock — the pre-beat window is shorter than
 * the staleness horizon).
 */
export function estimateClockOffset(
	frame: PresenceFrame,
	selfUserId: string,
	localNow: number,
): number | undefined {
	let newestSelf: number | undefined;
	for (const entry of frame) {
		if (entry.userId !== selfUserId) continue;
		if (newestSelf === undefined || entry.updatedAt > newestSelf) {
			newestSelf = entry.updatedAt;
		}
	}
	return newestSelf === undefined ? undefined : newestSelf - localNow;
}

// ── Heartbeat gate (the pure state model behind `canBeat`) ──────────────

/**
 * Whether this tab should heartbeat: a real app id (a new build's id is minted
 * mid-run, so this flips true the instant the SA activates it — no reload), a
 * live stream to subscribe presence over, AND a resolved non-empty display name
 * (the auth session is null on first paint; beating before it resolves would
 * POST a blank name a peer renders as "?"). Pure so both the hook and its test
 * read the same gate.
 */
export function presenceCanBeat(
	appId: string | undefined,
	name: string | undefined,
	hasStream: boolean,
): boolean {
	return appId !== undefined && hasStream && name !== undefined;
}

// ── The hook ────────────────────────────────────────────────────────────

/** A peer as the UI consumes it: the roster entry plus its resolved color. */
export interface Peer extends PresenceEntry {
	readonly peerColor: PeerColor;
}

/** Resolve a roster entry's SERVER-STORED color id back to its palette entry —
 *  the peer picked (and persists) its own color at heartbeat time, so honoring
 *  it keeps every tab agreeing even across palette-hash changes; an unknown /
 *  legacy id falls back to the deterministic `hashColor`. */
function paletteColor(id: string, userId: string): PeerColor {
	return PEER_PALETTE.find((c) => c.id === id) ?? hashColor(userId);
}

/** Content equality for two visible-peer lists, ignoring `updatedAt` (which
 *  advances on every heartbeat) — the roster's ARRAY IDENTITY is a render
 *  input for every `PeerBadge` up the tree, so an unchanged roster must keep
 *  its previous identity instead of re-rendering the whole canvas per tick. */
function samePeers(a: readonly Peer[], b: readonly Peer[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((pa, i) => {
		const pb = b[i];
		return (
			pa.userId === pb.userId &&
			pa.sessionId === pb.sessionId &&
			pa.name === pb.name &&
			pa.image === pb.image &&
			pa.email === pb.email &&
			pa.color === pb.color &&
			serializePath(pa.location).join("/") ===
				serializePath(pb.location).join("/")
		);
	});
}

/**
 * Drive this tab's heartbeat and expose the live peer roster.
 *
 * Mounted once inside the builder (below `ReconcilerProvider`, so
 * `subscribePresence` is available and `useLocation` resolves). Returns the
 * visible peers (self-deduped, stale-hidden, one avatar per peer, colored),
 * recomputed on every roster frame and every heartbeat tick (so a peer that
 * goes quiet fades even without a new frame).
 *
 * A dormant reconciler (a brand-new build with no app id yet), a replay session
 * (no reconciler at all), or an unresolved display name (the auth session is
 * null on first paint) heartbeats nothing and shows an empty roster — presence
 * is a live-shared-app affordance. Gating the first beat on a RESOLVED name
 * closes the blank-name window where a peer would briefly render this tab as
 * "?"; the beat fires the instant the name arrives.
 */
export function usePresence(
	appId: string | undefined,
	self: { userId: string; name: string | undefined },
	location: Location,
): Peer[] {
	const ctx = useReconcilerContext();
	const subscribePresence = ctx?.subscribePresence;
	// A resolved, non-empty display name — the beat waits for it (blank-name gate).
	const name = self.name?.trim() ? self.name : undefined;

	// One session id for the tab's lifetime — a ref so a re-render never mints
	// a second and orphans the first's presence row.
	const sessionIdRef = useRef<string | null>(null);
	if (sessionIdRef.current === null) sessionIdRef.current = mintSessionId();
	const sessionId = sessionIdRef.current;

	const selfColor = useMemo(() => hashColor(self.userId), [self.userId]);

	const [frame, setFrame] = useState<PresenceFrame>([]);
	// A tick that advances on every heartbeat so `visiblePeers` re-runs with a
	// fresh `now` — a peer that stops heartbeating fades on the next tick even
	// with no inbound frame to trigger a recompute.
	const [tick, setTick] = useState(0);
	// The client↔server clock offset, re-estimated off self's server-stamped
	// entry on every frame (see `estimateClockOffset`) — the stale-hide compares
	// server stamps against the local clock, and an ordinary 30s+ desktop skew
	// would otherwise hide every live peer or never hide a dead one.
	const clockOffsetRef = useRef<number | undefined>(undefined);

	// The latest location + self identity, read at POST time so the heartbeat
	// interval closes over a box, not a stale render's values. `name` is the
	// resolved (non-empty) name — `canBeat` gates on it, so it's never blank here.
	const beatInputRef = useRef({ location, name, color: selfColor.id });
	beatInputRef.current = { location, name, color: selfColor.id };

	// Beat only with a real app id, a live stream, AND a resolved name (no blank-
	// name POST). Any of them arriving flips this true and re-fires the effect —
	// so a new build's creator beats the instant the app id is activated.
	const canBeat = presenceCanBeat(appId, name, subscribePresence !== undefined);

	// Subscribe to inbound roster frames off the shared EventSource, updating
	// the clock-offset estimate on each (self's fresh server stamp anchors it).
	useEffect(() => {
		if (!subscribePresence) return;
		return subscribePresence((next) => {
			const offset = estimateClockOffset(next, self.userId, Date.now());
			if (offset !== undefined) clockOffsetRef.current = offset;
			setFrame(next);
		});
	}, [subscribePresence, self.userId]);

	// The ONE heartbeat POST body — the mount/interval beat and the debounced
	// location beat share it so their payloads can't drift. `loc` is explicit
	// (the location beat sends the render's fresh value; the interval sends the
	// ref's); name/color always ride the ref. Stable per (appId, sessionId), so
	// the effects below can list it without re-arming on every render.
	const postBeat = useCallback(
		(loc: Location) => {
			const { name: beatName, color } = beatInputRef.current;
			// `canBeat` guarantees a resolved name; the guard keeps a blank name off
			// the wire even if the ref updated between renders, and narrows the type.
			if (beatName === undefined || !appId) return;
			void fetch(`/api/apps/${appId}/presence`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId,
					name: beatName,
					color,
					location: loc,
				}),
				keepalive: true,
			}).catch(() => {
				/* A dropped heartbeat is self-healing — the next beat retries,
				 * and a peer stale-hides this tab until one lands. */
			});
		},
		[appId, sessionId],
	);

	// Heartbeat: an immediate POST on mount, then every HEARTBEAT_MS, plus a
	// DELETE on unmount and on `beforeunload` (a tab close skips React cleanup).
	useEffect(() => {
		if (!canBeat || !appId) return;

		const remove = () => {
			void fetch(`/api/apps/${appId}/presence`, {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId }),
				// `keepalive` lets the DELETE outlive the unloading document.
				keepalive: true,
			}).catch(() => {});
		};

		postBeat(beatInputRef.current.location);
		const interval = setInterval(() => {
			postBeat(beatInputRef.current.location);
			setTick((t) => t + 1);
		}, HEARTBEAT_MS);
		window.addEventListener("beforeunload", remove);

		return () => {
			clearInterval(interval);
			window.removeEventListener("beforeunload", remove);
			remove();
		};
	}, [appId, canBeat, sessionId, postBeat]);

	// Prompt heartbeat on a location change, debounced so a rapid sweep POSTs
	// once. Keyed on the SERIALIZED PATH, not the `location` object identity:
	// `useLocation()` re-derives its object from the doc-store entity maps, so
	// every doc mutation (a local keystroke, an SA batch, an inbound peer frame)
	// mints a NEW Location even when the path is unchanged — an identity dep
	// would re-arm this effect and POST a heartbeat per edit. Skips the initial
	// render (the mount beat already carries it); the beat reads the ref for the
	// freshest object at fire time.
	const locationKey = serializePath(location).join("/");
	const mountedRef = useRef(false);
	useEffect(() => {
		// `locationKey` is the re-arm trigger only — reading it keeps the dep
		// honest; the beat reads the ref for the freshest Location object.
		void locationKey;
		if (!canBeat || !appId) return;
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		const timer = setTimeout(
			() => postBeat(beatInputRef.current.location),
			LOCATION_HEARTBEAT_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [appId, canBeat, locationKey, postBeat]);

	const lastPeersRef = useRef<Peer[]>([]);
	return useMemo(() => {
		// `tick` is a recompute trigger only — reading it keeps the memo honest.
		void tick;
		// Skew-corrected "now": server stamps compare against server-ish time.
		const now = Date.now() + (clockOffsetRef.current ?? 0);
		const next = visiblePeers(frame, self.userId, now).map((entry) => ({
			...entry,
			peerColor: paletteColor(entry.color, entry.userId),
		}));
		// Preserve the previous ARRAY IDENTITY when nothing user-visible changed
		// (`updatedAt` advances on every 15s heartbeat, so a naive fresh array
		// would re-render every PeerBadge/roster consumer per tick and frame).
		if (samePeers(lastPeersRef.current, next)) return lastPeersRef.current;
		lastPeersRef.current = next;
		return next;
	}, [frame, self.userId, tick]);
}
