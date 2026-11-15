import { type Selectable, sql, type Transaction } from "kysely";
import { loadAppInTransaction } from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import type { AppDatabase, AppLocationsTable } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	asUuid,
	type BlueprintDoc,
	levelMayNestUnder,
	organizationLevelsOf,
} from "@/lib/domain";
import { balancedKeysBetween } from "@/lib/lookup/orderKeys";
import type { Finding } from "@/lib/publish/hqFindings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	assertLocationOwnerTargetsValid,
	assertPersonaAssignmentsValid,
	assertReverseHopTargetsUnambiguous,
} from "./commitIntegrity";
import { OrganizationError, organizationNotFound } from "./errors";
import { boundedLocationOrderKeyAtIndex } from "./orderKeys";
import { canonicalCoordinate, MAX_LOCATIONS_PER_APP } from "./schema";
import type { OrganizationRevision, OrganizationScope } from "./types";
import { locationValueCatalogIssue } from "./valueCatalog";
import {
	advanceOrganizationRevision,
	commitOrganizationChange,
	lockOrganizationForWrite,
} from "./writerTransaction";

/**
 * Nova's copy of the places a CommCare HQ project space manages for an app.
 *
 * The copy is ordinary `app_locations` rows, so Preview, the owner sets and
 * the footprint read it as they read any place. What makes it a copy is the
 * origin on `app_organization_state` (`hq_server` and its siblings, all set or
 * all null): while it is set, `lockOrganizationForWrite` refuses every
 * `author` write, and the two functions here are the only writers. Neither
 * writes the document.
 */

/** One place of CommCare HQ's, as the copy holds it. */
export interface ManagedPlaceWrite {
	readonly hqLocationId: string;
	readonly siteCode: string;
	readonly name: string;
	readonly levelUuid: string;
	readonly parentSiteCode: string | null;
	readonly latitude: string | null;
	readonly longitude: string | null;
	/** By location property uuid. */
	readonly values: Readonly<Record<string, string>>;
}

export interface ManagedPlacePlan {
	/** Parent before child. */
	readonly places: readonly ManagedPlaceWrite[];
	readonly digest: string;
	/** Active places left out because their level is not in the app, by level code. */
	readonly leftOut: Readonly<Record<string, number>>;
	readonly findings: readonly Finding[];
}

/** What a refresh changed in the copy. */
export interface ManagedPlacesRefresh {
	/** Places the copy did not hold live before: new ones, and archived ones CommCare HQ lists again. */
	readonly added: number;
	readonly changed: number;
	readonly archived: number;
	/** Places gone from CommCare HQ that a persona or an owner rule still names: kept. */
	readonly keptInUse: readonly string[]; // names
	readonly leftOut: Readonly<Record<string, number>>;
}

type LocationRow = Selectable<AppLocationsTable>;

/** Rows per insert or update statement: eight to thirteen parameters each,
 * far under the protocol's 65,535. */
const WRITE_CHUNK = 500;

/**
 * A plan is the planner's answer, and a plan with a finding is one no writer
 * takes: the caller shows the finding instead. The rest is the shape every
 * writer below relies on, checked rather than trusted because a broken plan
 * would otherwise surface as a foreign-key error halfway through a write.
 */
function assertPlanWritable(plan: ManagedPlacePlan): void {
	if (plan.findings.length > 0) {
		throw new Error(
			"A plan of CommCare HQ's places that carries findings was handed to a writer. Show the findings instead of writing the plan.",
		);
	}
	const seen = new Set<string>();
	for (const place of plan.places) {
		if (seen.has(place.siteCode)) {
			throw new Error(
				`The plan of CommCare HQ's places names the site code "${place.siteCode}" twice.`,
			);
		}
		if (place.parentSiteCode !== null && !seen.has(place.parentSiteCode)) {
			throw new Error(
				`The plan of CommCare HQ's places lists "${place.siteCode}" before its parent "${place.parentSiteCode}".`,
			);
		}
		seen.add(place.siteCode);
	}
}

