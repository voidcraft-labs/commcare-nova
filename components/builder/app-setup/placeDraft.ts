import type { LocationProperty } from "@/lib/domain";
import type { OrganizationWriter } from "@/lib/organization/organizationClient";
import type { StoredLocation } from "@/lib/organization/types";
import { propertiesForLevel, valuesForLevel } from "./organizationUi";

type Scalar = "name" | "externalId" | "latitude" | "longitude";
const scalars = ["name", "externalId", "latitude", "longitude"] as const;
type Draft = Record<Scalar, string> & {
	levelUuid: string;
	parentId: string | null;
	values: Readonly<Record<string, string>>;
};
interface Save {
	readonly before: StoredLocation;
	readonly recovery: number;
	readonly peer: number;
}
interface Clock {
	generation: number;
	pending: number;
}
export interface PlaceDraftSnapshot {
	readonly draft: Draft;
	readonly source: StoredLocation;
	readonly dirtyLevel: boolean;
	readonly dirtyPlacement: boolean;
	readonly protected: boolean;
	readonly peerChanged: boolean;
	readonly pendingWrites: number;
	readonly valuesNeedApply: boolean;
	readonly hiddenDirtyPropertyUuids: readonly string[];
	readonly message: string | undefined;
}
const conflictMessage =
	"This place changed while you were editing. Use the latest saved values before saving your draft.";

function sameValues(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
) {
	return (
		Object.keys(left).length === Object.keys(right).length &&
		Object.keys(left).every((key) => left[key] === right[key])
	);
}
function samePlace(left: StoredLocation, right: StoredLocation) {
	return (
		left.id === right.id &&
		left.levelUuid === right.levelUuid &&
		left.parentId === right.parentId &&
		left.siteCode === right.siteCode &&
		scalars.every((key) => left[key] === right[key]) &&
		String(left.archivedAt) === String(right.archivedAt) &&
		left.orderKey === right.orderKey &&
		sameValues(left.values, right.values)
	);
}
function rowDraft(
	row: StoredLocation,
	properties: readonly LocationProperty[],
): Draft {
	return {
		name: row.name,
		externalId: row.externalId ?? "",
		latitude: row.latitude ?? "",
		longitude: row.longitude ?? "",
		levelUuid: row.levelUuid,
		parentId: row.parentId,
		values: valuesForLevel(properties, row.levelUuid, row.values),
	};
}

/** A row's actual editing state, independent of rendering. The organization
 * writer owns transport serialization; this owner preserves drafts and reconciles
 * complete row receipts with subsequent read snapshots. */
