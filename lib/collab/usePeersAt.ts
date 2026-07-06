/**
 * usePeersAt — the blueprint entity each peer occupies, for canvas markers.
 *
 * The roster (deduped by `userId`) is grouped by the ONE most-specific
 * blueprint entity a peer's `Location` names — a module, a form, or a field —
 * so a canvas renders a single marker per peer at exactly where they are, never
 * one per ancestor level. A peer on the app home occupies no entity (roster-
 * only, no marker).
 *
 * The mapping is pure (`peerTarget`, `groupPeersByEntity`) so it is a state
 * model: given a location or a roster it yields the target / grouping with no
 * doc, no React. The hook reads the shared roster off `PresenceProvider` (one
 * heartbeat + one EventSource subscription per builder, never one per marker)
 * and groups it by entity uuid.
 */

"use client";

import { useMemo } from "react";
import { usePresenceRoster } from "@/lib/collab/PresenceProvider";
import type { Peer } from "@/lib/collab/presence";
import type { Location } from "@/lib/routing/types";

/**
 * The blueprint entity a peer's location points at, at its most-specific
 * level. `kind` names which entity map the `uuid` indexes.
 */
export interface PeerTarget {
	readonly kind: "module" | "form" | "field";
	readonly uuid: string;
}

/**
 * Resolve a `Location` to the single entity a marker should sit on, or `null`
 * when the peer occupies no blueprint entity.
 *
 *  - `home` → `null` (roster-only; the app home names no entity).
 *  - `module` / `cases` / `search-config` / `detail-config` → the MODULE. The
 *    case-list workspace tabs and a `cases` `caseId` are case DATA, not a
 *    blueprint entity, so all four collapse to the module marker.
 *  - `form` → the selected FIELD when one is selected, else the FORM. A field
 *    is more specific than its form, so a peer editing a field marks the field
 *    row (and lights its "editing this" ring), not the whole form.
 */
export function peerTarget(location: Location): PeerTarget | null {
	switch (location.kind) {
		case "home":
			return null;
		case "module":
		case "cases":
		case "search-config":
		case "detail-config":
			return { kind: "module", uuid: location.moduleUuid };
		case "form":
			return location.selectedUuid !== undefined
				? { kind: "field", uuid: location.selectedUuid }
				: { kind: "form", uuid: location.formUuid };
	}
}

/**
 * The grouped view a canvas consumes: for each entity uuid, the peers on it.
 * A peer with no target (home) is absent. Keyed by uuid — a component looks up
 * its own uuid to decide whether to render a marker and which peers to show.
 */
export interface PeerGrouping {
	/** uuid → the peers whose most-specific entity is that uuid. */
	readonly byEntity: ReadonlyMap<string, Peer[]>;
	/** uuid → the peers whose `selectedUuid` IS that uuid (the live "editing
	 *  this" set) — a subset of `byEntity` for field targets. */
	readonly editingByEntity: ReadonlyMap<string, Peer[]>;
}

/**
 * Group peers by the entity they occupy. Each peer contributes to exactly one
 * `byEntity` bucket (its most-specific target); a `form`-with-selection peer
 * ALSO lands in `editingByEntity` under the selected field uuid, driving the
 * "editing this" ring the plain marker doesn't imply.
 */
export function groupPeersByEntity(peers: readonly Peer[]): PeerGrouping {
	const byEntity = new Map<string, Peer[]>();
	const editingByEntity = new Map<string, Peer[]>();
	for (const peer of peers) {
		const target = peerTarget(peer.location);
		if (!target) continue;
		const bucket = byEntity.get(target.uuid);
		if (bucket) bucket.push(peer);
		else byEntity.set(target.uuid, [peer]);

		if (peer.location.kind === "form" && peer.location.selectedUuid) {
			const uuid = peer.location.selectedUuid;
			const editing = editingByEntity.get(uuid);
			if (editing) editing.push(peer);
			else editingByEntity.set(uuid, [peer]);
		}
	}
	return { byEntity, editingByEntity };
}

/**
 * The presence grouping the canvas markers read. Reads the shared roster off
 * `PresenceProvider` and returns the peers grouped by the entity each occupies.
 * A component looks up its own uuid in `byEntity` / `editingByEntity` to decide
 * its marker + ring. Empty outside a `PresenceProvider` (replay, a dormant new
 * build), so every canvas marker safely renders nothing.
 */
export function usePeersAt(): PeerGrouping {
	const peers = usePresenceRoster();
	return useMemo(() => groupPeersByEntity(peers), [peers]);
}