/** UUIDv7 ids from Postgres, in order, in one statement. */
async function mintLocationIds(
	tx: Transaction<AppDatabase>,
	count: number,
): Promise<string[]> {
	if (count === 0) return [];
	const result = await sql<{ ordinal: number; id: string }>`
		SELECT (ordinality - 1)::integer AS ordinal, uuidv7()::text AS id
		FROM generate_series(1, ${count}) WITH ORDINALITY AS generated(value, ordinality)
		ORDER BY ordinality
	`.execute(tx);
	if (result.rows.length !== count) {
		throw new Error("Postgres returned the wrong number of place UUIDs.");
	}
	return result.rows.map((row, index) => {
		if (row.ordinal !== index) {
			throw new Error("Postgres returned place UUIDs out of order.");
		}
		return row.id;
	});
}

/** Code unit order: the same answer on every machine, unlike a locale's. */
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameValues(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
): boolean {
	const leftKeys = Object.keys(left);
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

function sameCoordinate(
	stored: string | null,
	planned: string | null,
): boolean {
	if (stored === null || planned === null) return stored === planned;
	return canonicalCoordinate(stored) === canonicalCoordinate(planned);
}

interface PlannedInsert {
	readonly id: string;
	readonly parentId: string | null;
	readonly place: ManagedPlaceWrite;
	readonly orderKey: string;
}

async function insertPlaces(
	tx: Transaction<AppDatabase>,
	appId: string,
	actorUserId: string,
	at: Date,
	inserts: readonly PlannedInsert[],
): Promise<void> {
	// Parent before child within and across statements: Postgres checks the
	// parent key at the end of each statement, and an earlier chunk holds
	// every parent a later one names.
	for (let start = 0; start < inserts.length; start += WRITE_CHUNK) {
		await tx
			.insertInto("app_locations")
			.values(
				inserts.slice(start, start + WRITE_CHUNK).map((insert) => ({
					id: insert.id,
					app_id: appId,
					level_uuid: asUuid(insert.place.levelUuid),
					parent_id: insert.parentId,
					site_code: insert.place.siteCode,
					name: insert.place.name,
					external_id: null,
					latitude: insert.place.latitude,
					longitude: insert.place.longitude,
					// A jsonb column crosses Kysely as a string on the way in.
					values: JSON.stringify(insert.place.values),
					order_key: insert.orderKey,
					hq_location_id: insert.place.hqLocationId,
					created_at: at,
					updated_at: at,
					created_by: actorUserId,
					updated_by: actorUserId,
				})),
			)
			.execute();
	}
}

/**
 * Write the copy of CommCare HQ's places for an app being brought in, inside
 * the transaction that inserted the app row.
 *
 * It takes no organization lock of its own: the app row is this transaction's
 * own insert, which no other session can see. The genesis tail's organization
 * integrity step runs after it on the same transaction and proves the rows
 * against the levels and location properties the same birth saves.
 */
export async function writeManagedPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	input: {
		readonly appId: string;
		readonly actorUserId: string;
		readonly origin: { readonly server: string; readonly domain: string };
		readonly plan: ManagedPlacePlan;
		readonly at: Date;
	},
): Promise<OrganizationRevision> {
	const { appId, actorUserId, origin, plan, at } = input;
	assertPlanWritable(plan);
	if (plan.places.length > MAX_LOCATIONS_PER_APP) {
		throw new Error(
			`A plan of ${plan.places.length} places reached the writer, past the ${MAX_LOCATIONS_PER_APP} an app holds.`,
		);
	}

	const ids = await mintLocationIds(tx, plan.places.length);
	const idBySiteCode = new Map<string, string>();
	const depthBySiteCode = new Map<string, number>();
	plan.places.forEach((place, index) => {
		idBySiteCode.set(place.siteCode, ids[index]);
		depthBySiteCode.set(
			place.siteCode,
			place.parentSiteCode === null
				? 0
				: (depthBySiteCode.get(place.parentSiteCode) ?? 0) + 1,
		);
	});

	// One balanced run over the whole list sorted by depth, parent and name,
	// so siblings read in name order and no key grows with the list's length.
	const sorted = [...plan.places].sort(
		(left, right) =>
			(depthBySiteCode.get(left.siteCode) ?? 0) -
				(depthBySiteCode.get(right.siteCode) ?? 0) ||
			compareText(left.parentSiteCode ?? "", right.parentSiteCode ?? "") ||
			compareText(left.name, right.name) ||
			compareText(left.siteCode, right.siteCode),
	);
	const keys = balancedKeysBetween(null, null, sorted.length);
	const orderKeyBySiteCode = new Map(
		sorted.map((place, index) => [place.siteCode, keys[index]]),
	);

	await tx
		.insertInto("app_organization_state")
		.values({
			app_id: appId,
			location_count: plan.places.length,
			hq_server: origin.server,
			hq_domain: origin.domain,
			hq_places_digest: plan.digest,
			hq_left_out: JSON.stringify(plan.leftOut),
			hq_brought_in_at: at,
			hq_brought_in_by: actorUserId,
			hq_refreshed_at: at,
			hq_refreshed_by: actorUserId,
			updated_at: at,
		})
		.execute();
	await insertPlaces(
		tx,
		appId,
		actorUserId,
		at,
		plan.places.map((place) => ({
			id: idBySiteCode.get(place.siteCode) ?? "",
			parentId:
				place.parentSiteCode === null
					? null
					: (idBySiteCode.get(place.parentSiteCode) ?? null),
			place,
			orderKey: orderKeyBySiteCode.get(place.siteCode) ?? "",
		})),
	);
	return advanceOrganizationRevision(tx, appId, 0);
}

