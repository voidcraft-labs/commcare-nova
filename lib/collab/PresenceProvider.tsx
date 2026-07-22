/**
 * PresenceProvider — the single owner of this tab's heartbeat + peer roster.
 *
 * Mounted inside the builder stack (below `ReconcilerProvider`, so
 * `subscribePresence` is available, and below the doc/session providers so
 * `useLocation()` resolves). It calls `usePresence` ONCE — one session id, one
 * heartbeat interval, one `subscribePresence` subscription for the whole
 * builder — and exposes the visible roster to two kinds of consumer:
 *
 *   - `usePresenceRoster()` → the avatar roster (`PresenceRoster`).
 *   - `usePeersAt()` → the roster grouped by entity uuid, for canvas markers
 *     (`PeerBadge`).
 *
 * Without this single owner, `PresenceRoster` and every `PeerBadge` calling
 * `usePresence` themselves would each mint a session id and run a heartbeat —
 * dozens of duplicate presence rows per tab. The name comes from the auth
 * session; the id is the server-threaded session user id (the reconciler's
 * authoritative identity), so self-dedupe agrees with echo classification.
 *
 * The app id is read from the SESSION STORE (`useAppId`), not the static build
 * page prop: a brand-new build mounts with no id, and the SA mints it mid-run
 * (`data-app-id` → atomic identity/access promotion + `reconciler.activate`,
 * URL rewritten via the History API) WITHOUT remounting the builder, so the
 * `buildId` prop stays `'new'`. Reading the session store's live `appId` is how
 * the creator starts heartbeating — and joins a collaborator's roster — the
 * instant the app is minted, with no reload.
 *
 * Outside the provider (replay, or before it mounts) `usePresenceRoster`
 * returns a stable empty roster, so consumers render no avatars / markers.
 */

"use client";

import { createContext, type ReactNode, useContext } from "react";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import type { Peer } from "@/lib/collab/presence";
import { usePresence } from "@/lib/collab/presence";
import { useLocation } from "@/lib/routing/hooks";
import { useAppId } from "@/lib/session/hooks";

/** Reference-stable empty roster for consumers outside the provider. */
const EMPTY_ROSTER: Peer[] = [];

const PresenceRosterContext = createContext<Peer[]>(EMPTY_ROSTER);

export interface PresenceProviderProps {
	/** The session user id — self-dedupe keys on it, the same id the reconciler
	 *  classifies echoes by. */
	userId: string;
	children: ReactNode;
}

export function PresenceProvider({ userId, children }: PresenceProviderProps) {
	// The LIVE app id (undefined for a not-yet-minted new build) — it flips the
	// instant the SA mints the app, without a builder remount.
	const appId = useAppId();
	const { user } = useAuth();
	const location = useLocation();
	const peers = usePresence(appId, { userId, name: user?.name }, location);

	return (
		<PresenceRosterContext.Provider value={peers}>
			{children}
		</PresenceRosterContext.Provider>
	);
}

/** The visible peer roster (self-deduped, stale-hidden, one avatar per peer,
 *  colored). Empty outside a `PresenceProvider`. */
export function usePresenceRoster(): Peer[] {
	return useContext(PresenceRosterContext);
}
