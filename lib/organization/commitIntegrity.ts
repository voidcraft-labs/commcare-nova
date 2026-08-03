import { type Selectable, sql, type Transaction } from "kysely";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import type { AppDatabase, AppLocationsTable } from "@/lib/db/pg";
import {
	ancestorLevels,
	assignedLocationUuids,
	type BlueprintDoc,
	levelHoldsWorkers,
	levelOwnsCases,
	locationPropertiesOf,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/predicate";
import { locationValueCatalogIssue } from "./valueCatalog";

/**
 * The organization's half of a blueprint commit's integrity, run inside the
 * commit transaction because neither question can be answered from the
 * document alone and neither answer stays true outside a lock.
 *
 * Two directions of reference cross the two stores:
 *
 *   - **document -> rows.** A persona's assignment names location rows. Those
 *     become exact edges in `app_location_references`, whose composite
 *     `ON DELETE RESTRICT` foreign key is what makes a place a persona stands
 *     on undeletable. The edges are replaced as a COMPLETE set on every
 *     authoritative commit, so they are derived state that any unrelated
 *     commit reconverges — the same contract lookup edges have.
 *   - **rows -> document.** A location row names a level, and its value bag
 *     names location properties. Removing a level while places still stand at
 *     it is refused here rather than enforced by a foreign key, because the
 *     commit rewrites `blueprint_entities` from its own diff and a `RESTRICT`
 *     edge would fire on ordinary unrelated edits; removing a property sheds
 *     the values that named it, because a property uuid is never reissued and
 *     an orphaned value is unreachable forever.
 *
 * All of it runs after the verdict and before the entity write, so a rejection
 * leaves nothing behind and a shed never outlives the removal that caused it.
 */

/**
 * Every location row the document references, deduplicated and sorted.
 *
 * Sorted because the insert order of an edge set is the only thing standing
 * between two concurrent app commits and a deadlock on the same rows.
 *
 * Persona assignments and fixed-location owner terms share this extractor and
 * table because both are the same kind of structural edge. Reverse-hop terms
 * name a level, not a concrete row, so they are protected by blueprint identity
 * admission instead.
 */
export function extractLocationReferenceTargets(
	doc: BlueprintDoc,
): readonly string[] {
	const targets = new Set<string>();
	for (const persona of Object.values(personasOf(doc))) {
		for (const uuid of assignedLocationUuids(persona.locations)) {
			targets.add(uuid);
		}
	}
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			if (operation.owner === undefined) continue;
			walkExpressionTerms(operation.owner, (term) => {
				if (term.kind === "fixed-location") {
					targets.add(term.locationUuid);
				}
			});
		}
	}
	return [...targets].sort();
}

/**
 * Replace the app's complete location edge set, proving every target is a
 * live place in THIS app first.
 *
 * The existence check is explicit rather than left to the foreign key so a
 * reference the author can actually fix produces a sentence they can read.
 * The key still earns its place: it is what stops a concurrent delete from
 * stranding an edge, which no application-level check can promise.
 *
 * Archived places are not legal targets. The archive workflow clears persona
 * assignments in the subtree and refuses fixed owner rules before archiving;
 * this live-row check closes the concurrent-commit race around both workflows.
 */
export async function replaceLocationReferenceEdges(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string; readonly targets: readonly string[] },
): Promise<void> {
	const { appId, targets } = args;

	await tx
		.deleteFrom("app_location_references")
		.where("app_id", "=", appId)
		.execute();
	if (targets.length === 0) return;

	const live = await tx
		.selectFrom("app_locations")
		.select("id")
		.where("app_id", "=", appId)
		.where("id", "in", targets)
		.where("archived_at", "is", null)
		// FOR KEY SHARE, not FOR SHARE: it blocks a concurrent delete of the
		// row without blocking an ordinary edit to it, which is exactly the
		// guarantee an edge needs.
		.forKeyShare()
		.execute();
	const found = new Set(live.map((row) => row.id));
	const missing = targets.filter((target) => !found.has(target));
	if (missing.length > 0) {
		throw new BlueprintCommitRejectedError(
			"The app references a place that no longer exists or is archived in this organization. Reload to get the latest places, then repair the assignment or owner rule.",
		);
	}

	await tx
		.insertInto("app_location_references")
		.values(
			targets.map((locationId) => ({ app_id: appId, location_id: locationId })),
		)
		.execute();
}