/**
 * The stored digest for a refresh that left the copy differing from CommCare
 * HQ's list because it kept places in use. It never equals a plan's digest,
 * so the next refresh compares the rows again and archives a kept place once
 * nothing names it, even where CommCare HQ has not changed since.
 */
function divergedDigest(
	planDigest: string,
	keptIds: readonly string[],
): string {
	return canonicalJsonDigest({
		places: planDigest,
		keptInUse: [...keptIds].sort(),
	});
}

/**
 * Prove the refreshed rows against the document as it stands, and refuse
 * with a sentence for the person where they do not fit. The planner checks
 * the levels it was handed, but the document can change between the plan and
 * this lock, and a place's new level or values can break a persona's
 * assignment or an owner rule that no planner sees.
 */
async function assertRefreshedRowsFit(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: BlueprintDoc,
): Promise<void> {
	const rows = await tx
		.selectFrom("app_locations")
		.select(["id", "name", "level_uuid", "parent_id", "values"])
		.where("app_id", "=", appId)
		.execute();
	const levels = organizationLevelsOf(doc);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const kept = "Nova kept its copy as it was.";
	for (const row of rows) {
		const level = levels[row.level_uuid];
		const parent = row.parent_id === null ? undefined : byId.get(row.parent_id);
		const fits =
			level !== undefined &&
			(row.parent_id === null
				? level.parentLevelUuid === undefined
				: parent !== undefined &&
					levelMayNestUnder(row.level_uuid, parent.level_uuid, levels));
		if (!fits) {
			throw new OrganizationError(
				"rejected",
				`"${row.name}" in CommCare HQ stands at a level, or under a parent, that this app's levels don't allow. You can match the levels in Nova or move the place in CommCare HQ, then refresh. ${kept}`,
			);
		}
		const issue = locationValueCatalogIssue(doc, row.level_uuid, row.values);
		if (issue !== undefined) {
			throw new OrganizationError(
				"rejected",
				`"${row.name}" in CommCare HQ doesn't fit this app's place information. ${issue} You can change the value in CommCare HQ or the place information in Nova, then refresh. ${kept}`,
			);
		}
	}
	try {
		await assertPersonaAssignmentsValid(tx, { appId, candidateDoc: doc });
		await assertLocationOwnerTargetsValid(tx, { appId, candidateDoc: doc });
		await assertReverseHopTargetsUnambiguous(tx, { appId, candidateDoc: doc });
	} catch (error) {
		if (error instanceof BlueprintCommitRejectedError) {
			throw new OrganizationError("rejected", `${error.message} ${kept}`, {
				cause: error,
			});
		}
		throw error;
	}
}

