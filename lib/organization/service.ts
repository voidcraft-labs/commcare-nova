import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import {
	commitGuardedBatchInTransaction,
	loadAppInTransaction,
} from "@/lib/db/apps";
import {
	type AppDatabase,
	type AppLocationsTable,
	withAppTx,
} from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	ancestorLevels,
	assignedLocationUuids,
	asUuid,
	type BlueprintDoc,
	levelMayNestUnder,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";
import { deriveKeyAtIndex } from "@/lib/lookup/orderKeys";
import {
	assertLocationOwnerTargetsValid,
	assertPersonaAssignmentsValid,
	assertReverseHopTargetsUnambiguous,
} from "./commitIntegrity";
import { OrganizationError, organizationNotFound } from "./errors";
import {
	assertSiteCodeFree,
	type CreateLocationInput,
	canonicalCoordinate,
	deriveSiteCode,
	locationValuesSchema,
	MAX_LOCATIONS_PER_APP,
	parseOrganizationRevision,
	type UpdateLocationInput,
} from "./schema";
import type {
	ArchiveImpact,
	OrganizationRevision,
	OrganizationScope,
	OrganizationSnapshot,
	StoredLocation,
} from "./types";
import { locationValueCatalogIssue } from "./valueCatalog";
import {
	assertExpectedOrganizationRevision,
	commitOrganizationChange,
	lockOrganizationForWrite,
} from "./writerTransaction";

type LocationRow = Selectable<AppLocationsTable>;

function toStoredLocation(row: LocationRow): StoredLocation {
	return {
		id: asUuid(row.id),
		levelUuid: row.level_uuid,
		parentId: row.parent_id === null ? null : asUuid(row.parent_id),
		siteCode: row.site_code,
		name: row.name,
		externalId: row.external_id,
		latitude: row.latitude === null ? null : canonicalCoordinate(row.latitude),
		longitude:
			row.longitude === null ? null : canonicalCoordinate(row.longitude),
		values: row.values,
		archivedAt: row.archived_at,
		orderKey: row.order_key,
	};
}

/**
 * Read the whole organization at one revision.
 *
 * One read-only `REPEATABLE READ` transaction, for the reason every other
 * authoritative read in the codebase uses one: two ordinary `READ COMMITTED`
 * statements can pair the locations from generation N with the clock from
 * N+1, and a client that stores that pair is permanently stale with no way to
 * notice.
 *
 * Archived places are INCLUDED. They are part of the organization an author
 * is looking at — an archive is reversible, and hiding one would make
 * unarchiving an affordance with nothing to act on. Every consumer that must
 * exclude them (the owner set, the fixture footprint, the assignment picker)
 * filters on `archivedAt`, which is a decision each of them makes for its own
 * reason rather than one this read makes for all of them.
 */
async function readOrganizationInTransaction(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
): Promise<{
	readonly access: Awaited<ReturnType<typeof resolveAppScopeInTransaction>>;
	readonly snapshot: OrganizationSnapshot;
}> {
	// The action authorized this scope before constructing it, but an app that
	// moved Projects in between must not be readable through the old one. Every
	// WRITE re-proves this under its lock; this read proves it in one snapshot.
	const access = await resolveAppScopeInTransaction(
		tx,
		scope.appId,
		scope.actorUserId,
		"view",
	).catch((error: unknown) => {
		if (error instanceof AppAccessError) {
			throw new OrganizationError(
				"not_found",
				"This app's organization isn't available. It may have been deleted, moved, or you may no longer have access to it.",
			);
		}
		throw error;
	});
	if (access.projectId !== scope.projectId) {
		throw new OrganizationError(
			"not_found",
			"This app's organization isn't available. It may have been deleted or moved to another project — reload to get the latest state.",
		);
	}
	const state = await tx
		.selectFrom("app_organization_state")
		.select("revision")
		.where("app_id", "=", scope.appId)
		.executeTakeFirst();
	const locations = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "=", scope.appId)
		.orderBy("parent_id")
		.orderBy("order_key")
		.orderBy("id")
		.execute();
	return {
		access,
		snapshot: {
			// An app that has never had an organization has no state row, and
			// revision 0 is the honest answer rather than an error.
			revision:
				state === undefined ? "0" : parseOrganizationRevision(state.revision),
			locations: locations.map(toStoredLocation),
		},
	};
}

export async function readOrganization(
	scope: OrganizationScope,
): Promise<OrganizationSnapshot> {
	return withAppTx(
		async (tx) => (await readOrganizationInTransaction(tx, scope)).snapshot,
		{ isolationLevel: "repeatable read" },
	);
}

/**
 * Read the Blueprint organization vocabulary and location rows from the same
 * repeatable-read snapshot. SA/MCP pagination must use this rather than pair a
 * previously loaded Blueprint with a later locations read: either half can
 * change independently, and both generations belong in the continuation
 * cursor.
 */
