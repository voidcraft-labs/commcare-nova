import "server-only";

import { randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import {
	commitGuardedBatchInTransaction,
	loadAppInTransaction,
} from "@/lib/db/apps";
import {
	type AppDatabase,
	type AppLocationsTable,
	getAppDb,
	withAppTx,
} from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { keyBetween } from "@/lib/doc/order/keys";
import type { Mutation } from "@/lib/doc/types";
import {
	assignedLocationUuids,
	asUuid,
	type BlueprintDoc,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";
import { OrganizationError, organizationNotFound } from "./errors";
import {
	assertSiteCodeFree,
	type CreateLocationInput,
	deriveSiteCode,
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
import {
	assertExpectedOrganizationRevision,
	commitOrganizationChange,
	lockOrganizationForWrite,
} from "./writerTransaction";

type LocationRow = Selectable<AppLocationsTable>;

function toStoredLocation(row: LocationRow): StoredLocation {
	return {
		id: row.id,
		levelUuid: row.level_uuid,
		parentId: row.parent_id,
		siteCode: row.site_code,
		name: row.name,
		externalId: row.external_id,
		latitude: row.latitude,
		longitude: row.longitude,
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
export async function readOrganization(
	scope: OrganizationScope,
): Promise<OrganizationSnapshot> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
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
				// An app that has never had an organization has no state row, and
				// revision 0 is the honest answer rather than an error: "nothing
				// yet" is a legitimate organization, and the first write creates
				// the row.
				revision:
					state === undefined ? "0" : parseOrganizationRevision(state.revision),
				locations: locations.map(toStoredLocation),
			};
		});
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

/** The order key that places a row after `afterSiblingId` among its siblings. */
function orderKeyForSlot(
	tree: LockedTree,
	parentId: string | null,
	afterSiblingId: string | undefined,
): string {
	const siblings = tree.childrenOf.get(parentId) ?? [];
	if (afterSiblingId === undefined) {
		const last = siblings.at(-1);
		return keyBetween(last?.order_key ?? null, null);
	}
	const index = siblings.findIndex((row) => row.id === afterSiblingId);
	if (index === -1) {
		throw new OrganizationError(
			"rejected",
			"The place you asked to put this one after isn't in the same part of the organization. Reload to get the latest places, then try again.",
		);
	}
	const before = siblings[index];
	const after = siblings[index + 1];
	// `keysForSlot` is the collision-safe layer for entities that can share an
	// order key; location rows cannot, because every insert mints its key
	// against the locked sibling set, so the plain interval is exact.
	return keyBetween(before.order_key, after?.order_key ?? null);
}

/**
 * The level a new or retyped place stands at must exist in the app's
 * blueprint, and its parent must stand at that level's parent level.
 *
 * The hierarchy rule is Nova's, and it is stricter than HQ's storage: HQ lets
 * a location's parent be any location and only its authoring form restricts
 * the choice (`forms.py::LocationForm.get_allowed_types`). Nova enforces it in
 * the store, because a place whose parent is not at its level's parent level
 * has no coherent lineage attribute in the fixture — the `{code}_id` chain
 * would skip a level and every expression joining on it would silently miss.
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
		throw new OrganizationError(
			"rejected",
			"That level isn't part of this app's organization any more. Reload to get the latest levels, then try again.",
		);
	}
	if (parentId === null) {
		if (level.parentLevelUuid !== undefined) {
			const parentLevel = levels[level.parentLevelUuid];
			throw new OrganizationError(
				"rejected",
				`A ${level.name.toLowerCase()} sits under ${parentLevel === undefined ? "another level" : `a ${parentLevel.name.toLowerCase()}`}, so it needs a parent place. Choose where this one belongs.`,
			);
		}
		return;
	}
	const parent = tree.byId.get(parentId);
	if (parent === undefined) throw organizationNotFound();
	if (level.parentLevelUuid === undefined) {
		throw new OrganizationError(
			"rejected",
			`${level.name} is a top level, so a ${level.name.toLowerCase()} can't sit under another place.`,
		);
	}
	if (parent.level_uuid !== level.parentLevelUuid) {
		const expected = levels[level.parentLevelUuid];
		throw new OrganizationError(
			"rejected",
			`A ${level.name.toLowerCase()} has to sit directly under ${expected === undefined ? "its parent level" : `a ${expected.name.toLowerCase()}`}. Pick a different place for it.`,
		);
	}
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
				level_uuid: input.levelUuid,
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
		const revision = await commitOrganizationChange(tx, scope, 1);
		return { revision, location: toStoredLocation(inserted) };
	});
}

export interface UpdateLocationResult {
	readonly revision: OrganizationRevision;
	readonly location: StoredLocation;
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
			assertPlacement(doc, tree, patch.levelUuid, current.parent_id);
		}

		const values: Record<string, unknown> = { updated_by: scope.actorUserId };
		if (patch.name !== undefined) values.name = patch.name;
		if (patch.externalId !== undefined) values.external_id = patch.externalId;
		if (patch.latitude !== undefined) values.latitude = patch.latitude;
		if (patch.longitude !== undefined) values.longitude = patch.longitude;
		if (patch.values !== undefined)
			values.values = JSON.stringify(patch.values);
		if (patch.levelUuid !== undefined) values.level_uuid = patch.levelUuid;
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
		const revision = await commitOrganizationChange(tx, scope, 0);
		return { revision, location: toStoredLocation(updated) };
	});
}

export interface MoveLocationResult {
	readonly revision: OrganizationRevision;
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
		readonly afterSiblingId?: string;
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
		);
		if (
			current.parent_id === target.parentId &&
			current.order_key === orderKey
		) {
			return { revision: locked.revision };
		}
		await tx
			.updateTable("app_locations")
			.set({
				parent_id: target.parentId,
				order_key: orderKey,
				updated_by: scope.actorUserId,
				updated_at: new Date(),
			})
			.where("app_id", "=", scope.appId)
			.where("id", "=", locationId)
			.execute();
		return { revision: await commitOrganizationChange(tx, scope, 0) };
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
): { readonly mutations: Mutation[]; readonly personaNames: string[] } {
	const mutations: Mutation[] = [];
	const personaNames: string[] = [];
	for (const persona of Object.values(personasOf(doc))) {
		const assigned = assignedLocationUuids(persona.locations);
		if (assigned.length === 0) continue;
		const remaining = assigned.filter((uuid) => !archivedIds.has(uuid));
		if (remaining.length === assigned.length) continue;
		personaNames.push(persona.name);
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
	return { mutations, personaNames };
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
		await lockOrganizationForWrite(tx, scope, { capability: "view" });
		const tree = await lockTree(tx, scope.appId);
		if (!tree.byId.has(locationId)) throw organizationNotFound();
		const ids = subtreeIds(tree, locationId).filter(
			(id) => tree.byId.get(id)?.archived_at === null,
		);
		const doc = await loadDocInTransaction(tx, scope.appId);
		const { personaNames } = planPersonaUnassignment(doc, new Set(ids));
		return {
			locationIds: ids,
			unassignedPersonas: personaNames,
			ownedCases: await countCasesOwnedBy(tx, scope.appId, ids),
		};
	});
}

export interface SetArchivedResult {
	readonly revision: OrganizationRevision;
	readonly archivedIds: readonly string[];
	readonly unassignedPersonas: readonly string[];
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
					archivedIds: [],
					unassignedPersonas: [],
				};
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

			let unassignedPersonas: readonly string[] = [];
			if (archived) {
				const doc = await loadDocInTransaction(tx, scope.appId);
				const plan = planPersonaUnassignment(doc, new Set(changing));
				if (plan.mutations.length > 0) {
					await commitGuardedBatchInTransaction(tx, {
						appId: scope.appId,
						batchId: randomUUID(),
						mutations: plan.mutations,
						actorUserId: scope.actorUserId,
						kind: "autosave",
						expectedProjectId: scope.projectId,
					});
				}
				unassignedPersonas = plan.personaNames;
			}
			return {
				revision: await commitOrganizationChange(tx, scope, 0),
				archivedIds: changing,
				unassignedPersonas,
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