/**
 * Bring CommCare HQ's places into the copy: the one writer of a managed copy
 * after its birth.
 *
 * Matched by site code. A place CommCare HQ lists and the copy lacks is
 * inserted; one whose name, level, parent, coordinates, values or CommCare HQ
 * id differ is updated; one the copy holds live and CommCare HQ no longer
 * lists is archived, unless a persona or an owner rule names it
 * (`app_location_references`), in which case it stays live and is reported,
 * with every ancestor CommCare HQ no longer lists kept live under it, so no
 * live place stands under an archived one; an archived one CommCare HQ lists
 * again is restored. The refresh never writes the document, so it never
 * unassigns a persona: the person moves the persona and refreshes again.
 *
 * Where the stored digest equals the plan's and the left-out counts are the
 * same, only the two refresh columns move and the revision does not.
 */
export async function refreshManagedPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
	input: { readonly plan: ManagedPlacePlan; readonly at: Date },
): Promise<ManagedPlacesRefresh> {
	const { plan, at } = input;
	assertPlanWritable(plan);
	const locked = await lockOrganizationForWrite(tx, scope, {
		capability: "edit",
		purpose: "hq-refresh",
	});
	const hq = locked.hq;
	if (hq === null) {
		throw new Error(
			"The organization lock for a refresh returned an app with no CommCare HQ origin.",
		);
	}
	const leftOutChanged =
		canonicalJsonDigest(hq.leftOut) !== canonicalJsonDigest(plan.leftOut);

	if (hq.placesDigest === plan.digest && !leftOutChanged) {
		await tx
			.updateTable("app_organization_state")
			.set({ hq_refreshed_at: at, hq_refreshed_by: scope.actorUserId })
			.where("app_id", "=", scope.appId)
			.execute();
		return {
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: [],
			leftOut: plan.leftOut,
		};
	}

	const rows: LocationRow[] = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "=", scope.appId)
		.orderBy("order_key")
		.orderBy("id")
		.forUpdate()
		.execute();
	const referenced = new Set(
		(
			await tx
				.selectFrom("app_location_references")
				.select("location_id")
				.where("app_id", "=", scope.appId)
				.execute()
		).map((row) => row.location_id),
	);
	const bySiteCode = new Map(rows.map((row) => [row.site_code, row]));
	const plannedSiteCodes = new Set(plan.places.map((place) => place.siteCode));

	const newPlaces = plan.places.filter(
		(place) => !bySiteCode.has(place.siteCode),
	);
	if (locked.locationCount + newPlaces.length > MAX_LOCATIONS_PER_APP) {
		throw new OrganizationError(
			"limit",
			`Refreshing would take this app past ${MAX_LOCATIONS_PER_APP.toLocaleString("en-US")} places, counting the archived places Nova's copy keeps, which is as many as Nova stores for one app. Nova kept its copy as it was.`,
		);
	}
	const minted = await mintLocationIds(tx, newPlaces.length);
	const idBySiteCode = new Map(rows.map((row) => [row.site_code, row.id]));
	newPlaces.forEach((place, index) => {
		idBySiteCode.set(place.siteCode, minted[index]);
	});
	const parentIdOf = (place: ManagedPlaceWrite): string | null =>
		place.parentSiteCode === null
			? null
			: (idBySiteCode.get(place.parentSiteCode) ?? null);

	// Each row's parent once the refresh is done, which decides the sibling
	// set a new place's order key is minted in.
	const finalParent = new Map(rows.map((row) => [row.id, row.parent_id]));
	const finalOrderKey = new Map(rows.map((row) => [row.id, row.order_key]));
	const finalName = new Map(rows.map((row) => [row.id, row.name]));

	interface PlannedUpdate {
		readonly id: string;
		readonly place: ManagedPlaceWrite;
		readonly parentId: string | null;
	}
	const updates: PlannedUpdate[] = [];
	let added = newPlaces.length;
	let changed = 0;
	for (const place of plan.places) {
		const row = bySiteCode.get(place.siteCode);
		if (row === undefined) continue;
		const parentId = parentIdOf(place);
		const restored = row.archived_at !== null;
		const differs =
			row.name !== place.name ||
			row.level_uuid !== place.levelUuid ||
			row.parent_id !== parentId ||
			!sameCoordinate(row.latitude, place.latitude) ||
			!sameCoordinate(row.longitude, place.longitude) ||
			!sameValues(row.values, place.values) ||
			row.hq_location_id !== place.hqLocationId;
		if (!restored && !differs) continue;
		if (restored) added += 1;
		else changed += 1;
		updates.push({ id: row.id, place, parentId });
		finalParent.set(row.id, parentId);
		finalName.set(row.id, place.name);
	}

	// Gone from CommCare HQ: archive, except what a persona or an owner rule
	// names, and every gone ancestor of that, which stays live with it.
	const byId = new Map(rows.map((row) => [row.id, row]));
	const gone = rows.filter(
		(row) => row.archived_at === null && !plannedSiteCodes.has(row.site_code),
	);
	const keptIds = new Set<string>();
	const keptInUse: string[] = [];
	for (const row of gone) {
		if (!referenced.has(row.id)) continue;
		keptInUse.push(row.name);
		let current: LocationRow | undefined = row;
		while (
			current !== undefined &&
			!plannedSiteCodes.has(current.site_code) &&
			!keptIds.has(current.id)
		) {
			keptIds.add(current.id);
			current =
				current.parent_id === null ? undefined : byId.get(current.parent_id);
		}
	}
	const archiveIds = gone
		.filter((row) => !keptIds.has(row.id))
		.map((row) => row.id);

	// A new place takes its slot among its final siblings by name. A slot
	// whose key would grow past the bound rebalances that sibling set, and
	// an existing sibling's new key rides the update below.
	const rekeyed = new Set<string>();
	const newOrderKey = new Map<string, string>();
	const newByParent = new Map<string | null, ManagedPlaceWrite[]>();
	for (const place of newPlaces) {
		const parentId = parentIdOf(place);
		const siblings = newByParent.get(parentId);
		if (siblings === undefined) newByParent.set(parentId, [place]);
		else siblings.push(place);
	}
	for (const [parentId, places] of newByParent) {
		const siblings = [...finalParent]
			.filter(([, parent]) => parent === parentId)
			.map(([id]) => id)
			.sort(
				(left, right) =>
					compareText(
						finalOrderKey.get(left) ?? "",
						finalOrderKey.get(right) ?? "",
					) || compareText(left, right),
			);
		for (const place of [...places].sort(
			(left, right) =>
				compareText(left.name, right.name) ||
				compareText(left.siteCode, right.siteCode),
		)) {
			const id = idBySiteCode.get(place.siteCode) ?? "";
			const index = siblings.findIndex(
				(sibling) => compareText(finalName.get(sibling) ?? "", place.name) > 0,
			);
			const slot = index === -1 ? siblings.length : index;
			const slotKey = boundedLocationOrderKeyAtIndex(
				siblings.map((sibling) => finalOrderKey.get(sibling) ?? ""),
				slot,
			);
			if (slotKey.rebalancedExistingKeys !== undefined) {
				siblings.forEach((sibling, position) => {
					const key = slotKey.rebalancedExistingKeys?.[position];
					if (key === undefined) return;
					finalOrderKey.set(sibling, key);
					if (byId.has(sibling)) rekeyed.add(sibling);
					else newOrderKey.set(sibling, key);
				});
			}
			siblings.splice(slot, 0, id);
			finalOrderKey.set(id, slotKey.key);
			finalName.set(id, place.name);
			newOrderKey.set(id, slotKey.key);
		}
	}

	await insertPlaces(
		tx,
		scope.appId,
		scope.actorUserId,
		at,
		newPlaces.map((place) => {
			const id = idBySiteCode.get(place.siteCode) ?? "";
			return {
				id,
				parentId: parentIdOf(place),
				place,
				orderKey: newOrderKey.get(id) ?? "",
			};
		}),
	);

	const updated = new Set(updates.map((update) => update.id));
	for (let start = 0; start < updates.length; start += WRITE_CHUNK) {
		const chunk = updates.slice(start, start + WRITE_CHUNK);
		await sql`
			UPDATE app_locations AS l
			SET name = v.name,
				level_uuid = v.level_uuid,
				parent_id = v.parent_id,
				latitude = v.latitude,
				longitude = v.longitude,
				"values" = v.values,
				hq_location_id = v.hq_location_id,
				order_key = v.order_key,
				archived_at = NULL,
				updated_at = ${at},
				updated_by = ${scope.actorUserId}
			FROM (VALUES ${sql.join(
				chunk.map(
					(update) =>
						sql`(${update.id}::uuid, ${update.place.name}::text, ${update.place.levelUuid}::uuid, ${update.parentId}::uuid, ${update.place.latitude}::numeric, ${update.place.longitude}::numeric, ${JSON.stringify(update.place.values)}::jsonb, ${update.place.hqLocationId}::text, ${finalOrderKey.get(update.id) ?? ""}::text)`,
				),
			)}) AS v(id, name, level_uuid, parent_id, latitude, longitude, "values", hq_location_id, order_key)
			WHERE l.app_id = ${scope.appId} AND l.id = v.id
		`.execute(tx);
	}
	const rekeyOnly = [...rekeyed].filter((id) => !updated.has(id));
	for (let start = 0; start < rekeyOnly.length; start += WRITE_CHUNK) {
		const chunk = rekeyOnly.slice(start, start + WRITE_CHUNK);
		await sql`
			UPDATE app_locations AS l
			SET order_key = v.order_key
			FROM (VALUES ${sql.join(
				chunk.map(
					(id) => sql`(${id}::uuid, ${finalOrderKey.get(id) ?? ""}::text)`,
				),
			)}) AS v(id, order_key)
			WHERE l.app_id = ${scope.appId} AND l.id = v.id
		`.execute(tx);
	}
	for (let start = 0; start < archiveIds.length; start += WRITE_CHUNK) {
		await tx
			.updateTable("app_locations")
			.set({
				archived_at: at,
				updated_at: at,
				updated_by: scope.actorUserId,
			})
			.where("app_id", "=", scope.appId)
			.where("id", "in", archiveIds.slice(start, start + WRITE_CHUNK))
			.execute();
	}

	const rowsChanged =
		newPlaces.length > 0 || updates.length > 0 || archiveIds.length > 0;
	if (rowsChanged) {
		const app = await loadAppInTransaction(tx, scope.appId);
		if (app === null) throw organizationNotFound();
		await assertRefreshedRowsFit(
			tx,
			scope.appId,
			hydratePersistedBlueprint(app.blueprint),
		);
	}

	await tx
		.updateTable("app_organization_state")
		.set({
			hq_places_digest:
				keptIds.size === 0
					? plan.digest
					: divergedDigest(plan.digest, [...keptIds]),
			hq_left_out: JSON.stringify(plan.leftOut),
			hq_refreshed_at: at,
			hq_refreshed_by: scope.actorUserId,
		})
		.where("app_id", "=", scope.appId)
		.execute();
	if (rowsChanged || leftOutChanged) {
		await commitOrganizationChange(tx, scope, newPlaces.length);
	}
	return {
		added,
		changed,
		archived: archiveIds.length,
		keptInUse: keptInUse.sort(compareText),
		leftOut: plan.leftOut,
	};
}
