/**
 * The client's view of one app's places.
 *
 * A snapshot plus its revision, re-read after every write. The revision is
 * the optimistic token every write carries back, so two people editing the
 * same organization get a refusal naming the current revision rather than a
 * last-write-wins clobber — and the refusal is what prompts the re-read.
 *
 * There is no local mutation of the snapshot: a write returns the
 * authoritative revision and the hook re-reads. Places are not document
 * state, so there is no reducer to apply an optimistic edit through, and
 * inventing one would create a second source of truth for a tree the server
 * owns.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	createLocationAction,
	describeArchiveImpactAction,
	moveLocationAction,
	readOrganizationAction,
	setLocationArchivedAction,
	updateLocationAction,
} from "./actions";
import type { ArchiveImpact, StoredLocation } from "./types";

export interface OrganizationView {
	readonly locations: readonly StoredLocation[];
	readonly revision: string;
	/** True until the first read resolves — distinct from "no places yet". */
	readonly loading: boolean;
	/** Set when the last read failed, so the surface can say so rather than
	 *  render an empty organization that is not empty. */
	readonly error: string | undefined;
	readonly reload: () => void;
}

export interface OrganizationWriter {
	create: (
		input: Parameters<typeof createLocationAction>[1],
	) => Promise<{ ok: boolean; message?: string; id?: string }>;
	update: (
		locationId: string,
		patch: Parameters<typeof updateLocationAction>[2],
	) => Promise<{ ok: boolean; message?: string }>;
	move: (
		locationId: string,
		target: { parentId: string | null; afterSiblingId?: string },
	) => Promise<{ ok: boolean; message?: string }>;
	describeArchive: (locationId: string) => Promise<ArchiveImpact | undefined>;
	setArchived: (
		locationId: string,
		archived: boolean,
	) => Promise<{
		ok: boolean;
		message?: string;
		unassignedPersonas?: readonly string[];
	}>;
}

export function useOrganization(
	appId: string,
): OrganizationView & OrganizationWriter {
	const [locations, setLocations] = useState<readonly StoredLocation[]>([]);
	const [revision, setRevision] = useState("0");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>(undefined);
	// Guards against a slow first read resolving after a faster second one and
	// overwriting it — the classic stale-response race on a re-readable view.
	const generation = useRef(0);

	const reload = useCallback(() => {
		const mine = ++generation.current;
		setLoading(true);
		void readOrganizationAction(appId).then((result) => {
			if (mine !== generation.current) return;
			setLoading(false);
			if (!result.success) {
				setError(result.message);
				return;
			}
			setError(undefined);
			setLocations(result.data.locations);
			setRevision(result.data.revision);
		});
	}, [appId]);

	useEffect(reload, [reload]);

	// A co-editor's change arrives as a payload-free poke on the shared builder
	// stream and re-reads through the same authorized action as every other
	// read. The notification is never the data plane — the same rule the lookup
	// clock follows — which is why there is nothing in the frame to get wrong.
	// Null outside a live builder session (replay, tests) — there is no stream
	// to subscribe to, and the mount read plus post-write re-read still hold.
	const collab = useReconcilerContext();
	useEffect(() => {
		if (collab === null) return;
		return collab.subscribeAppOrganization(reload);
	}, [collab, reload]);

	/** Run a write, then re-read so the view matches what the server holds. */
	const after = useCallback(
		<T extends { success: boolean; message?: string }>(
			result: T,
		): { ok: boolean; message?: string } => {
			if (result.success) {
				reload();
				return { ok: true };
			}
			return { ok: false, message: result.message };
		},
		[reload],
	);

	return {
		locations,
		revision,
		loading,
		error,
		reload,
		create: useCallback(
			async (input) => {
				const result = await createLocationAction(appId, input, revision);
				const outcome = after(result);
				return result.success
					? { ...outcome, id: result.data.location.id }
					: outcome;
			},
			[appId, revision, after],
		),
		update: useCallback(
			async (locationId, patch) =>
				after(await updateLocationAction(appId, locationId, patch, revision)),
			[appId, revision, after],
		),
		move: useCallback(
			async (locationId, target) =>
				after(await moveLocationAction(appId, locationId, target, revision)),
			[appId, revision, after],
		),
		describeArchive: useCallback(
			async (locationId) => {
				const result = await describeArchiveImpactAction(appId, locationId);
				return result.success ? result.data : undefined;
			},
			[appId],
		),
		setArchived: useCallback(
			async (locationId, archived) => {
				const result = await setLocationArchivedAction(
					appId,
					locationId,
					archived,
					revision,
				);
				const outcome = after(result);
				return result.success
					? {
							...outcome,
							unassignedPersonas: result.data.unassignedPersonas,
						}
					: outcome;
			},
			[appId, revision, after],
		),
	};
}
