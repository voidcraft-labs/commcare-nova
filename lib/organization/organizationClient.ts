import type { HumanSaveBarrierOutcome } from "@/lib/collab/reconciler";
import type {
	createLocationAction,
	describeArchiveImpactAction,
	moveLocationAction,
	OrganizationResult,
	readOrganizationAction,
	setLocationArchivedAction,
	updateLocationAction,
} from "./actions";
import type { ArchiveImpact, StoredLocation } from "./types";

type LocalWriteFailure = {
	readonly success: false;
	readonly code: "blueprint-save-failed" | "transport";
	readonly message: string;
};

function barrierFailure(
	outcome: Exclude<HumanSaveBarrierOutcome, { readonly kind: "saved" }>,
): LocalWriteFailure {
	const message = (() => {
		switch (outcome.kind) {
			case "conflict":
				return "The app changed before its places could be saved. Review the latest app, then try again.";
			case "accessChanged":
				return "Your access or the app's project changed before this place could be saved. Reload, then try again.";
			case "permanent":
				return outcome.message;
			case "tooLarge":
				return "Your pending app changes are too large to save. Reload before changing places.";
			case "error":
				return outcome.message;
			case "cancelled":
				return "Saving stopped before this place could be changed. Reload, then try again.";
		}
	})();
	return { success: false, code: "blueprint-save-failed", message };
}

const transportFailure = (): LocalWriteFailure => ({
	success: false,
	code: "transport",
	message:
		"The organization could not be reached. Check your connection and try again.",
});

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
	) => Promise<{
		ok: boolean;
		message?: string;
		location?: StoredLocation;
	}>;
	move: (
		locationId: string,
		target: { parentId: string | null; afterSiblingId?: string | null },
	) => Promise<{
		ok: boolean;
		message?: string;
		location?: StoredLocation;
	}>;
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
		unassignedPersonaCount?: number;
	}>;
}

export interface OrganizationActions {
	read: typeof readOrganizationAction;
	create: typeof createLocationAction;
	update: typeof updateLocationAction;
	move: typeof moveLocationAction;
	describeArchive: typeof describeArchiveImpactAction;
	setArchived: typeof setLocationArchivedAction;
}

export type OrganizationClientSnapshot = Omit<OrganizationView, "reload">;

/** One app's authorized read state and serialized writes. Rows are adopted only
 * from complete server reads; a write receipt advances the optimistic token. */
export function createOrganizationClient(
	appId: string,
	actions: OrganizationActions,
	captureSaveBarrier: () => () => Promise<HumanSaveBarrierOutcome>,
) {
	let snapshot: OrganizationClientSnapshot = {
		locations: [],
		revision: "0",
		loading: true,
		error: undefined,
		warning: undefined,
		refreshing: false,
	};
	let loaded = false;
	let active = true;
	let revision = "0";
	let generation = 0;
	let writeTail: Promise<void> = Promise.resolve();
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<OrganizationClientSnapshot>) => {
		if (!active) return;
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	async function refresh(forQueuedWrite = false): Promise<void> {
		if (!active && !forQueuedWrite) return;
		const mine = ++generation;
		publish(loaded ? { refreshing: true } : { loading: true });
		let result:
			| Awaited<ReturnType<OrganizationActions["read"]>>
			| LocalWriteFailure;
		try {
			result = await actions.read(appId);
		} catch {
			result = transportFailure();
		}
		if (mine !== generation) return;
		if (!result.success) {
			publish({
				loading: false,
				refreshing: false,
				...(loaded ? { warning: result.message } : { error: result.message }),
			});
			return;
		}
		loaded = true;
		revision = result.data.revision;
		publish({
			loading: false,
			refreshing: false,
			error: undefined,
			warning: undefined,
			locations: result.data.locations,
			revision: result.data.revision,
		});
	}
	const reload = () => {
		void refresh();
	};

	/** The committed Blueprint must include every level/property this gesture
	 * names, including a batch autosave dispatched before the gesture. */
	async function flushBlueprint(
		waitForBlueprintSave: () => Promise<HumanSaveBarrierOutcome>,
	): Promise<LocalWriteFailure | undefined> {
		const outcome = await waitForBlueprintSave();
		return outcome.kind === "saved" ? undefined : barrierFailure(outcome);
	}

	function write<T extends { revision: string }>(
		run: (expectedRevision: string) => Promise<OrganizationResult<T>>,
	): Promise<OrganizationResult<T> | LocalWriteFailure> {
		// Capture the reconciler that owns this gesture, even if the view later changes apps.
		const waitForBlueprintSave = captureSaveBarrier();
		async function execute(): Promise<
			OrganizationResult<T> | LocalWriteFailure
		> {
			try {
				const firstFailure = await flushBlueprint(waitForBlueprintSave);
				if (firstFailure !== undefined) return firstFailure;
				let result = await run(revision);
				if (!result.success && result.code === "not-committed") {
					const retryFailure = await flushBlueprint(waitForBlueprintSave);
					if (retryFailure !== undefined) return retryFailure;
					result = await run(revision);
				}
				if (result.success) {
					// An accepted gesture survives navigation. Its receipt advances
					// the queue's token even when the view is no longer subscribed.
					revision = result.data.revision;
					generation += 1;
					publish({ revision });
					reload();
				} else if (result.code === "conflict") {
					// The queue stays held until its successor has the fresh token.
					await refresh(true);
				}
				return result;
			} catch {
				return transportFailure();
			}
		}
		const queued = writeTail.then(execute, execute);
		writeTail = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	const writer: OrganizationWriter = {
		async create(input) {
			const result = await write((revision) =>
				actions.create(appId, input, revision),
			);
			return result.success
				? { ok: true, id: result.data.location.id }
				: { ok: false, message: result.message };
		},
		async update(id, patch) {
			const result = await write((revision) =>
				actions.update(appId, id, patch, revision),
			);
			return result.success
				? { ok: true, location: result.data.location }
				: { ok: false, message: result.message };
		},
		async move(id, target) {
			const result = await write((revision) =>
				actions.move(appId, id, target, revision),
			);
			return result.success
				? { ok: true, location: result.data.location }
				: { ok: false, message: result.message };
		},
		async setArchived(id, archived, confirmedImpact) {
			const result = await write((revision) =>
				actions.setArchived(appId, id, archived, revision, confirmedImpact),
			);
			return result.success
				? {
						ok: true,
						unassignedPersonaCount: result.data.unassignedPersonaCount,
					}
				: { ok: false, message: result.message };
		},
		async describeArchive(id) {
			try {
				const result = await actions.describeArchive(appId, id);
				return result.success
					? { ok: true, impact: result.data }
					: { ok: false, message: result.message };
			} catch {
				return { ok: false, message: transportFailure().message };
			}
		},
	};
	return {
		writer,
		reload,
		refresh,
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		activate() {
			active = true;
			reload();
		},
		dispose() {
			active = false;
			generation += 1;
		},
	};
}