/**
 * Shed the values of every location property this commit removed.
 *
 * A value bag is keyed by property UUID, and a removed property's uuid is
 * never reissued — Nova mints a fresh one for every property an author adds —
 * so a value left behind is unreachable forever: no catalog entry names it, no
 * fixture field emits it, and no later property can adopt it. It is dead
 * weight that every read of every row would carry.
 *
 * Shedding it here rather than lazily is the same choice `lib/lookup`'s column
 * removal makes, and for the same reason: the write that removes the
 * declaration is the one moment the set of orphaned keys is exactly known.
 *
 * `jsonb - text[]` removes the keys that are present and ignores the rest, so
 * this is one statement over the app's rows regardless of how many carried a
 * value. The `?|` guard keeps it from rewriting rows that had none, which is
 * almost all of them.
 */
export async function shedRemovedLocationPropertyValues(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly previousDoc: BlueprintDoc;
		readonly candidateDoc: BlueprintDoc;
	},
): Promise<void> {
	const { appId, previousDoc, candidateDoc } = args;
	const surviving = locationPropertiesOf(candidateDoc);
	const removed = Object.keys(locationPropertiesOf(previousDoc)).filter(
		(uuid) => surviving[uuid] === undefined,
	);
	if (removed.length === 0) return;

	await sql`
		UPDATE app_locations
		SET "values" = "values" - ${sql.val(removed)}::text[],
			updated_at = now()
		WHERE app_id = ${appId}
			AND "values" ?| ${sql.val(removed)}::text[]
	`.execute(tx);
}

/**
 * Refuse a commit that removes a level while places still stand at it.
 *
 * This is HQ's own rule, and its scope is worth stating exactly:
 * `views.py::LocationTypesView.remove_old_location_types` blocks deletion
 * when `SQLLocation.objects.filter(location_type=pk).exists()` — using
 * `objects` rather than `active_objects`, so **archived places count**. Nova
 * counts them too. An archived place is recoverable, and unarchiving one
 * whose level had been deleted underneath it would resurrect a row pointing
 * at nothing.
 */
export async function assertRemovedLevelsUnused(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly previousDoc: BlueprintDoc;
		readonly candidateDoc: BlueprintDoc;
	},
): Promise<void> {
	const { appId, previousDoc, candidateDoc } = args;
	const surviving = organizationLevelsOf(candidateDoc);
	const removed = Object.values(organizationLevelsOf(previousDoc)).filter(
		(level) => surviving[level.uuid] === undefined,
	);
	if (removed.length === 0) return;

	const occupied = await tx
		.selectFrom("app_locations")
		.select("level_uuid")
		.distinct()
		.where("app_id", "=", appId)
		.where(
			"level_uuid",
			"in",
			removed.map((level) => level.uuid),
		)
		.execute();
	if (occupied.length === 0) return;

	const blocked = new Set(occupied.map((row) => row.level_uuid));
	const names = removed
		.filter((level) => blocked.has(level.uuid))
		.map((level) => `"${level.name}"`);
	throw new BlueprintCommitRejectedError(
		names.length === 1
			? `${names[0]} still has places in it, so the level can't be removed. Move or archive those places first.`
			: `${names.join(" and ")} still have places in them, so those levels can't be removed. Move or archive those places first.`,
	);
}

/**
 * Apply every cross-store organization invariant for one freshly admitted
 * blueprint candidate. The app row is already locked by the guarded writer,
 * so location reads and edge replacement share its serialization prefix.
 */
