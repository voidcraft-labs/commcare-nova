/**
 * Reconciler React context — the single session-scoped reconciler + the
 * presence/lookup subscription seams, all owned by `ReconcilerProvider`.
 *
 * Split from the provider component so non-component consumers (the hooks in
 * `lib/doc/hooks`, `lib/routing`) import the context + hooks without pulling
 * the provider's `EventSource` wiring into their module graph.
 */

"use client";

import { createContext, useContext } from "react";
import type { PresenceFrame } from "@/lib/collab/presenceTypes";
import type { Reconciler } from "@/lib/collab/reconciler";
import type { LookupManifest } from "@/lib/lookup/types";

/** What the provider exposes: the one reconciler, its new-build activation
 *  glue, plus presence and lookup subscriptions that ride the same
 *  `EventSource`. */
export interface ReconcilerContextValue {
	readonly reconciler: Reconciler;
	/** Activate a dormant reconciler once a new build mints its app id
	 *  (`data-app-id`): the provider stamps the app id on the network deps,
	 *  seeds the reconciler at `{ appId, baseSeq: 0, baseDoc: current doc }`,
	 *  and opens the stream at cursor 0. No-op if already active. */
	activate: (appId: string) => void;
	/** Subscribe to `event: presence` roster frames off the shared stream.
	 *  Returns an unsubscribe. P7's presence layer is the only consumer; the
	 *  seam ships in P6 so the single EventSource stays the one transport. */
	subscribePresence: (cb: (roster: PresenceFrame) => void) => () => void;
	/** Subscribe to full Project lookup manifests from `event: lookup-revision`
	 *  on the shared app stream. Lookup revisions are independent of blueprint
	 *  mutation sequence and therefore never enter reconciler state. The latest
	 *  validated manifest is replayed immediately to late subscribers. One
	 *  provider runtime latches one Project and advances its revision forward
	 *  only; a future admitted cross-Project move must reset/remount it. */
	subscribeLookupManifest: (
		cb: (manifest: LookupManifest) => void,
	) => () => void;
}

export const ReconcilerContext = createContext<ReconcilerContextValue | null>(
	null,
);

/** Read the reconciler context, or `null` outside a `ReconcilerProvider`
 *  (e.g. replay mode, which mounts no reconciler). Consumers that gate their
 *  behavior on multiplayer being live tolerate the null. */
export function useReconcilerContext(): ReconcilerContextValue | null {
	return useContext(ReconcilerContext);
}
