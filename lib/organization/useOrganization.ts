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
	 * `dispatchHumanBatch` returns the minted batch id, or `undefined` when the
	 * delta is empty — which does NOT mean "committed", because autosave may
	 * already have a batch in flight. So the caller retries once on the typed
	 * `not-committed` rejection rather than trusting an empty delta.
	 */
	const flushBlueprint = useCallback(async (): Promise<void> => {
		const reconciler = collab?.reconciler;
		if (reconciler === undefined) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const batchId = reconciler.dispatchHumanBatch((signal) => {
				// Any terminal signal releases the wait. A failure resolves rather
				// than rejects: the write that follows will report the real
				// problem in the author's own terms, and autosave keeps retrying
				// the batch on its own schedule regardless.
				if (signal.kind !== "saving") done();
			});
			if (batchId === undefined) done();
		});
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
				const next = result.data?.revision;
				if (next !== undefined) setRevision(next);
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
			run: () => Promise<T>,
		): Promise<T> => {
			await flushBlueprint();
			const first = await run();
			if (first.success || first.code !== "not-committed") return first;
			await flushBlueprint();
			return run();
		},
		[flushBlueprint],
	);

	return {
		locations,
		revision,
		loading,
		error,
		reload,
		create: useCallback(
			async (input) => {
				const result = await write(() =>
					createLocationAction(appId, input, revision),
				);
				const outcome = after(result);
				return result.success
					? { ...outcome, id: result.data.location.id }
					: outcome;
			},
			[appId, revision, after, write],
		),
		update: useCallback(
			async (locationId, patch) =>
				after(
					await write(() =>
						updateLocationAction(appId, locationId, patch, revision),
					),
				),
			[appId, revision, after, write],
		),
		move: useCallback(
			async (locationId, target) =>
				after(
					await write(() =>
						moveLocationAction(appId, locationId, target, revision),
					),
				),
			[appId, revision, after, write],
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
			async (locationId, archived) => {
				const result = await write(() =>
					setLocationArchivedAction(appId, locationId, archived, revision),
				);
				const outcome = after(result);
				return result.success
					? {
							...outcome,
							unassignedPersonas: result.data.unassignedPersonas,
						}
					: outcome;
			},
			[appId, revision, after, write],
		),
	};
}
