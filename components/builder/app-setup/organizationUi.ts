import {
	ancestorLevels,
	LEVEL_CODE_MAX_LENGTH,
	type LocationProperty,
	levelOwnsCases,
	type OrganizationLevel,
	orderedOrganizationLevels,
	organizationLevelsOf,
} from "@/lib/domain";
import type {
	ManagedPlacesContext,
	OrganizationRuleInputs,
} from "@/lib/organization/ownerTargetVerdicts";
import type {
	OrganizationSnapshot,
	StoredLocation,
} from "@/lib/organization/types";
import { locationValueCatalogIssueForProperties } from "@/lib/organization/valueCatalog";
import { managedOrganizationCommitRefusal } from "@/lib/publish/managedData";

export const PERSONA_LOCATION_PAGE_SIZE = 50;

/** Derive a valid, collision-free, fixed identity without exceeding HQ's cap. */
export function uniqueLevelCode(
	name: string,
	peers: readonly OrganizationLevel[],
): string {
	const taken = new Set(peers.map((peer) => peer.code));
	const derived =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "level";
	const safe = /^[a-z_]/.test(derived) ? derived : `l_${derived}`;
	const base = safe.slice(0, LEVEL_CODE_MAX_LENGTH);
	if (!taken.has(base)) return base;
	for (let number = 2; ; number++) {
		const suffix = `_${number}`;
		const candidate = `${base.slice(0, LEVEL_CODE_MAX_LENGTH - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Keep a maximum-size persona's authored place rows bounded in the DOM. */
export function personaLocationPage(
	locationIds: readonly string[],
	requestedPage: number,
): {
	readonly ids: readonly string[];
	readonly page: number;
	readonly pageCount: number;
	readonly start: number;
} {
	const pageCount = Math.max(
		1,
		Math.ceil(locationIds.length / PERSONA_LOCATION_PAGE_SIZE),
	);
	const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
	const start = page * PERSONA_LOCATION_PAGE_SIZE;
	return {
		ids: locationIds.slice(start, start + PERSONA_LOCATION_PAGE_SIZE),
		page,
		pageCount,
		start,
	};
}

/** Place-information fields that apply to one level, in authored order. */
export function propertiesForLevel(
	properties: readonly LocationProperty[],
	levelUuid: string,
): readonly LocationProperty[] {
	return properties.filter(
		(property) =>
			property.levelUuids === undefined ||
			property.levelUuids.some((uuid) => uuid === levelUuid),
	);
}

/** Keep only values the chosen level's current catalog can name. */
export function valuesForLevel(
	properties: readonly LocationProperty[],
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): Record<string, string> {
	const allowed = new Set<string>(
		propertiesForLevel(properties, levelUuid).map((property) => property.uuid),
	);
	return Object.fromEntries(
		Object.entries(values).filter(([uuid]) => allowed.has(uuid)),
	);
}

/** Required place information is the only extra create-form completeness gate. */
export function requiredValuesPresent(
	properties: readonly LocationProperty[],
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): boolean {
	return propertiesForLevel(properties, levelUuid).every(
		(property) =>
			property.required !== true || (values[property.uuid] ?? "") !== "",
	);
}

export interface RequiredReverseHopDescendant {
	/** Presentation-only path for keyed draft controls; never sent to a writer. */
	readonly uiPath: string;
	readonly level: OrganizationLevel;
	readonly depth: number;
	readonly descendants: readonly RequiredReverseHopDescendant[];
}

/**
 * Descendants a new root must carry in the SAME create transaction so every
 * authored reverse-hop case-owner rule remains total. A destination can itself
 * be the source for a deeper rule, so this is a tree rather than one flat row.
 */
export function requiredReverseHopDescendants(
	doc: OrganizationRuleInputs,
	rootLevelUuid: string,
): readonly RequiredReverseHopDescendant[] {
	const levels = organizationLevelsOf(doc);
	const destinationUuids = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (
				owner?.kind === "term" &&
				owner.term.kind === "owner-location-at-level"
			) {
				destinationUuids.add(owner.term.levelUuid);
			}
		}
	}
	const destinationsBySource = new Map<string, OrganizationLevel[]>();
	for (const destination of orderedOrganizationLevels(doc)) {
		if (!destinationUuids.has(destination.uuid)) continue;
		const source = ancestorLevels(destination, levels).find(levelOwnsCases);
		if (source === undefined) continue;
		const destinations = destinationsBySource.get(source.uuid) ?? [];
		destinations.push(destination);
		destinationsBySource.set(source.uuid, destinations);
	}

	const visit = (
		sourceLevelUuid: string,
		depth: number,
		parentPath: string,
	): readonly RequiredReverseHopDescendant[] =>
		(destinationsBySource.get(sourceLevelUuid) ?? []).map(
			(destination, index) => {
				const uiPath =
					parentPath === "" ? String(index) : `${parentPath}.${index}`;
				return {
					uiPath,
					level: destination,
					depth,
					descendants: visit(destination.uuid, depth + 1, uiPath),
				};
			},
		);
	return visit(rootLevelUuid, 0, "");
}

export function flattenRequiredReverseHopDescendants(
	descendants: readonly RequiredReverseHopDescendant[],
): readonly RequiredReverseHopDescendant[] {
	const out: RequiredReverseHopDescendant[] = [];
	const visit = (entries: readonly RequiredReverseHopDescendant[]) => {
		for (const entry of entries) {
			out.push(entry);
			visit(entry.descendants);
		}
	};
	visit(descendants);
	return out;
}

/**
 * What the Organization banner offers in place of a refresh of places
 * CommCare HQ manages: a member who can't edit is told who can, and one with
 * no CommCare HQ connection on the places' server is invited to connect,
 * since the refresh reads CommCare HQ with their own account.
 */
export function managedPlacesRefreshControl(
	connected: boolean,
	canEdit: boolean,
): "offered" | "connect" | "needs-editor" {
	if (!canEdit) return "needs-editor";
	return connected ? "offered" : "connect";
}

/**
 * Where CommCare HQ manages the app's places, as the builder's prechecks and
 * `organizationLevelPatchIssue` take it, from the organization snapshot's
 * `hq`; `undefined` where Nova manages them.
 */
export function managedPlacesContext(
	hq: OrganizationSnapshot["hq"],
): ManagedPlacesContext | undefined {
	return hq === undefined
		? undefined
		: { domain: hq.domain, goneIds: new Set(hq.goneIds) };
}

/**
 * Whether a place holds an organization change back, as the commit's own
 * checks decide (`lib/organization/commitIntegrity.ts::blocksChange`): every
 * place, archived ones included, except an archived place in a copy CommCare
 * HQ manages. That is a place CommCare HQ no longer lists, which no one can
 * bring back or move in Nova, and a refresh that restores it rewrites its
 * level, parent and values from CommCare HQ's list.
 */
export function placeBlocksChange(
	location: Pick<StoredLocation, "archivedAt">,
	managed: ManagedPlacesContext | undefined,
): boolean {
	return managed === undefined || location.archivedAt === null;
}

/** A level that places stand at, so it can't be removed. */
export interface LevelOccupancy {
	/**
	 * Where CommCare HQ manages the places: every place at the level is one
	 * it no longer has, which the copy keeps only while something in the app
	 * uses it. Always false where Nova manages them.
	 */
	readonly kept: boolean;
}

/**
 * The levels places stand at, by level uuid, counting the places the commit
 * counts ({@link placeBlocksChange}): archived ones too where Nova manages the
 * places, because CommCare's own guard counts them and unarchiving into a
 * removed level would bring back a row pointing at nothing; live ones only
 * where CommCare HQ manages them.
 */
export function levelOccupancy(
	locations: readonly StoredLocation[],
	managed: ManagedPlacesContext | undefined,
): ReadonlyMap<string, LevelOccupancy> {
	const occupancy = new Map<string, LevelOccupancy>();
	for (const location of locations) {
		if (!placeBlocksChange(location, managed)) continue;
		const kept = managed?.goneIds.has(location.id) === true;
		const earlier = occupancy.get(location.levelUuid);
		occupancy.set(location.levelUuid, {
			kept: (earlier?.kept ?? true) && kept,
		});
	}
	return occupancy;
}

/**
 * What Remove level says when its plan refuses the removal, or `undefined`
 * where it doesn't. Places standing at the level are the plan's first
 * refusal. Where CommCare HQ manages the app's places, Nova moves none of
 * them, so that refusal names the way that works: move them in CommCare HQ
 * and refresh, or, where every one is a place CommCare HQ no longer has,
 * change what in the app uses them. Every other refusal is the plan's own.
 */
export function levelRemovalRefusal(
	plan:
		| { readonly ok: true }
		| { readonly ok: false; readonly userMessage: string },
	levelName: string,
	occupancy: LevelOccupancy | undefined,
	managed: ManagedPlacesContext | undefined,
): string | undefined {
	if (plan.ok) return undefined;
	if (occupancy !== undefined && managed !== undefined) {
		return managedOrganizationCommitRefusal(
			{
				kind: "level-in-use",
				levels: [`"${levelName}"`],
				kept: occupancy.kept,
			},
			managed.domain,
		);
	}
	return plan.userMessage;
}

/**
 * What a place information change says before it commits, when some place's
 * values no longer fit the candidate catalog: the first such place the
 * commit's `assertLocationValuesValid` would refuse on
 * ({@link placeBlocksChange}), or `undefined` where none would.
 */
export function placeInformationChangeRefusal(
	candidateProperties: readonly LocationProperty[],
	locations: readonly StoredLocation[],
	managed: ManagedPlacesContext | undefined,
): string | undefined {
	for (const location of locations) {
		if (!placeBlocksChange(location, managed)) continue;
		const issue = locationValueCatalogIssueForProperties(
			candidateProperties,
			location.levelUuid,
			location.values,
		);
		if (issue !== undefined) return placeValueRefusal(location, issue, managed);
	}
	return undefined;
}

/**
 * What a place information change says when a place's value doesn't fit it.
 * `issue` is the value check's own sentence. Where CommCare HQ manages the
 * app's places, the value is changed there and refreshed, or, for a place
 * CommCare HQ no longer has, what in the app uses it is changed.
 */
export function placeValueRefusal(
	location: Pick<StoredLocation, "id" | "name">,
	issue: string,
	managed: ManagedPlacesContext | undefined,
): string {
	const place = `“${location.name}”`;
	return managed === undefined
		? `${place} blocks this change. ${issue}`
		: managedOrganizationCommitRefusal(
				{ kind: "value", place, issue, kept: managed.goneIds.has(location.id) },
				managed.domain,
			);
}