export function createPlaceDraft(
	initial: StoredLocation,
	initialProperties: readonly LocationProperty[],
	writer: () => Pick<OrganizationWriter, "update" | "move">,
) {
	let source = initial;
	let incoming = initial;
	let properties = initialProperties;
	let draft = rowDraft(initial, properties);
	let dirtyScalars = new Set<Scalar>();
	let dirtyValues: Record<string, string> = {};
	let valuesNeedApply = false;
	let peerSnapshot: StoredLocation | undefined;
	let peerEpoch = 0;
	let recoveryEpoch = 0;
	let pendingWrites = 0;
	let message: string | undefined;
	let localSaves: { before: StoredLocation; saved: StoredLocation }[] = [];
	const clocks: Record<Scalar | "placement", Clock> = {
		name: { generation: 0, pending: 0 },
		externalId: { generation: 0, pending: 0 },
		latitude: { generation: 0, pending: 0 },
		longitude: { generation: 0, pending: 0 },
		placement: { generation: 0, pending: 0 },
	};
	const listeners = new Set<() => void>();
	const dirtyPlacement = () =>
		draft.levelUuid !== source.levelUuid || draft.parentId !== source.parentId;
	const valuesDiffer = () =>
		!sameValues(
			draft.values,
			valuesForLevel(properties, source.levelUuid, source.values),
		);
	const protectedDraft = () =>
		dirtyScalars.size > 0 ||
		valuesDiffer() ||
		Object.keys(dirtyValues).length > 0 ||
		dirtyPlacement() ||
		valuesNeedApply ||
		pendingWrites > 0 ||
		peerSnapshot !== undefined;
	function snapshot(): PlaceDraftSnapshot {
		const applicable = new Set<string>(
			propertiesForLevel(properties, draft.levelUuid).map(
				(property) => property.uuid,
			),
		);
		return {
			draft,
			source,
			dirtyLevel: draft.levelUuid !== source.levelUuid,
			dirtyPlacement: dirtyPlacement(),
			protected: protectedDraft(),
			peerChanged: peerSnapshot !== undefined,
			pendingWrites,
			valuesNeedApply,
			hiddenDirtyPropertyUuids: Object.keys(dirtyValues).filter(
				(uuid) => !applicable.has(uuid),
			),
			message,
		};
	}
	let view = snapshot();
	function clearPeer() {
		peerSnapshot = undefined;
	}
	function adopt(row: StoredLocation) {
		source = row;
		draft = rowDraft(row, properties);
		dirtyScalars = new Set();
		dirtyValues = {};
		valuesNeedApply = false;
		localSaves = [];
		clearPeer();
	}
	function reconcile() {
		if (protectedDraft()) {
			if (samePlace(source, incoming)) return;
			const accepted = localSaves.findIndex((save) =>
				samePlace(save.saved, incoming),
			);
			if (accepted >= 0) {
				localSaves = localSaves.slice(accepted + 1);
				source = localSaves.at(-1)?.saved ?? incoming;
				clearPeer();
			} else if (!localSaves.some((save) => samePlace(save.before, incoming))) {
				if (peerSnapshot === undefined || !samePlace(peerSnapshot, incoming))
					peerEpoch += 1;
				peerSnapshot = incoming;
			}
			return;
		}
		const accepted = localSaves.findIndex((save) =>
			samePlace(save.saved, incoming),
		);
		if (accepted >= 0) localSaves = localSaves.slice(accepted + 1);
		const last = localSaves.at(-1);
		if (
			last !== undefined &&
			localSaves.some((save) => samePlace(save.before, incoming))
		) {
			source = last.saved;
			clearPeer();
			return;
		}
		adopt(incoming);
	}
	function publish() {
		reconcile();
		view = snapshot();
		for (const listener of listeners) listener();
	}
	function capture(): Save {
		return { before: source, recovery: recoveryEpoch, peer: peerEpoch };
	}
	function current(save: Save) {
		return save.recovery === recoveryEpoch && save.peer === peerEpoch;
	}
	function accept(save: Save, saved: StoredLocation | undefined) {
		if (!current(save)) return false;
		if (saved !== undefined) {
			localSaves.push({ before: save.before, saved });
			source = saved;
		}
		clearPeer();
		return true;
	}
	function invalidate() {
		recoveryEpoch += 1;
		for (const clock of Object.values(clocks)) clock.generation += 1;
	}
	function refuseConflict() {
		if (peerSnapshot === undefined) return false;
		message = conflictMessage;
		publish();
		return true;
	}
	async function request(run: () => ReturnType<OrganizationWriter["update"]>) {
		pendingWrites += 1;
		publish();
		try {
			return await run();
		} finally {
			pendingWrites -= 1;
		}
	}

	return {
		getSnapshot: () => view,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		receive(row: StoredLocation, nextProperties: readonly LocationProperty[]) {
			incoming = row;
			properties = nextProperties;
			draft = {
				...draft,
				values: valuesForLevel(properties, draft.levelUuid, draft.values),
			};
			publish();
		},
		setMessage(next: string | undefined) {
			message = next;
			publish();
		},
		editScalar(key: Scalar, value: string) {
			draft = { ...draft, [key]: value };
			dirtyScalars.add(key);
			publish();
		},
		async saveScalar(key: Scalar) {
			const submitted = draft[key];
			const clock = clocks[key];
			if (submitted === (source[key] ?? "") && clock.pending === 0) {
				dirtyScalars.delete(key);
				publish();
				return;
			}
			if (refuseConflict()) return;
			const generation = ++clock.generation;
			clock.pending += 1;
			const save = capture();
			const result = await request(() =>
				writer().update(initial.id, {
					[key]: key === "name" || submitted !== "" ? submitted : null,
				}),
			);
			clock.pending -= 1;
			const latest = current(save) && generation === clock.generation;
			if (!result.ok) {
				if (latest) message = result.message;
			} else if (accept(save, result.location)) {
				if (
					generation === clock.generation &&
					draft[key] === submitted &&
					result.location !== undefined
				) {
					draft = { ...draft, [key]: result.location[key] ?? "" };
					dirtyScalars.delete(key);
				}
				if (latest) message = undefined;
			}
			publish();
		},
		editValue(uuid: string, value: string) {
			dirtyValues = { ...dirtyValues, [uuid]: value };
			draft = { ...draft, values: { ...draft.values, [uuid]: value } };
			publish();
		},
		async saveValue(uuid: string, value: string) {
			dirtyValues = { ...dirtyValues, [uuid]: value };
			draft = {
				...draft,
				values: valuesForLevel(properties, draft.levelUuid, {
					...draft.values,
					[uuid]: value,
				}),
			};
			if (dirtyPlacement()) {
				valuesNeedApply = true;
				publish();
				return;
			}
			if (refuseConflict()) return;
			const save = capture();
			const submittedLevel = draft.levelUuid;
			const result = await request(() =>
				writer().update(initial.id, {
					valuePatch: { [uuid]: value === "" ? null : value },
				}),
			);
			if (current(save)) {
				if (!result.ok) message = result.message;
				else if (
					source.levelUuid === save.before.levelUuid &&
					accept(save, result.location) &&
					draft.levelUuid === submittedLevel
				) {
					if (dirtyValues[uuid] === value) {
						dirtyValues = { ...dirtyValues };
						delete dirtyValues[uuid];
					}
					if (result.location !== undefined)
						draft = {
							...draft,
							values: valuesForLevel(properties, draft.levelUuid, {
								...result.location.values,
								...dirtyValues,
							}),
						};
					valuesNeedApply = Object.keys(dirtyValues).length > 0;
					message = undefined;
				}
			}
			publish();
		},
		stageLevel(levelUuid: string, parentId: string | null) {
			draft = {
				...draft,
				levelUuid,
				parentId,
				values: valuesForLevel(properties, levelUuid, draft.values),
			};
			dirtyValues = valuesForLevel(properties, levelUuid, dirtyValues);
			if (!dirtyPlacement() && valuesDiffer()) valuesNeedApply = true;
			publish();
		},
		stageParent(parentId: string | null) {
			draft = { ...draft, parentId };
			publish();
		},
		async applyPlacement() {
			if (refuseConflict()) return;
			const submitted = {
				levelUuid: draft.levelUuid,
				parentId: draft.parentId,
				values: valuesForLevel(properties, draft.levelUuid, draft.values),
			};
			const clock = clocks.placement;
			const generation = ++clock.generation;
			clock.pending += 1;
			const save = capture();
			const result = await request(() =>
				writer().update(initial.id, submitted),
			);
			clock.pending -= 1;
			const latest = current(save) && generation === clock.generation;
			if (!result.ok) {
				if (latest) message = result.message;
			} else if (
				accept(save, result.location) &&
				result.location !== undefined
			) {
				if (
					latest &&
					draft.levelUuid === submitted.levelUuid &&
					draft.parentId === submitted.parentId &&
					sameValues(draft.values, submitted.values)
				) {
					draft = {
						...draft,
						levelUuid: result.location.levelUuid,
						parentId: result.location.parentId,
						values: valuesForLevel(
							properties,
							result.location.levelUuid,
							result.location.values,
						),
					};
					dirtyValues = {};
					valuesNeedApply = false;
				} else {
					valuesNeedApply = Object.keys(dirtyValues).length > 0;
				}
				if (latest) message = undefined;
			}
			publish();
		},
		async move(afterSiblingId: string | null | undefined) {
			if (refuseConflict()) return;
			const save = capture();
			const result = await request(() =>
				writer().move(initial.id, {
					parentId: source.parentId,
					...(afterSiblingId === undefined ? {} : { afterSiblingId }),
				}),
			);
			if (current(save)) {
				if (!result.ok) message = result.message;
				else if (accept(save, result.location)) message = undefined;
			}
			publish();
		},
		adoptLatest() {
			invalidate();
			adopt(incoming);
			message = undefined;
			publish();
		},
		keepDraft() {
			invalidate();
			const previous = source;
			const latest = rowDraft(incoming, properties);
			const rebased = { ...draft };
			for (const key of scalars) {
				if (draft[key] === (previous[key] ?? "")) rebased[key] = latest[key];
			}
			if (draft.levelUuid === previous.levelUuid)
				rebased.levelUuid = latest.levelUuid;
			if (draft.parentId === previous.parentId)
				rebased.parentId = latest.parentId;
			const editedValues = Object.fromEntries(
				Object.entries(dirtyValues).filter(
					([uuid, value]) => value !== (previous.values[uuid] ?? ""),
				),
			);
			rebased.values = valuesForLevel(properties, rebased.levelUuid, {
				...incoming.values,
				...editedValues,
			});
			dirtyValues = Object.fromEntries(
				Object.entries(
					valuesForLevel(properties, rebased.levelUuid, editedValues),
				).filter(([uuid, value]) => value !== (incoming.values[uuid] ?? "")),
			);
			dirtyScalars = new Set(
				scalars.filter((key) => rebased[key] !== latest[key]),
			);
			draft = rebased;
			valuesNeedApply = Object.keys(dirtyValues).length > 0;
			source = incoming;
			localSaves = [];
			clearPeer();
			message = undefined;
			publish();
		},
		discardHiddenValues() {
			dirtyValues = valuesForLevel(properties, draft.levelUuid, dirtyValues);
			draft = {
				...draft,
				values: valuesForLevel(properties, draft.levelUuid, {
					...source.values,
					...dirtyValues,
				}),
			};
			valuesNeedApply = dirtyPlacement() && Object.keys(dirtyValues).length > 0;
			message = undefined;
			publish();
		},
	};
}
