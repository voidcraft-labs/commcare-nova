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
	/** A failed background refresh. The last complete snapshot remains usable. */
	readonly warning: string | undefined;
	readonly refreshing: boolean;
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
		target: { parentId: string | null; afterSiblingId?: string | null },
	) => Promise<{ ok: boolean; message?: string }>;
	describeArchive: (
		locationId: string,
	) => Promise<
		{ ok: true; impact: ArchiveImpact } | { ok: false; message: string }
	>;
	setArchived: (
		locationId: string,
		archived: boolean,
		confirmedImpact?: ArchiveImpact,
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
	const [warning, setWarning] = useState<string | undefined>(undefined);
	const [refreshing, setRefreshing] = useState(false);
	// Guards against a slow first read resolving after a faster second one and
	// overwriting it — the classic stale-response race on a re-readable view.
	const generation = useRef(0);
	const loaded = useRef(false);
	const revisionRef = useRef("0");
	const writeTail = useRef<Promise<void>>(Promise.resolve());

	const refresh = useCallback(async (): Promise<void> => {
		const mine = ++generation.current;
		if (loaded.current) setRefreshing(true);
		else setLoading(true);
		const result = await readOrganizationAction(appId);
		if (mine !== generation.current) return;
		setLoading(false);
		setRefreshing(false);
		if (!result.success) {
			if (loaded.current) setWarning(result.message);
			else setError(result.message);
			return;
		}
		loaded.current = true;
		setError(undefined);
		setWarning(undefined);
		setLocations(result.data.locations);
		revisionRef.current = result.data.revision;
		setRevision(result.data.revision);
	}, [appId]);
	const reload = useCallback(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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

	/**
	 * Commit any unsaved blueprint edits, and wait for them to land.
	 *
	 * **Why every location write needs this.** A level is a blueprint mutation
	 * and rides the debounced autosave; a place is an immediate Server Action
	 * whose `assertPlacement` validates against the COMMITTED document. Add a
	 * level and put a place in it inside the autosave window — the first thing
	 * any author does — and the server has genuinely never seen that level, so
	 * it refuses. The two stores are only visible together here, which is why
	 * the reconciliation belongs at this seam and not in the store: validating
	 * against the committed document is correct, and relaxing it to paper over
	 * a timing problem would trade a visible failure for an invisible one.
	 *
	 * The reconciler's save barrier includes both newly dispatched changes and
	 * batches that were already in flight. Waiting only for a newly minted batch
	 * id misses the common case where autosave won the dispatch race by a few
	 * milliseconds but has not received its PUT acknowledgement yet.
	 */
	const flushBlueprint = useCallback(async (): Promise<void> => {
		const reconciler = collab?.reconciler;
		if (reconciler === undefined) return;
		await reconciler.waitForHumanSaveBarrier();
	}, [collab]);

	/**
	 * Adopt the revision a write returned, then re-read.
	 *
	 * Adopting it SYNCHRONOUSLY is the load-bearing half. The re-read is async,
	 * so between a write resolving and its reload committing, the writers are
	 * still closed over the revision from the last completed read — and the next
	 * gesture would send that stale token and be refused for a change the same
	 * person just made, one round trip earlier. Two quick additions, or a rename
	 * immediately followed by a drag, hit it every time.
	 */
	const after = useCallback(
		<T extends { success: boolean; message?: string; code?: string }>(
			result: T & { data?: { revision?: string } },
		): { ok: boolean; message?: string } => {
			if (result.success) {
				reload();
				return { ok: true };
			}
			if (result.code === "conflict") reload();
			return { ok: false, message: result.message };
		},
		[reload],
	);

	/**
	 * Flush, run the write, and retry ONCE on `not-committed`.
	 *
	 * The retry is what makes the natural gesture work: an empty delta does not
	 * prove the blueprint landed, because autosave may already have a batch in
	 * flight, so the server's own typed answer is the only reliable signal. A
	 * second failure is reported — it means saving itself is broken, and saying
	 * so beats retrying forever.
	 */
	const write = useCallback(
		async <T extends { success: boolean; message?: string; code?: string }>(
			run: (expectedRevision: string) => Promise<T>,
		): Promise<T> => {
			const execute = async (): Promise<T> => {
				await flushBlueprint();
				let result = await run(revisionRef.current);
				if (!result.success && result.code === "not-committed") {
					await flushBlueprint();
					result = await run(revisionRef.current);
				}
				if (result.success) {
					const next = (result as T & { data?: { revision?: string } }).data
						?.revision;
					if (next !== undefined) {
						revisionRef.current = next;
						setRevision(next);
					}
				} else if (result.code === "conflict") {
					await refresh();
				}
				return result;
			};
			const queued = writeTail.current.then(execute, execute);
			writeTail.current = queued.then(
				() => undefined,
				() => undefined,
			);
			return queued;
		},
		[flushBlueprint, refresh],
	);

	return {
		locations,
		revision,
		loading,
		error,
		warning,
		refreshing,
		reload,
		create: useCallback(
			async (input) => {
				const result = await write((expectedRevision) =>
					createLocationAction(appId, input, expectedRevision),
				);
				const outcome = after(result);
				return result.success
					? { ...outcome, id: result.data.location.id }
					: outcome;
			},
			[appId, after, write],
		),
		update: useCallback(
			async (locationId, patch) =>
				after(
					await write((expectedRevision) =>
						updateLocationAction(appId, locationId, patch, expectedRevision),
					),
				),
			[appId, after, write],
		),
		move: useCallback(
			async (locationId, target) =>
				after(
					await write((expectedRevision) =>
						moveLocationAction(appId, locationId, target, expectedRevision),
					),
				),
			[appId, after, write],
		),
		describeArchive: useCallback(
			async (locationId) => {
				const result = await describeArchiveImpactAction(appId, locationId);
				return result.success
					? { ok: true as const, impact: result.data }
					: { ok: false as const, message: result.message };
			},
			[appId],
		),
		setArchived: useCallback(
			async (locationId, archived, confirmedImpact) => {
				const result = await write((expectedRevision) =>
					setLocationArchivedAction(
						appId,
						locationId,
						archived,
						expectedRevision,
						confirmedImpact,
					),
				);
				const outcome = after(result);
				return result.success
					? {
							...outcome,
							unassignedPersonas: result.data.unassignedPersonas,
						}
					: outcome;
			},
			[appId, after, write],
		),
	};
}