export async function readOrganizationAuthoringSnapshot(
	scope: OrganizationScope,
): Promise<{
	readonly blueprint: BlueprintDoc;
	readonly blueprintSeq: number;
	readonly organization: OrganizationSnapshot;
}> {
	return withAppTx(
		async (tx) => {
			const { access, snapshot } = await readOrganizationInTransaction(
				tx,
				scope,
			);
			const app = await loadAppInTransaction(tx, scope.appId);
			if (app === null) throw organizationNotFound();
			if (
				app.project_id !== access.projectId ||
				app.mutation_seq !== access.baseSeq
			) {
				throw new Error(
					"Organization authoring snapshot lock invariant failed.",
				);
			}
			return {
				blueprint: hydratePersistedBlueprint(app.blueprint),
				blueprintSeq: access.baseSeq,
				organization: snapshot,
			};
		},
		{ isolationLevel: "repeatable read" },
	);
}

/**
 * Every place in the app, locked for update, as a map plus a child index.
 *
 * The whole tree rather than a recursive query, deliberately: it is bounded
 * by {@link MAX_LOCATIONS_PER_APP}, every write needs the site-code set and
 * the sibling order anyway, and a subtree walk in TypeScript over a map is
 * both simpler to read and impossible to get subtly wrong about cycles.
 */
interface LockedTree {
	readonly byId: Map<string, LocationRow>;
	readonly childrenOf: Map<string | null, LocationRow[]>;
	readonly siteCodes: Set<string>;
}

async function lockTree(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<LockedTree> {
	const rows = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "=", appId)
		.orderBy("order_key")
		.orderBy("id")
		.forUpdate()
		.execute();
	const byId = new Map<string, LocationRow>();
	const childrenOf = new Map<string | null, LocationRow[]>();
	const siteCodes = new Set<string>();
	for (const row of rows) {
		byId.set(row.id, row);
		const siblings = childrenOf.get(row.parent_id);
		if (siblings === undefined) childrenOf.set(row.parent_id, [row]);
		else siblings.push(row);
		siteCodes.add(row.site_code.toLowerCase());
	}
	return { byId, childrenOf, siteCodes };
}

/**
 * A place plus every place under it, the set HQ's own archive walks
 * (`SQLLocation.archive` takes `get_descendants(include_self=True)`).
 *
 * Cycle-tolerant by construction. The parent foreign key plus the
 * create/move rules make a cycle unreachable, but a breadth-first walk with a
 * visited set costs nothing and cannot hang, and this function also runs over
 * rows an operator may have repaired by hand.
 */
function subtreeIds(tree: LockedTree, rootId: string): string[] {
	const collected: string[] = [];
	const seen = new Set<string>();
	const queue = [rootId];
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		if (!tree.byId.has(id)) continue;
		collected.push(id);
		for (const child of tree.childrenOf.get(id) ?? []) queue.push(child.id);
	}
	return collected;
}

/**
 * The order key that places a row after `afterSiblingId` among its siblings.
 *
 * Routed through `keysForSlot`, the collision-safe layer every insert-between
 * gesture in the repo uses, rather than a bare `keyBetween`. Nova's own writes
 * cannot produce two siblings with the same key — each mints against the
 * locked set, and the state-row lock serializes concurrent creates — but
 * `keyBetween` THROWS on a numerically degenerate interval, so a tie from any
 * source at all (a hand-repaired row, a future import path) would turn an
 * ordinary insert into a 500 instead of a placement. `keysForSlot` widens past
 * the tied run to a distinct bound, which is the whole reason it exists.
 */
function orderKeyForSlot(
	tree: LockedTree,
	parentId: string | null,
	afterSiblingId: string | null | undefined,
	/** Excluded from the sibling set — a row being moved within its own parent
	 *  must not be its own neighbour. */
	movingId?: string,
): string {
	const siblings = (tree.childrenOf.get(parentId) ?? []).filter(
		(row) => row.id !== movingId,
	);
	if (afterSiblingId === null) {
		return deriveKeyAtIndex(
			siblings.map((row) => row.order_key),
			0,
		);
	}
	if (afterSiblingId === undefined) {
		return deriveKeyAtIndex(
			siblings.map((row) => row.order_key),
			siblings.length,
		);
	}
	const index = siblings.findIndex((row) => row.id === afterSiblingId);
	if (index === -1) {
		throw new OrganizationError(
			"rejected",
			"The place you asked to put this one after isn't in the same part of the organization. Reload to get the latest places, then try again.",
		);
	}
	return deriveKeyAtIndex(
		siblings.map((row) => row.order_key),
		index + 1,
	);
}

