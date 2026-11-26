/**
 * The target-identity record: where CommCare HQ keeps the things of one
 * deployment that the document does not hold. The id of every menu and form
 * that is not its derivation, the id prefix each create keyed by an answer
 * writes its cases under, the path each media file is kept at, and the word
 * each case list column over a property CommCare HQ names by two words keeps
 * its field under where it is not the word Nova writes.
 *
 * One record, with one function per step. A reading is turned into
 * identities only by `observedTargetIdentity`, and one rule,
 * `resolveTargetIdentity`, decides what stands after a reading: the birth
 * resolves over nothing, a bring-in of changes over the stored record.
 * `store.ts::writeTargetIdentityInTransaction` is the one writer and
 * `store.ts::readTargetIdentity` the one reader. `exportIdentityOf` is the one
 * projection a publish, a `.ccz`, the HQ import file, preflight's export
 * boundary and a take's ownership print under. A bring-in's review digest
 * binds the record the birth writes, the same observation through the same
 * rule with each file named by its content (`reading/gather.ts`), so what the
 * person reviewed and what the birth writes are one value.
 *
 * Pure: it reads no store and asks CommCare HQ nothing.
 */

import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import { projectSearchRequestParameters } from "@/lib/commcare/hq/projectSearch";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import type { ReadMenuAndFormIdentities } from "@/lib/commcare/reader";
import {
	hqColumnFieldText,
	isWrittenColumnFieldWord,
} from "@/lib/commcare/suite/wire";
import {
	type ColumnFieldWordRow,
	type ColumnScreen,
	derivedFormXmlns,
	derivedUniqueId,
	type ProjectSearchBinding,
	targetWireIdentity,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { BlueprintDoc } from "@/lib/domain";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { columnFieldText, projectSearchOf } from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { projectSearchUses } from "@/lib/domain/projectSearches";
import { asUuid, type Uuid } from "@/lib/domain/uuid";
import {
	type AdoptedKeyedCaseId,
	type AdoptedMediaFile,
	adoptedIdentityRows,
	assignMediaPaths,
	keyedCaseIdPrefixesFor,
} from "./adoption";
import { wirePathKey } from "./hqMedia";
import type { DeploymentIdentityOverride } from "./types";

/** Ascending UTF-16 code-unit order, the order every list here is kept in. */
function codeUnitOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** One file's held path, as a deployment stores it. */
export interface HeldMediaPath {
	readonly assetId: MediaAssetId;
	readonly wirePath: string;
}

/**
 * What a deployment holds of where CommCare HQ keeps things: only what is
 * not the derivation, each list in its canonical order (entities by kind then
 * UUID, keyed creates by operation, media paths by path, column words by
 * column then screen).
 */
export interface TargetIdentity {
	readonly entities: readonly DeploymentIdentityOverride[];
	readonly keyedCaseIds: readonly AdoptedKeyedCaseId[];
	readonly mediaPaths: readonly HeldMediaPath[];
	/** Each column's word on a screen where it is not the word Nova writes (`suite/wire.ts::hqColumnFieldText`). */
	readonly columnWords: readonly ColumnFieldWordRow[];
	readonly projectSearches?: readonly ProjectSearchBinding[];
}

/** A deployment that holds nothing that is not the derivation. */
export const EMPTY_TARGET_IDENTITY: TargetIdentity = {
	entities: [],
	keyedCaseIds: [],
	mediaPaths: [],
	columnWords: [],
};

/**
 * Everything one reading saw, unreduced: every menu and form it names with
 * the ids CommCare HQ holds, derived ones included, every keyed create with
 * its prefix, and the path each file it names is kept at
 * (`adoption.ts::assignMediaPaths`), with the file's content so its
 * derivation is known.
 */
export interface ObservedTargetIdentity {
	readonly entities: readonly DeploymentIdentityOverride[];
	readonly keyedCreates: ReadMenuAndFormIdentities["keyedCreates"];
	readonly mediaPaths: readonly (HeldMediaPath & {
		readonly derivedPath: string;
		/**
		 * The file's other paths CommCare HQ holds that a file could keep
		 * (`MediaPathAssignment.collapsed`), where it holds it under several.
		 */
		readonly alsoAt: readonly string[];
	})[];
	/**
	 * Every path CommCare HQ's media map holds, without `jr://file/`, whatever
	 * file stands there: a reading judges only the files it may take, so a
	 * stored path it does not name is gone from CommCare HQ only where the map
	 * no longer holds it.
	 */
	readonly hqPaths: readonly string[];
	/**
	 * The word each column the document holds is kept under on each screen
	 * where the source keeps it over a property HQ names by two words, the
	 * word Nova writes included (`ReadMenuAndFormIdentities.columnFieldWords`).
	 */
	readonly columnWords: readonly ColumnFieldWordRow[];
	readonly projectSearches?: readonly ProjectSearchBinding[];
}

/**
 * The record in its canonical order: two records that hold the same rows are
 * equal as values (`sameTargetIdentity`), and a digest of one is a digest of
 * its rows.
 */
export function canonicalTargetIdentity(
	record: TargetIdentity,
): TargetIdentity {
	return {
		...(record.projectSearches?.length
			? {
					projectSearches: [...record.projectSearches].sort((a, b) =>
						codeUnitOrder(a.searchUuid, b.searchUuid),
					),
				}
			: {}),
		entities: [...record.entities].sort(
			(a, b) =>
				codeUnitOrder(a.entityKind, b.entityKind) ||
				codeUnitOrder(a.novaEntityUuid, b.novaEntityUuid),
		),
		keyedCaseIds: [...record.keyedCaseIds].sort((a, b) =>
			codeUnitOrder(a.operationUuid, b.operationUuid),
		),
		mediaPaths: [...record.mediaPaths].sort(
			(a, b) =>
				codeUnitOrder(a.wirePath, b.wirePath) ||
				codeUnitOrder(a.assetId, b.assetId),
		),
		columnWords: [...record.columnWords].sort(
			(a, b) =>
				codeUnitOrder(a.columnUuid, b.columnUuid) ||
				codeUnitOrder(a.screen, b.screen),
		),
	};
}

/** Whether two records hold the same rows. */
export function sameTargetIdentity(
	a: TargetIdentity,
	b: TargetIdentity,
): boolean {
	return (
		JSON.stringify(canonicalTargetIdentity(a)) ===
		JSON.stringify(canonicalTargetIdentity(b))
	);
}

/**
 * What a reading observed of where CommCare HQ keeps things: the reader's
 * identities over CommCare HQ's application resource (`aligned`, which holds
 * each form's real id), restricted to the entities, operations and case list
 * columns `doc` holds, and the paths of `mediaFiles`, the files the reading
 * names that the document keeps. `ok: false` where a form of the reading has no real id,
 * naming where.
 */
export function observedTargetIdentity(input: {
	readonly read: ReadMenuAndFormIdentities;
	readonly aligned: readonly HqAlignedModule[];
	readonly mediaFiles: readonly AdoptedMediaFile[];
	/** CommCare HQ's media map as the source holds it. */
	readonly mediaMap: readonly { readonly path: string }[];
	readonly doc: Pick<BlueprintDoc, "modules" | "forms">;
}):
	| { readonly ok: true; readonly observed: ObservedTargetIdentity }
	| { readonly ok: false; readonly at: string } {
	const rows = adoptedIdentityRows(input.read, input.aligned);
	if (!rows.ok) return { ok: false, at: rows.at };
	const holds = new Set<string>([
		...Object.keys(input.doc.modules),
		...Object.keys(input.doc.forms),
	]);
	const columns = new Set<string>(
		Object.values(input.doc.modules).flatMap((module) =>
			(module.caseListConfig?.columns ?? []).map((column) => column.uuid),
		),
	);
	const derivedPaths = new Map(
		input.mediaFiles.map((file) => [
			file.assetId,
			wirePathFor(file.contentHash, file.extension),
		]),
	);
	const assignment = assignMediaPaths(input.mediaFiles);
	const alsoAt = new Map(
		assignment.collapsed.map((one) => [one.assetId, one.dropped]),
	);
	return {
		ok: true,
		observed: {
			entities: rows.rows.filter((row) => holds.has(row.novaEntityUuid)),
			keyedCreates: input.read.keyedCreates.filter((create) =>
				holds.has(create.formUuid),
			),
			mediaPaths: assignment.rows.map((row) => ({
				...row,
				derivedPath: derivedPaths.get(row.assetId) ?? "",
				alsoAt: alsoAt.get(row.assetId) ?? [],
			})),
			hqPaths: input.mediaMap.flatMap((item) =>
				item.path.startsWith(JR_FILE) ? [item.path.slice(JR_FILE.length)] : [],
			),
			projectSearches: input.read.projectSearches ?? [],
			columnWords: input.read.columnFieldWords.filter((row) =>
				columns.has(row.columnUuid),
			),
		},
	};
}

const JR_FILE = "jr://file/";

/** A row with each id equal to its derivation as null, or null where none is left. */
function overrideOf(
	row: DeploymentIdentityOverride,
): DeploymentIdentityOverride | null {
	const uuid = asUuid(row.novaEntityUuid);
	const uniqueId = row.uniqueId === derivedUniqueId(uuid) ? null : row.uniqueId;
	const xmlns =
		row.entityKind === "form" && row.xmlns === derivedFormXmlns(uuid)
			? null
			: row.xmlns;
	if (uniqueId === null && xmlns === null) return null;
	return { ...row, uniqueId, xmlns };
}

/** The prefix `doc`'s app derives for a keyed create. */
function derivedPrefix(
	doc: Pick<BlueprintDoc, "appId">,
	create: ReadMenuAndFormIdentities["keyedCreates"][number],
): string {
	return authoredCaseIdPrefix({
		appId: doc.appId,
		formUuid: create.formUuid,
		operationUuid: create.operationUuid,
		caseType: create.caseType,
	});
}

/**
 * THE ONE RULE: what a deployment holds once a reading is recorded, from what
 * it held (`stored`, the empty record at a birth) and what the reading
 * observed.
 *
 * 1. For each menu, form, keyed create and file the reading names, the
 *    observation is its value. A value equal to its derivation means no row,
 *    so a stored row of an entity the reading now holds under its derivation
 *    is removed.
 * 2. A stored row of something the reading does not name stays (an undo in
 *    Nova that brings it back publishes it as CommCare HQ knew it), unless
 *    the observation takes what the row holds: another entity under its id or
 *    `xmlns`, another keyed create under its prefix, another file at its path
 *    as CommCare HQ's upload matches a path (`hqMedia.ts::wirePathKey`). That
 *    test runs against the whole observation, derived values included. A file
 *    keeps the path it is stored at while CommCare HQ's media map still holds
 *    that path and no other file of the reading stands there, so a path HQ
 *    added beside it moves nothing and a file HQ moved off it follows. A
 *    column's word takes nothing from another column, so a stored word of a
 *    column on a screen the reading does not name always stays.
 * 3. Only then is the result reduced to what differs from the derivation: a
 *    column's word that is the one Nova writes means no row.
 *
 * `doc` is the document the reading's identities are of, whose app id a keyed
 * create's derivation reads.
 */
export function resolveTargetIdentity(
	stored: TargetIdentity,
	observed: ObservedTargetIdentity,
	doc: Pick<BlueprintDoc, "appId">,
	publishedSearches: readonly ProjectSearchBinding[] = [],
): TargetIdentity {
	// Menus and forms.
	const keyOf = (kind: string, value: string) => `${kind}\u0000${value}`;
	const named = new Set(
		observed.entities.map((row) => keyOf(row.entityKind, row.novaEntityUuid)),
	);
	const takenIds = new Set(
		observed.entities.flatMap((row) =>
			row.uniqueId === null ? [] : [keyOf(row.entityKind, row.uniqueId)],
		),
	);
	const takenXmlns = new Set(
		observed.entities.flatMap((row) => (row.xmlns === null ? [] : [row.xmlns])),
	);
	const entities: DeploymentIdentityOverride[] = [];
	for (const row of observed.entities) {
		const override = overrideOf(row);
		if (override !== null) entities.push(override);
	}
	for (const row of stored.entities) {
		if (named.has(keyOf(row.entityKind, row.novaEntityUuid))) continue;
		if (
			row.uniqueId !== null &&
			takenIds.has(keyOf(row.entityKind, row.uniqueId))
		)
			continue;
		if (row.xmlns !== null && takenXmlns.has(row.xmlns)) continue;
		entities.push(row);
	}

	// Keyed creates.
	const observedOperations = new Set(
		observed.keyedCreates.map((create) => create.operationUuid),
	);
	const takenPrefixes = new Set(
		observed.keyedCreates.map((create) => create.prefix),
	);
	const keyedCaseIds: AdoptedKeyedCaseId[] = [];
	for (const create of observed.keyedCreates) {
		if (create.prefix === derivedPrefix(doc, create)) continue;
		keyedCaseIds.push({
			operationUuid: create.operationUuid,
			caseType: create.caseType,
			prefix: create.prefix,
		});
	}
	for (const row of stored.keyedCaseIds) {
		if (observedOperations.has(row.operationUuid)) continue;
		if (takenPrefixes.has(row.prefix)) continue;
		keyedCaseIds.push(row);
	}

	// Media paths.
	const observedAssets = new Set(observed.mediaPaths.map((row) => row.assetId));
	const takenPaths = new Set(
		observed.mediaPaths.flatMap((row) =>
			[row.wirePath, row.derivedPath, ...row.alsoAt].map(wirePathKey),
		),
	);
	const storedPath = new Map(
		stored.mediaPaths.map((row) => [row.assetId, row.wirePath]),
	);
	const hqPaths = new Set(observed.hqPaths.map(wirePathKey));
	const claimedBy = new Map<string, string>();
	for (const row of observed.mediaPaths)
		for (const one of [row.wirePath, ...row.alsoAt])
			claimedBy.set(wirePathKey(one), row.assetId);
	const mediaPaths: HeldMediaPath[] = [];
	for (const row of observed.mediaPaths) {
		const held = storedPath.get(row.assetId);
		const claimant =
			held === undefined ? undefined : claimedBy.get(wirePathKey(held));
		const keepsHeld =
			held !== undefined &&
			hqPaths.has(wirePathKey(held)) &&
			(claimant === undefined || claimant === row.assetId);
		const wirePath = keepsHeld ? held : row.wirePath;
		if (wirePath === row.derivedPath) continue;
		mediaPaths.push({ assetId: row.assetId, wirePath });
	}
	for (const row of stored.mediaPaths) {
		if (observedAssets.has(row.assetId)) continue;
		if (takenPaths.has(wirePathKey(row.wirePath))) continue;
		mediaPaths.push(row);
	}

	// Column field words.
	const wordKey = (row: { columnUuid: string; screen: ColumnScreen }) =>
		`${row.columnUuid}\u0000${row.screen}`;
	const observedWords = new Set(observed.columnWords.map(wordKey));
	const columnWords: ColumnFieldWordRow[] = observed.columnWords
		.filter((row) => !isWrittenColumnFieldWord(row.word))
		.map(({ columnUuid, screen, word }) => ({ columnUuid, screen, word }));
	for (const row of stored.columnWords)
		if (!observedWords.has(wordKey(row))) columnWords.push(row);

	// Taking an unrelated edit from HQ must preserve a contributor's binding
	// for the next publish, including an intentional disconnection.
	const published = new Map(
		publishedSearches.map((row) => [row.searchUuid, row.endpointId]),
	);
	const searches = (observed.projectSearches ?? []).filter(
		(row) => published.get(row.searchUuid) !== row.endpointId,
	);
	const observedIds = new Set(searches.map((row) => row.endpointId));
	const observedUuids = new Set(searches.map((row) => row.searchUuid));
	const projectSearches = [
		...searches,
		...(stored.projectSearches ?? []).filter(
			(row) =>
				!observedIds.has(row.endpointId) && !observedUuids.has(row.searchUuid),
		),
	];
	return canonicalTargetIdentity({
		entities,
		keyedCaseIds,
		mediaPaths,
		columnWords,
		projectSearches,
	});
}

/** What every export made for one deployment prints under. */
export interface ExportIdentity {
	/** Every menu's and form's id and `xmlns`, and the word each case list column's field keeps (`ExpandOptions.identity`, `CompileOptions.identity`). */
	readonly identity: WireIdentity;
	/**
	 * The prefix of each keyed create whose operation `doc` still holds with
	 * the case type the prefix was derived with (`ExpandOptions.keyedCaseIdPrefixes`).
	 */
	readonly keyedCaseIdPrefixes: ReadonlyMap<Uuid, string>;
	/** The path each held file goes out at (the export boundary's `heldMediaPaths`). */
	readonly heldMediaPaths: ReadonlyMap<MediaAssetId, string>;
}

/**
 * THE ONE PROJECTION: what a publish, a `.ccz`, the HQ import file, preflight's
 * export boundary and a take's ownership print `doc` under for a deployment
 * that holds `record`. Everything the record does not name takes its
 * derivation.
 */
export function exportIdentityOf(
	doc: BlueprintDoc,
	record: TargetIdentity,
): ExportIdentity {
	return {
		identity: targetWireIdentity(
			record.entities,
			record.columnWords,
			record.projectSearches,
		),
		keyedCaseIdPrefixes: keyedCaseIdPrefixesFor(doc, record.keyedCaseIds),
		heldMediaPaths: new Map(
			record.mediaPaths.map((row) => [row.assetId, row.wirePath]),
		),
	};
}

/** Each logical search and its contract on this one project space. */
export function projectSearchDestinationRows(
	doc: BlueprintDoc,
	bindings: readonly ProjectSearchBinding[] = [],
) {
	const uses = projectSearchUses(doc);
	const ids = new Map(bindings.map((row) => [row.searchUuid, row.endpointId]));
	const menusBySearch = Map.groupBy(uses, (use) => use.searchUuid);
	// A saved connection can outlive its last menu or the search itself.
	// Include it in this target's review so an editor can free that ID.
	for (const uuid of ids.keys()) {
		if (!menusBySearch.has(uuid)) menusBySearch.set(uuid, []);
	}
	return Array.from(menusBySearch, ([searchUuid, menus]) => ({
		searchUuid,
		name:
			menus[0]?.name ??
			doc.appSettings.projectSearches?.[searchUuid]?.name ??
			"Removed search",
		endpointId: ids.get(searchUuid) ?? null,
		menus: menus.map((use) => ({
			menuUuid: use.menuUuid,
			name: use.menu,
			parameters: projectSearchRequestParameters(use),
			results: use.results,
		})),
	}));
}

export interface SearchDestinationChange {
	readonly menu: string;
	readonly before: {
		searchUuid: Uuid;
		name: string;
		id: number | null;
		parameters: readonly string[];
		results: readonly import("@/lib/domain/projectSearches").ProjectSearchResultField[];
	} | null;
	readonly after: {
		searchUuid: Uuid;
		name: string;
		id: number | null;
		parameters: readonly string[];
		results: readonly import("@/lib/domain/projectSearches").ProjectSearchResultField[];
	} | null;
}
export function observedSearchChanges(
	held: BlueprintDoc,
	oldBindings: readonly ProjectSearchBinding[],
	doc: BlueprintDoc,
	newBindings: readonly ProjectSearchBinding[],
): SearchDestinationChange[] {
	const searchFacts = (
		blueprint: BlueprintDoc,
		bindings: readonly ProjectSearchBinding[],
	) => {
		const ids = new Map(
			bindings.map((row) => [row.searchUuid, row.endpointId]),
		);
		return new Map(
			projectSearchUses(blueprint).map((use) => {
				const module = blueprint.modules[use.menuUuid];
				const view = {
					searchUuid: use.searchUuid,
					name: use.name,
					id: ids.get(use.searchUuid) ?? null,
					parameters: projectSearchRequestParameters(use),
					results: use.results,
				};
				return [
					use.menuUuid,
					{
						menu: use.menu,
						view,
						contract: {
							search: projectSearchOf(module),
							inputs: module.caseListConfig?.searchInputs,
							excludedOwners: module.caseSearchConfig?.excludedOwnerIds,
						},
					},
				] as const;
			}),
		);
	};
	const oldSearches = searchFacts(held, oldBindings);
	const newSearches = searchFacts(doc, newBindings);
	const projectSearches: SearchDestinationChange[] = [];
	for (const uuid of new Set([...oldSearches.keys(), ...newSearches.keys()])) {
		const prior = oldSearches.get(uuid);
		const now = newSearches.get(uuid);
		if (
			deepEqual(prior?.view, now?.view) &&
			deepEqual(prior?.contract, now?.contract)
		)
			continue;
		if (!now && !prior) continue;
		projectSearches.push({
			menu: now?.menu ?? prior?.menu ?? "",
			before: prior?.view ?? null,
			after: now?.view ?? null,
		});
	}
	return projectSearches;
}
export interface SearchConnectionChange {
	readonly searchUuid: Uuid;
	readonly name: string;
	readonly before: number | null;
	readonly after: number | null;
}

/** What changed between two records, as a review names it to a person. */
export interface TargetIdentityChanges {
	/** The forms `doc` holds whose id in CommCare HQ moved, by name. */
	readonly formIds: readonly string[];
	/** The forms whose keyed creates moved to another case id prefix, by name. */
	readonly keyedPrefixes: readonly string[];
	/** How many files CommCare HQ now keeps at another path. */
	readonly mediaPaths: number;
	/** The menus whose case list keeps a column's property under another word, by name. */
	readonly columnFields: readonly string[];
	readonly searchConnections?: readonly SearchConnectionChange[];
}

/**
 * Where `next` holds another id than `stored` for something the app held
 * before the reading (`held`, the head), as `doc` (the document the reading
 * leaves) prints it: a form's id, a keyed create's prefix, a file's path, a
 * case list column's field on either screen.
 * Something new in the reading is a change to the app, which the review lists
 * as such, and is not named here.
 */
export function targetIdentityChanges(
	stored: TargetIdentity,
	next: TargetIdentity,
	doc: BlueprintDoc,
	held: BlueprintDoc,
	assetNames?: ReadonlyMap<MediaAssetId, MediaAssetId>,
): TargetIdentityChanges {
	const before = exportIdentityOf(doc, stored);
	const after = exportIdentityOf(doc, next);
	const heldForms = (Object.keys(doc.forms) as Uuid[]).filter((formUuid) =>
		Object.hasOwn(held.forms, formUuid),
	);
	const nameOf = (formUuid: Uuid) => doc.forms[formUuid]?.name ?? "";
	const formIds: string[] = [];
	const keyedPrefixes = new Set<string>();
	for (const formUuid of heldForms) {
		if (
			before.identity.formUniqueId(formUuid) !==
			after.identity.formUniqueId(formUuid)
		)
			formIds.push(nameOf(formUuid));
		for (const operation of doc.forms[formUuid]?.caseOperations ?? []) {
			if (
				before.keyedCaseIdPrefixes.get(operation.uuid) !==
				after.keyedCaseIdPrefixes.get(operation.uuid)
			)
				keyedPrefixes.add(nameOf(formUuid));
		}
	}
	const heldAssets: ReadonlySet<string> = new Set(
		[...collectAssetRefs(held)].map((id) =>
			isBuiltinIconRef(id) ? id : (assetNames?.get(id) ?? id),
		),
	);
	let mediaPaths = 0;
	for (const assetId of new Set([
		...before.heldMediaPaths.keys(),
		...after.heldMediaPaths.keys(),
	])) {
		if (
			heldAssets.has(assetId) &&
			before.heldMediaPaths.get(assetId) !== after.heldMediaPaths.get(assetId)
		)
			mediaPaths += 1;
	}
	const columnFields = new Set<string>();
	for (const [moduleUuid, module] of Object.entries(doc.modules)) {
		const heldColumns = new Set(
			(held.modules[moduleUuid]?.caseListConfig?.columns ?? []).map(
				(column) => column.uuid,
			),
		);
		for (const column of module.caseListConfig?.columns ?? []) {
			if (column.kind === "calculated" || !heldColumns.has(column.uuid))
				continue;
			const text = columnFieldText(column);
			for (const screen of ["short", "long"] as const)
				if (
					hqColumnFieldText(
						text,
						before.identity.columnFieldWord(column.uuid, screen),
					) !==
					hqColumnFieldText(
						text,
						after.identity.columnFieldWord(column.uuid, screen),
					)
				)
					columnFields.add(module.name);
		}
	}
	const oldConnections = new Map(
		stored.projectSearches?.map((row) => [row.searchUuid, row.endpointId]),
	);
	const newConnections = new Map(
		next.projectSearches?.map((row) => [row.searchUuid, row.endpointId]),
	);
	const searchConnections: SearchConnectionChange[] = [];
	for (const searchUuid of new Set([
		...oldConnections.keys(),
		...newConnections.keys(),
	])) {
		const before = oldConnections.get(searchUuid) ?? null;
		const after = newConnections.get(searchUuid) ?? null;
		if (before === after) continue;
		const name =
			doc.appSettings.projectSearches?.[searchUuid]?.name ??
			held.appSettings.projectSearches?.[searchUuid]?.name ??
			"Previously connected search";
		searchConnections.push({ searchUuid, name, before, after });
	}

	return {
		...(searchConnections.length && { searchConnections }),
		formIds: [...formIds].sort(codeUnitOrder),
		keyedPrefixes: [...keyedPrefixes].sort(codeUnitOrder),
		mediaPaths,
		columnFields: [...columnFields].sort(codeUnitOrder),
	};
}

/**
 * Whether CommCare HQ's application resource (`aligned`) gives each form the
 * id the stored record resolves for it, matched by `xmlns`. A save that
 * changes nothing but a form's id normalizes to the same source, so this is
 * what tells such a save from no save. A menu HQ could not summarize says
 * nothing, and neither does an `xmlns` two of HQ's forms share.
 */
export function formIdsAgree(
	doc: BlueprintDoc,
	record: TargetIdentity,
	aligned: readonly HqAlignedModule[],
): boolean {
	const { identity } = exportIdentityOf(doc, record);
	const byXmlns = new Map<string, string>();
	for (const form of Object.values(doc.forms))
		byXmlns.set(identity.formXmlns(form), identity.formUniqueId(form.uuid));
	/* A shadow form stands under its parent's `xmlns`, so an `xmlns` two forms
	 * of HQ's app share names neither by itself. */
	const forms = aligned.flatMap((module) =>
		module.kind === "aligned" ? module.forms : [],
	);
	const shared = new Map<string, number>();
	for (const form of forms)
		if (form.xmlns !== null)
			shared.set(form.xmlns, (shared.get(form.xmlns) ?? 0) + 1);
	for (const form of forms) {
		if (form.xmlns === null || shared.get(form.xmlns) !== 1) continue;
		const held = byXmlns.get(form.xmlns);
		if (held !== undefined && held !== form.uniqueId) return false;
	}
	return true;
}