export async function applyOrganizationCommitIntegrity(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly previousDoc: BlueprintDoc;
		readonly candidateDoc: BlueprintDoc;
	},
): Promise<void> {
	await assertRemovedLevelsUnused(tx, args);
	await shedRemovedLocationPropertyValues(tx, args);
	await assertLocationValuesValid(tx, args);
	await assertPersonaAssignmentsValid(tx, args);
	await assertLocationOwnerTargetsValid(tx, args);
	await replaceLocationReferenceEdges(tx, {
		appId: args.appId,
		targets: extractLocationReferenceTargets(args.candidateDoc),
	});
}

/**
 * A catalog edit is the reverse direction of a location value write. Validate
 * every existing row against the candidate catalog under the same app lock so
 * making a field required, narrowing its levels, or closing its choices cannot
 * strand values the location service would itself refuse.
 */
export async function assertLocationValuesValid(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string; readonly candidateDoc: BlueprintDoc },
): Promise<void> {
	const rows = await tx
		.selectFrom("app_locations")
		.select(["name", "level_uuid", "values"])
		.where("app_id", "=", args.appId)
		.execute();
	for (const row of rows) {
		const issue = locationValueCatalogIssue(
			args.candidateDoc,
			row.level_uuid,
			row.values,
		);
		if (issue !== undefined) {
			throw new BlueprintCommitRejectedError(
				`"${row.name}" blocks this change. ${issue}`,
			);
		}
	}
}

/**
 * A persona can stand only at a live place whose level accepts workers.
 * This must run under the commit transaction: the document knows the UUIDs,
 * while only the locked row store knows what they name right now.
 */
export async function assertPersonaAssignmentsValid(
	tx: Transaction<AppDatabase>,
	args: { readonly appId: string; readonly candidateDoc: BlueprintDoc },
): Promise<void> {
	const assignments = Object.values(personasOf(args.candidateDoc)).flatMap(
		(persona) =>
			assignedLocationUuids(persona.locations).map((locationId) => ({
				persona,
				locationId,
			})),
	);
	if (assignments.length === 0) return;

	const ids = [
		...new Set(assignments.map(({ locationId }) => locationId)),
	].sort();
	const rows = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("id", "in", ids)
		.forKeyShare()
		.execute();
	const byId = new Map(rows.map((row) => [row.id, row]));
	const levels = organizationLevelsOf(args.candidateDoc);

	for (const { persona, locationId } of assignments) {
		const row = byId.get(locationId);
		if (row === undefined || row.archived_at !== null) {
			throw new BlueprintCommitRejectedError(
				`${persona.name} is assigned to a place that no longer exists or is archived. Reload the organization, then choose a live place.`,
			);
		}
		const level = levels[row.level_uuid];
		if (level === undefined || !levelHoldsWorkers(level)) {
			throw new BlueprintCommitRejectedError(
				`${persona.name} can't work at "${row.name}" because its level does not hold workers. Change that level or choose another place.`,
			);
		}
	}
}

type LocationRow = Selectable<AppLocationsTable>;

function fixedOwnerTargets(doc: BlueprintDoc): readonly string[] {
	const targets = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (owner?.kind === "term" && owner.term.kind === "fixed-location") {
				targets.add(owner.term.locationUuid);
			}
		}
	}
	return [...targets].sort();
}

function rowAncestors(
	row: LocationRow,
	byId: ReadonlyMap<string, LocationRow>,
): LocationRow[] {
	const out: LocationRow[] = [];
	const seen = new Set<string>([row.id]);
	let parentId = row.parent_id;
	while (parentId !== null && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (parent === undefined) break;
		out.push(parent);
		parentId = parent.parent_id;
	}
	return out;
}

function isSameOrDescendant(
	candidate: LocationRow,
	root: LocationRow,
	byId: ReadonlyMap<string, LocationRow>,
): boolean {
	return (
		candidate.id === root.id ||
		rowAncestors(candidate, byId).some((ancestor) => ancestor.id === root.id)
	);
}

function levelIsAtOrAbove(
	candidateLevelUuid: string,
	bottomLevelUuid: string,
	doc: BlueprintDoc,
): boolean {
	if (candidateLevelUuid === bottomLevelUuid) return true;
	const levels = organizationLevelsOf(doc);
	const bottom = levels[bottomLevelUuid];
	return (
		bottom !== undefined &&
		ancestorLevels(bottom, levels).some(
			(ancestor) => ancestor.uuid === candidateLevelUuid,
		)
	);
}