/**
 * The level a new or retyped place stands at must exist in the app's
 * blueprint, and its parent must stand at a level ABOVE that one — any level
 * above, not only the one directly above.
 *
 * **Intermediate levels may be skipped, and that is a real capability rather
 * than a leniency.** Health hierarchies routinely have optional rungs: some
 * regions run districts and some do not, so a facility hangs directly off the
 * region in the second case. The fixture represents that faithfully, because
 * `fixtures.py::_get_fixture_node` blank-fills EVERY level's `{code}_id`
 * attribute before writing self and then each ancestor — so the skipping
 * facility emits `region_id=<region>`, `district_id=''`, `facility_id=<self>`.
 * An expression joining on `district_id` finds nothing for it, which is the
 * truth: it has no district. Requiring a placeholder district would be exactly
 * the hidden scaffolding this program refuses to make an author invent.
 *
 * **What is refused is a level appearing twice in one chain**, and that has a
 * concrete breakage rather than a stylistic one. The attribute writes in that
 * same loop go self-first and then upward, each unconditionally assigning
 * `attrs['{code}_id']` — so an ancestor sharing the child's level code
 * OVERWRITES the child's own id in its own lineage attribute. A facility
 * parented to another facility emits `facility_id = <the parent's id>`, and a
 * two-hop join like `location[@type='facility_data'][@facility_id = <owner>]`
 * then resolves against the wrong element with nothing to signal it. Since two
 * levels can never share a code (`ORGANIZATION_LEVEL_CODE_DUPLICATE`),
 * requiring the parent's level to be a STRICT ANCESTOR of the child's is
 * exactly the condition that keeps every code in a chain distinct.
 *
 * An inverted placement — a district under a facility — is refused by the same
 * rule, and deservedly: it contradicts the hierarchy the author declared, so
 * every footprint and owner-set derivation over it would be reasoning about a
 * shape the document says does not exist.
 *
 * One consequence of allowing ragged trees is worth knowing rather than
 * preventing: HQ's `expand_to` is compared as a DEPTH counted over the
 * location tree against a depth computed over the TYPE tree
 * (`get_location_fixture_ids.sql`), so on a ragged tree a depth cap can carry
 * a place whose level sits below the cap. It over-includes, never
 * under-includes — a payload cost in an address book that carries no cases —
 * and it is HQ's behaviour on any ragged tree rather than something Nova
 * introduces. `include_only`, which `own-branch-limited` compiles to, is keyed
 * on type and is immune.
 */
function assertPlacement(
	doc: BlueprintDoc,
	tree: LockedTree,
	levelUuid: string,
	parentId: string | null,
): void {
	const levels = organizationLevelsOf(doc);
	const level = levels[levelUuid];
	if (level === undefined) {
		// Deliberately does NOT claim the level was removed. This document is the
		// COMMITTED one, and a level the author added moments ago may simply not
		// have been saved yet — the two states are indistinguishable from here,
		// so asserting either one would send the author looking for a co-editor
		// who may not exist. The caller flushes and retries once; reaching this
		// message twice means the save itself is failing, which is what it says.
		throw new OrganizationError(
			"not-committed",
			"Nova hasn't finished saving that level, so a place can't be added to it yet. If this keeps happening, check your connection — your work is still here.",
		);
	}
	const above = ancestorLevels(level, levels);
	if (parentId === null) {
		// A level with something above it needs a place above it. Skipping rungs
		// is fine; skipping the root is not, because the place would float free
		// of every tree the fixture and the footprint walk.
		if (above.length > 0) {
			throw new OrganizationError(
				"rejected",
				`A ${level.name.toLowerCase()} sits under ${above.length === 1 ? `a ${above[0].name.toLowerCase()}` : "a level above it"}, so it needs a parent place. Choose where this one belongs.`,
			);
		}
		return;
	}
	const parent = tree.byId.get(parentId);
	if (parent === undefined) throw organizationNotFound();
	// A live place under an archived one is exactly the state the archive
	// cascade exists to make unreachable: a place is unreachable while any
	// ancestor is archived, which is why unarchive walks ancestors at all. It
	// would be absent from every fixture and footprint while still being
	// offered in the assignment picker and still able to own cases.
	if (parent.archived_at !== null) {
		throw new OrganizationError(
			"rejected",
			`"${parent.name}" is archived, so nothing can sit inside it. Bring it back first, or choose somewhere else.`,
		);
	}
	if (above.length === 0) {
		throw new OrganizationError(
			"rejected",
			`${level.name} is a top level, so a ${level.name.toLowerCase()} can't sit under another place.`,
		);
	}
	if (!levelMayNestUnder(levelUuid, parent.level_uuid, levels)) {
		const parentLevel = levels[parent.level_uuid];
		throw new OrganizationError(
			"rejected",
			`A ${level.name.toLowerCase()} has to sit under one of the levels above it${above.length <= 3 ? ` (${above.map((ancestor) => ancestor.name).join(", ")})` : ""}${parentLevel === undefined ? "" : `, and ${parentLevel.name} isn't one of them`}. Pick a different place for it.`,
		);
	}
}

/**
 * The custom values a place carries must satisfy the catalog that declares
 * them: every required property present, every value inside its declared
 * choices, and nothing recorded against a property that does not apply to the
 * place's level.
 *
 * This is the promise this package's header makes — "a place Nova accepts is a
 * place a push can create" — and without it the failure surfaces at push time,
 * long after the author wrote it, when HQ's own `custom_data_fields` validation
 * rejects the location.
 *
 * `values` is a whole-bag replacement, so the check runs over the bag that is
 * about to be stored rather than the delta.
 */
function assertValuesSatisfyCatalog(
	doc: BlueprintDoc,
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): void {
	const shape = locationValuesSchema.safeParse(values);
	if (!shape.success) {
		throw new OrganizationError(
			"rejected",
			shape.error.issues[0]?.message ??
				"This place carries information Nova cannot store.",
		);
	}
	const issue = locationValueCatalogIssue(doc, levelUuid, values);
	if (issue !== undefined) throw new OrganizationError("rejected", issue);
}

async function loadDocInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<BlueprintDoc> {
	const app = await loadAppInTransaction(tx, appId);
	if (app === null) throw organizationNotFound();
	return hydratePersistedBlueprint(app.blueprint);
}

export interface CreateLocationResult {
	readonly revision: OrganizationRevision;
	readonly location: StoredLocation;
}

export async function createLocation(
	scope: OrganizationScope,
	input: CreateLocationInput,
	expectedRevision?: OrganizationRevision,
): Promise<CreateLocationResult> {
	return withAppTx(async (tx) => {
		const locked = await lockOrganizationForWrite(tx, scope, {
			capability: "edit",
		});
		assertExpectedOrganizationRevision(locked, expectedRevision);
		if (locked.locationCount >= MAX_LOCATIONS_PER_APP) {
			throw new OrganizationError(
				"limit",
				`This app already holds ${MAX_LOCATIONS_PER_APP.toLocaleString()} places, which is as many as Nova stores for one app. Archive places you no longer need, or split the organization across apps.`,
			);
		}
		const tree = await lockTree(tx, scope.appId);
		const doc = await loadDocInTransaction(tx, scope.appId);
		assertPlacement(doc, tree, input.levelUuid, input.parentId);
		assertValuesSatisfyCatalog(doc, input.levelUuid, input.values);

		// Derived when omitted, exactly as `models.py::set_site_code_if_needed`
		// does, and checked against the locked set either way so a concurrent
		// create cannot produce two places with the same code.
		const siteCode =
			input.siteCode === undefined
				? deriveSiteCode(input.name, tree.siteCodes)
				: input.siteCode.toLowerCase();
		if (input.siteCode !== undefined) {
			assertSiteCodeFree(siteCode, tree.siteCodes);
		}

		const inserted = await tx
			.insertInto("app_locations")
			.values({
				app_id: scope.appId,
				level_uuid: asUuid(input.levelUuid),
				parent_id: input.parentId,
				site_code: siteCode,
				name: input.name,
				external_id: input.externalId,
				latitude: input.latitude,
				longitude: input.longitude,
				// A jsonb column crosses Kysely as a string on the way in.
				values: JSON.stringify(input.values),
				order_key: orderKeyForSlot(tree, input.parentId, input.afterSiblingId),
				created_by: scope.actorUserId,
				updated_by: scope.actorUserId,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
		await assertReverseHopTargetsUnambiguous(tx, {
			appId: scope.appId,
			candidateDoc: doc,
		});
		const revision = await commitOrganizationChange(tx, scope, 1);
		return { revision, location: toStoredLocation(inserted) };
	});
}

export interface UpdateLocationResult {
	readonly revision: OrganizationRevision;
	readonly location: StoredLocation;
}

function sameStringRecord(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

export async function updateLocation(
	scope: OrganizationScope,
	locationId: string,
	patch: UpdateLocationInput,
	expectedRevision?: OrganizationRevision,
): Promise<UpdateLocationResult> {
	return withAppTx(async (tx) => {
		const locked = await lockOrganizationForWrite(tx, scope, {
			capability: "edit",
		});
		assertExpectedOrganizationRevision(locked, expectedRevision);
		const tree = await lockTree(tx, scope.appId);
		const current = tree.byId.get(locationId);
		if (current === undefined) throw organizationNotFound();

		const nextLevelUuid = patch.levelUuid ?? current.level_uuid;
		const nextValues: Record<string, string> =
			patch.values ??
			(() => {
				const values = { ...current.values };
				for (const [uuid, value] of Object.entries(patch.valuePatch ?? {})) {
					if (value === null) delete values[uuid];
					else values[uuid] = value;
				}
				return values;
			})();
		const nextParentId =
			patch.parentId === undefined ? current.parent_id : patch.parentId;
		const changesParent =
			patch.parentId !== undefined && nextParentId !== current.parent_id;
		const changesOrder = patch.afterSiblingId !== undefined;
		const changesPlacement = changesParent || changesOrder;
		if (
			patch.values !== undefined ||
			patch.valuePatch !== undefined ||
			patch.levelUuid !== undefined
		) {
			// Re-checked against the level the place will HAVE, so retyping a place
			// into a level its recorded information does not apply to is refused
			// rather than silently leaving values nothing will emit.
			const doc = await loadDocInTransaction(tx, scope.appId);
			assertValuesSatisfyCatalog(doc, nextLevelUuid, nextValues);
		}

		if (
			patch.levelUuid !== undefined &&
			patch.levelUuid !== current.level_uuid
		) {
			// HQ's rule, verbatim in effect: `util.py::get_location_type` refuses a
			// type change on a location with descendants ("You cannot change the
			// location type of a location with children"). A leaf may move rungs;
			// a branch cannot, because its children's levels would no longer sit
			// under their parent's.
			if ((tree.childrenOf.get(locationId) ?? []).length > 0) {
				throw new OrganizationError(
					"rejected",
					`"${current.name}" has places under it, so it can't move to a different level. Move or archive those first.`,
				);
			}
			const doc = await loadDocInTransaction(tx, scope.appId);
			assertPlacement(doc, tree, patch.levelUuid, nextParentId);
		}
		if (changesPlacement) {
			if (
				nextParentId !== null &&
				subtreeIds(tree, locationId).includes(nextParentId)
			) {
				throw new OrganizationError(
					"rejected",
					`"${current.name}" can't move into itself or into a place under it.`,
				);
			}
			const doc = await loadDocInTransaction(tx, scope.appId);
			assertPlacement(doc, tree, nextLevelUuid, nextParentId);
		}

		// Only slots whose value actually DIFFERS are written. A patch that
		// restates what is stored is not a change, and advancing the clock for one
		// would invalidate every client's snapshot to record that someone pressed
		// Save on an unedited form.
		const values: Record<string, unknown> = { updated_by: scope.actorUserId };
		if (patch.name !== undefined && patch.name !== current.name) {
			values.name = patch.name;
		}
		if (
			patch.externalId !== undefined &&
			patch.externalId !== current.external_id
		) {
			values.external_id = patch.externalId;
		}
		if (
			patch.latitude !== undefined &&
			patch.latitude !==
				(current.latitude === null
					? null
					: canonicalCoordinate(current.latitude))
		) {
			values.latitude = patch.latitude;
		}
		if (
			patch.longitude !== undefined &&
			patch.longitude !==
				(current.longitude === null
					? null
					: canonicalCoordinate(current.longitude))
		) {
			values.longitude = patch.longitude;
		}
		if (
			(patch.values !== undefined || patch.valuePatch !== undefined) &&
			!sameStringRecord(nextValues, current.values)
		) {
			values.values = JSON.stringify(nextValues);
		}
		if (
			patch.levelUuid !== undefined &&
			patch.levelUuid !== current.level_uuid
		) {
			values.level_uuid = patch.levelUuid;
		}
		if (changesPlacement) {
			const orderKey = orderKeyForSlot(
				tree,
				nextParentId,
				patch.afterSiblingId,
				locationId,
			);
			if (nextParentId !== current.parent_id) values.parent_id = nextParentId;
			if (orderKey !== current.order_key) values.order_key = orderKey;
		}
		// One key means nothing but provenance changed, and provenance alone is
		// not a change: advancing the clock would invalidate every client's
		// snapshot to record that someone pressed Save on an unedited form.
		if (Object.keys(values).length === 1) {
			return { revision: locked.revision, location: toStoredLocation(current) };
		}
		values.updated_at = new Date();

		const updated = await tx
			.updateTable("app_locations")
			.set(values)
			.where("app_id", "=", scope.appId)
			.where("id", "=", locationId)
			.returningAll()
			.executeTakeFirstOrThrow();
		if (
			updated.level_uuid !== current.level_uuid ||
			updated.parent_id !== current.parent_id ||
			updated.order_key !== current.order_key
		) {
			const doc = await loadDocInTransaction(tx, scope.appId);
			await assertPersonaAssignmentsValid(tx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
			await assertLocationOwnerTargetsValid(tx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
			await assertReverseHopTargetsUnambiguous(tx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
		}
		const revision = await commitOrganizationChange(tx, scope, 0);
		return { revision, location: toStoredLocation(updated) };
	});
}

export interface MoveLocationResult {
	readonly revision: OrganizationRevision;
	readonly location: StoredLocation;
}

/**
 * Re-parent or re-order a place.
 *
 * A move carries the whole subtree with it, which is why the cycle check is
 * not optional: making a place its own descendant would detach that subtree
 * from every root and leave rows no tree walk reaches.
 */
export async function moveLocation(
	scope: OrganizationScope,
	locationId: string,
	target: {
		readonly parentId: string | null;
		readonly afterSiblingId?: string | null;
	},
	expectedRevision?: OrganizationRevision,
): Promise<MoveLocationResult> {
	return withAppTx(async (tx) => {
		const locked = await lockOrganizationForWrite(tx, scope, {
			capability: "edit",
		});
		assertExpectedOrganizationRevision(locked, expectedRevision);
		const tree = await lockTree(tx, scope.appId);
		const current = tree.byId.get(locationId);
		if (current === undefined) throw organizationNotFound();

		if (target.parentId !== null) {
			if (subtreeIds(tree, locationId).includes(target.parentId)) {
				throw new OrganizationError(
					"rejected",
					`"${current.name}" can't move into itself or into a place under it.`,
				);
			}
		}
		const doc = await loadDocInTransaction(tx, scope.appId);
		assertPlacement(doc, tree, current.level_uuid, target.parentId);
		const orderKey = orderKeyForSlot(
			tree,
			target.parentId,
			target.afterSiblingId,
			locationId,
		);
		if (
			current.parent_id === target.parentId &&
			current.order_key === orderKey
		) {
			return {
				revision: locked.revision,
				location: toStoredLocation(current),
			};
		}
		const updated = await tx
			.updateTable("app_locations")
			.set({
				parent_id: target.parentId,
				order_key: orderKey,
				updated_by: scope.actorUserId,
				updated_at: new Date(),
			})
			.where("app_id", "=", scope.appId)
			.where("id", "=", locationId)
			.returningAll()
			.executeTakeFirstOrThrow();
		// A move changes address-book ancestry even when neither endpoint row is
		// itself referenced. Recheck every persona/fixed-owner edge against the
		// tentative tree; any rejection rolls the row update back with it.
		await assertPersonaAssignmentsValid(tx, {
			appId: scope.appId,
			candidateDoc: doc,
		});
		await assertLocationOwnerTargetsValid(tx, {
			appId: scope.appId,
			candidateDoc: doc,
		});
		await assertReverseHopTargetsUnambiguous(tx, {
			appId: scope.appId,
			candidateDoc: doc,
		});
		return {
			revision: await commitOrganizationChange(tx, scope, 0),
			location: toStoredLocation(updated),
		};
	});
}

/**
 * Which personas would stop working somewhere if `archived` were archived,
 * and the mutations that make that true.
 *
 * This mirrors HQ rather than inventing a policy.
 * `tasks.py::update_users_at_locations` — the live half of
 * `SQLLocation.archive`, since its in-line `_remove_user` acts only on the
 * dead `user_id` field — calls
 * `unset_location_by_id(location_id, fall_back_to_next=True)` for every user
 * at every archived location. So: drop the archived places from the
 * assignment, and if the PRIMARY was one of them, the next remaining place
 * becomes primary. A persona left with nowhere loses the slot entirely.
 *
 * This is deliberately the LOCATION-archived path, not the worker-left path.
 * The two are different in HQ and only this one is parity: retiring a worker
 * (`CommCareUser.retire` -> `delete_user_data`) soft-deletes the cases they
 * own, while deactivating one leaves everything standing. Archiving a place
 * does neither — it moves nobody's cases at all.
 *
 * The clear travels as an explicit `null`, because a cleared optional slot
 * cannot cross the persistence wire or the SSE stream any other way.
 */
export function planPersonaUnassignment(
	doc: BlueprintDoc,
	archivedIds: ReadonlySet<string>,
): {
	readonly mutations: Mutation[];
	readonly personaNames: string[];
	readonly fingerprintRows: readonly {
		readonly personaUuid: string;
		readonly before: readonly string[];
		readonly after: readonly string[];
	}[];
} {
	const mutations: Mutation[] = [];
	const personaNames: string[] = [];
	const fingerprintRows: {
		personaUuid: string;
		before: readonly string[];
		after: readonly string[];
	}[] = [];
	for (const persona of Object.values(personasOf(doc)).sort((left, right) =>
		left.uuid.localeCompare(right.uuid),
	)) {
		const assigned = assignedLocationUuids(persona.locations);
		if (assigned.length === 0) continue;
		const remaining = assigned.filter((uuid) => !archivedIds.has(uuid));
		if (remaining.length === assigned.length) continue;
		personaNames.push(persona.name);
		fingerprintRows.push({
			personaUuid: persona.uuid,
			before: assigned,
			after: remaining,
		});
		if (remaining.length === 0) {
			mutations.push({
				kind: "updatePersona",
				uuid: persona.uuid,
				patch: { locations: null },
			});
			continue;
		}
		const [primary, ...additional] = remaining;
		const primaryUuid = asUuid(primary);
		const additionalUuids = additional.map(asUuid);
		mutations.push({
			kind: "updatePersona",
			uuid: persona.uuid,
			patch: {
				locations: {
					primaryUuid,
					...(additionalUuids.length > 0 && { additionalUuids }),
				},
			},
		});
	}
	return { mutations, personaNames, fingerprintRows };
}

/**
 * Count the cases whose owner is one of `locationIds`.
 *
 * The one place this package reads case rows, and it is raw SQL rather than a
 * Kysely table because `cases` belongs to the case store's schema rather than
 * `AppDatabase`. It is the same physical database on the same search path, so
 * the read is exact and — when it runs on a write transaction — consistent
 * with everything else that transaction sees.
 *
 * Advisory, never a gate. Nothing moves these cases: `owner_id` keeps
 * pointing at the archived place and no cascade exists anywhere in HQ (its
 * "Orphan Case Alerts" setting is a console warning). Reporting the number is
 * the entire faithful behaviour; reassigning them would be Nova inventing a
 * migration the platform does not perform.
 */
async function countCasesOwnedBy(
	tx: Transaction<AppDatabase>,
	appId: string,
	locationIds: readonly string[],
): Promise<number> {
	if (locationIds.length === 0) return 0;
	const result = await sql<{ count: string }>`
		SELECT count(*)::text AS count
		FROM cases
		WHERE app_id = ${appId}
			AND owner_id = ANY(${sql.val(locationIds)}::text[])
			AND closed_on IS NULL
	`.execute(tx);
	return Number(result.rows[0]?.count ?? "0");
}

/** Forms whose complete owner expression fixes a case to this subtree. */
function fixedOwnerRuleForms(
	doc: BlueprintDoc,
	locationIds: ReadonlySet<string>,
): readonly { readonly uuid: string; readonly name: string }[] {
	const forms = new Map<string, string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (
				owner?.kind === "term" &&
				owner.term.kind === "fixed-location" &&
				locationIds.has(owner.term.locationUuid)
			) {
				forms.set(form.uuid, form.name);
			}
		}
	}
	return [...forms]
		.map(([uuid, name]) => ({ uuid, name }))
		.sort((left, right) => left.uuid.localeCompare(right.uuid));
}

const ARCHIVE_IMPACT_PREVIEW_LIMIT = 10;

async function buildArchivePlan(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly revision: OrganizationRevision;
		readonly doc: BlueprintDoc;
		readonly locationIds: readonly string[];
	},
): Promise<{
	readonly impact: ArchiveImpact;
	readonly mutations: readonly Mutation[];
	readonly personaNames: readonly string[];
	readonly blockingFormNames: readonly string[];
}> {
	const locationIds = [...args.locationIds].sort();
	const planned = planPersonaUnassignment(args.doc, new Set(locationIds));
	const blockingForms = fixedOwnerRuleForms(args.doc, new Set(locationIds));
	const ownedCases = await countCasesOwnedBy(tx, args.appId, locationIds);
	const confirmationToken = createHash("sha256")
		.update(
			JSON.stringify({
				revision: args.revision,
				locationIds,
				personas: planned.fingerprintRows,
				ownedCases,
				blockingFormUuids: blockingForms.map((form) => form.uuid),
			}),
		)
		.digest("hex");
	const personaNames = [...planned.personaNames].sort((left, right) =>
		left.localeCompare(right),
	);
	const blockingFormNames = blockingForms
		.map((form) => form.name)
		.sort((left, right) => left.localeCompare(right));
	return {
		impact: {
			revision: args.revision,
			confirmationToken,
			affectedLocationCount: locationIds.length,
			unassignedPersonaCount: personaNames.length,
			unassignedPersonaPreview: personaNames.slice(
				0,
				ARCHIVE_IMPACT_PREVIEW_LIMIT,
			),
			ownedCases,
			blockingOwnerRuleFormCount: blockingFormNames.length,
			blockingOwnerRuleFormPreview: blockingFormNames.slice(
				0,
				ARCHIVE_IMPACT_PREVIEW_LIMIT,
			),
		},
		mutations: planned.mutations,
		personaNames,
		blockingFormNames,
	};
}

/**
 * What archiving `locationId` would do, read before the gesture so the
 * confirmation states consequences rather than gesturing at them.
 */
export async function describeArchiveImpact(
	scope: OrganizationScope,
	locationId: string,
): Promise<ArchiveImpact> {
	return withAppTx(async (tx) => {
		// A read, but an app-locked one: the counts it reports are the basis a
		// human is about to act on, and a share lock is what makes them agree
		// with each other.
		const locked = await lockOrganizationForWrite(tx, scope, {
			capability: "view",
		});
		const tree = await lockTree(tx, scope.appId);
		if (!tree.byId.has(locationId)) throw organizationNotFound();
		const ids = subtreeIds(tree, locationId).filter(
			(id) => tree.byId.get(id)?.archived_at === null,
		);
		const doc = await loadDocInTransaction(tx, scope.appId);
		return (
			await buildArchivePlan(tx, {
				appId: scope.appId,
				revision: locked.revision,
				doc,
				locationIds: ids,
			})
		).impact;
	});
}

export interface SetArchivedResult {
	readonly revision: OrganizationRevision;
	readonly impact?: ArchiveImpact;
	readonly archivedCount: number;
	readonly unassignedPersonaCount: number;
	/** Present when the archive also committed persona mutations. Shared tools
	 * adopt this exact fresh-store result instead of continuing on a stale doc. */
	readonly blueprintChange?: {
		readonly mutations: readonly Mutation[];
		readonly committedDoc: BlueprintDoc;
	};
}

/**
 * Archive or unarchive a place and its subtree — the cross-store write this
 * whole package's lock discipline exists for.
 *
 * ONE transaction changes both stores, because either half alone is a state
 * the model promises is unreachable: archived places with a persona still
 * standing on them, or a persona unassigned from places that are still live.
 * It runs under the app row's EXCLUSIVE lock because it performs a guarded
 * blueprint commit on the same transaction
 * ({@link commitGuardedBatchInTransaction}).
 *
 * Direction asymmetry is HQ's, and it is deliberate on both sides.
 * `SQLLocation.archive` walks descendants only; `::unarchive` walks
 * descendants AND ancestors, because a place is unreachable while any
 * ancestor is archived, so restoring one has to restore the path to it.
 *
 * Unarchiving does NOT restore assignments. The archive removed them and they
 * are ordinary authored data now — silently re-adding a persona to a place
 * someone may have deliberately moved them off would be Nova overwriting an
 * edit with a memory of an older one.
 */
export async function setLocationArchived(
	scope: OrganizationScope,
	locationId: string,
	archived: boolean,
	expectedRevision?: OrganizationRevision,
	confirmedImpact?: ArchiveImpact,
): Promise<SetArchivedResult> {
	const runOnce = (): Promise<SetArchivedResult> =>
		withAppTx(async (tx) => {
			const locked = await lockOrganizationForWrite(tx, scope, {
				capability: "edit",
				exclusiveApp: true,
			});
			assertExpectedOrganizationRevision(locked, expectedRevision);
			const tree = await lockTree(tx, scope.appId);
			const target = tree.byId.get(locationId);
			if (target === undefined) throw organizationNotFound();

			const affected = archived
				? subtreeIds(tree, locationId)
				: [...subtreeIds(tree, locationId), ...ancestorIds(tree, locationId)];
			const changing = affected.filter((id) =>
				archived
					? tree.byId.get(id)?.archived_at === null
					: tree.byId.get(id)?.archived_at !== null,
			);
			if (changing.length === 0) {
				return {
					revision: locked.revision,
					archivedCount: 0,
					unassignedPersonaCount: 0,
				};
			}

			let archiveDoc: BlueprintDoc | undefined;
			let archivePlan: Awaited<ReturnType<typeof buildArchivePlan>> | undefined;
			if (archived) {
				archiveDoc = await loadDocInTransaction(tx, scope.appId);
				archivePlan = await buildArchivePlan(tx, {
					appId: scope.appId,
					revision: locked.revision,
					doc: archiveDoc,
					locationIds: changing,
				});
				if (
					confirmedImpact !== undefined &&
					JSON.stringify(confirmedImpact) !== JSON.stringify(archivePlan.impact)
				) {
					throw new OrganizationError(
						"conflict",
						"What this archive would affect changed after the confirmation was shown. Review the latest impact, then confirm again.",
						{ currentRevision: locked.revision },
					);
				}
				if (archivePlan.blockingFormNames.length > 0) {
					const blocked = archivePlan.blockingFormNames;
					throw new OrganizationError(
						"rejected",
						`This place is used as a fixed case owner in ${blocked.length === 1 ? `the form "${blocked[0]}"` : `these forms: ${blocked.join(", ")}`}. Change ${blocked.length === 1 ? "that rule" : "those rules"} before archiving it.`,
					);
				}
			}

			await tx
				.updateTable("app_locations")
				.set({
					archived_at: archived ? new Date() : null,
					updated_by: scope.actorUserId,
					updated_at: new Date(),
				})
				.where("app_id", "=", scope.appId)
				.where("id", "in", changing)
				.execute();

			if (!archived) {
				const doc = await loadDocInTransaction(tx, scope.appId);
				await assertReverseHopTargetsUnambiguous(tx, {
					appId: scope.appId,
					candidateDoc: doc,
				});
			}

			let unassignedPersonaCount = 0;
			let blueprintChange: SetArchivedResult["blueprintChange"];
			if (archived) {
				const plan =
					archivePlan ??
					(await buildArchivePlan(tx, {
						appId: scope.appId,
						revision: locked.revision,
						doc: archiveDoc ?? (await loadDocInTransaction(tx, scope.appId)),
						locationIds: changing,
					}));
				if (plan.mutations.length > 0) {
					const admittedMutations = admitMutationBatch(plan.mutations);
					const chatRunHolder = scope.chatRunHolder;
					const changeSource = scope.changeSource;
					const committed = await commitGuardedBatchInTransaction(tx, {
						appId: scope.appId,
						batchId: randomUUID(),
						...(changeSource?.kind === "chat" && chatRunHolder !== undefined
							? {
									kind: "chat" as const,
									runId: changeSource.runId,
									chatRunHolder,
								}
							: changeSource?.kind === "mcp"
								? { kind: "mcp" as const, runId: changeSource.runId }
								: { kind: "autosave" as const }),
						mutations: admittedMutations,
						actorUserId: scope.actorUserId,
						expectedProjectId: scope.projectId,
					});
					blueprintChange = {
						mutations: admittedMutations,
						committedDoc: committed.committedDoc,
					};
				}
				unassignedPersonaCount = plan.personaNames.length;
			}
			return {
				revision: await commitOrganizationChange(tx, scope, 0),
				...(archivePlan === undefined ? {} : { impact: archivePlan.impact }),
				archivedCount: changing.length,
				unassignedPersonaCount,
				...(blueprintChange === undefined ? {} : { blueprintChange }),
			};
		});

	try {
		return await runOnce();
	} catch (err) {
		// The guarded commit's `accepted_mutations` unique constraint is the one
		// error worth a retry: a concurrent commit of the same batch id means
		// the whole transaction must be re-run rather than the body resumed,
		// which is the responsibility `commitGuardedBatchInTransaction` documents
		// as its caller's. A fresh batch id is minted on the retry because this
		// batch was never the caller's idempotency key to begin with.
		if ((err as { code?: unknown })?.code !== "23505") throw err;
		return runOnce();
	}
}

/** The chain above a place, nearest first. Cycle-tolerant like the subtree walk. */
function ancestorIds(tree: LockedTree, locationId: string): string[] {
	const chain: string[] = [];
	const seen = new Set<string>([locationId]);
	let current = tree.byId.get(locationId);
	while (current?.parent_id != null) {
		if (seen.has(current.parent_id)) break;
		const parent = tree.byId.get(current.parent_id);
		if (parent === undefined) break;
		seen.add(parent.id);
		chain.push(parent.id);
		current = parent;
	}
	return chain;
}