function topSliceIncludes(
	target: LocationRow,
	downToLevelUuid: string | undefined,
	doc: BlueprintDoc,
): boolean {
	return (
		downToLevelUuid === undefined ||
		levelIsAtOrAbove(target.level_uuid, downToLevelUuid, doc)
	);
}

function assignmentFootprintIncludes(
	target: LocationRow,
	assigned: LocationRow,
	byId: ReadonlyMap<string, LocationRow>,
	doc: BlueprintDoc,
): boolean {
	const levels = organizationLevelsOf(doc);
	const assignedLevel = levels[assigned.level_uuid];
	if (assignedLevel === undefined) return false;
	const book = assignedLevel.addressBook;
	const targetIsAncestor = rowAncestors(assigned, byId).some(
		(ancestor) => ancestor.id === target.id,
	);
	const targetInOwnBranch = isSameOrDescendant(target, assigned, byId);

	switch (book.reach) {
		case "own-branch":
			return (
				targetIsAncestor ||
				(targetInOwnBranch &&
					(book.downToLevelUuid === undefined ||
						levelIsAtOrAbove(target.level_uuid, book.downToLevelUuid, doc))) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(target, book.alsoIncludeTopDownToLevelUuid, doc))
			);
		case "own-branch-limited":
			return (
				((targetIsAncestor || targetInOwnBranch) &&
					book.levelUuids.includes(target.level_uuid)) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(target, book.alsoIncludeTopDownToLevelUuid, doc))
			);
		case "shared-branch": {
			const from = [assigned, ...rowAncestors(assigned, byId)].find(
				(row) => row.level_uuid === book.fromLevelUuid,
			);
			return (
				from !== undefined &&
				isSameOrDescendant(target, from, byId) &&
				(book.downToLevelUuid === undefined ||
					levelIsAtOrAbove(target.level_uuid, book.downToLevelUuid, doc))
			);
		}
		case "whole-organization":
			return topSliceIncludes(target, book.downToLevelUuid, doc);
	}
}

/**
 * Prove fixed owner destinations against the freshly locked rows. A valid
 * destination owns cases and is present in every assigned persona's address
 * book; unassigned personas impose no footprint because they have no location
 * session at all yet.
 */
export async function assertLocationOwnerTargetsValid(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		readonly candidateDoc: BlueprintDoc;
	},
): Promise<void> {
	const targets = fixedOwnerTargets(args.candidateDoc);
	if (targets.length === 0) return;
	const rows = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "=", args.appId)
		.forKeyShare()
		.execute();
	const byId = new Map(rows.map((row) => [row.id, row]));
	const levels = organizationLevelsOf(args.candidateDoc);
	for (const targetId of targets) {
		const target = byId.get(targetId);
		const level = target === undefined ? undefined : levels[target.level_uuid];
		if (
			target === undefined ||
			target.archived_at !== null ||
			level === undefined
		) {
			throw new BlueprintCommitRejectedError(
				"A case owner points at a place that no longer exists or is archived. Reload the organization, then choose a live place.",
			);
		}
		if (!levelOwnsCases(level)) {
			throw new BlueprintCommitRejectedError(
				`"${target.name}" is at the ${level.name} level, which does not own cases. Choose a place at a case-owning level.`,
			);
		}
		for (const persona of Object.values(personasOf(args.candidateDoc))) {
			const assigned = assignedLocationUuids(persona.locations)
				.map((uuid) => byId.get(uuid))
				.filter(
					(row): row is LocationRow =>
						row !== undefined && row.archived_at === null,
				);
			if (assigned.length === 0) continue;
			if (
				assigned.some((row) =>
					assignmentFootprintIncludes(target, row, byId, args.candidateDoc),
				)
			) {
				continue;
			}
			throw new BlueprintCommitRejectedError(
				`"${target.name}" is outside ${persona.name}'s address book. Change that level's visibility or choose a destination this worker can carry on the device.`,
			);
		}
	}
}
