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
import {
	type ManagedPlacesRefreshRefusal,
	managedPlacesRefreshRefusal,
} from "@/lib/publish/managedData";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	assertLocationOwnerTargetsValid,
	assertPersonaAssignmentsValid,
} from "./commitIntegrity";
import { OrganizationError, organizationNotFound } from "./errors";
import { boundedLocationOrderKeyAtIndex } from "./orderKeys";
import {
	type OwnerVerdictLocation,
	ownerVerdictRows,
	reverseHopDestinationLevelUuids,
	reverseLocationOwnerIssue,
	reverseLocationOwnerVerdict,
} from "./ownerTargetVerdicts";
import { canonicalCoordinate, SITE_CODE_MAX_LENGTH } from "./schema";
import { readSourceObservation } from "./storedLocation";
import type {
	OrganizationRevision,
	OrganizationScope,
	PlaceSourceObservation,
} from "./types";
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
	readonly externalId?: string | null;
	readonly source?: PlaceSourceObservation;
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
	/**
	 * CommCare HQ's ids of the places `leftOut` counts. CommCare HQ still has
	 * each of them, so a refresh that keeps one because the app uses it does
	 * not count it gone. Empty at a birth.
	 */
	readonly leftOutHqLocationIds: readonly string[];
	readonly findings: readonly Finding[];
}

/** What a refresh changed in the copy. */
export interface ManagedPlacesRefresh {
	/** Places the copy did not hold live before: new ones, and archived ones CommCare HQ lists again. */
	readonly added: number;
	readonly changed: number;
	readonly archived: number;
	/**
	 * Places gone from CommCare HQ that a persona, an owner rule or an
	 * automation still names (an `app_location_references` edge): kept, with
	 * `hq_gone_at` set. A place the refresh leaves out because CommCare HQ
	 * holds it at a level the app lacks is kept the same way and is named in
	 * `keptLeftOut` instead: CommCare HQ still has it.
	 */
	readonly keptInUse: readonly string[]; // names
	/**
	 * Places gone from CommCare HQ whose site code CommCare HQ now gives a new
	 * place, which a persona, an owner rule or an automation still names: CommCare
	 * HQ made them again as new places. Kept with `hq_gone_at` set and a numbered
	 * code, beside the new place, which has a Nova id of its own. Not also in
	 * `keptInUse`.
	 */
	readonly remade: readonly string[]; // names
	/**
	 * Places CommCare HQ now holds at a level the app lacks that a persona, an
	 * owner rule or an automation still names: kept live as they stood before
	 * the refresh (their level, parent, name and values the copy held), with
	 * their CommCare HQ id and no `hq_gone_at`. The plan's `leftOut` counts
	 * them too, so the copy's standing line (`managedPlacesLeftOut`) says such places stay.
	 */
	readonly keptLeftOut: readonly string[]; // names
	readonly leftOut: Readonly<Record<string, number>>;
	/**
	 * Present where a newer refresh landed while this one was reading
	 * CommCare HQ, so this one wrote nothing and every count is zero.
	 */
	readonly superseded?: true;
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
	const hqIds = new Set<string>();
	for (const place of plan.places) {
		if (seen.has(place.siteCode)) {
			throw new Error(
				`The plan of CommCare HQ's places names the site code "${place.siteCode}" twice.`,
			);
		}
		if (hqIds.has(place.hqLocationId)) {
			throw new Error(
				`The plan of CommCare HQ's places names CommCare HQ's place "${place.hqLocationId}" twice.`,
			);
		}
		hqIds.add(place.hqLocationId);
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
					external_id: insert.place.externalId ?? null,
					hq_observation: insert.place.source
						? JSON.stringify(insert.place.source)
						: null,
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
 * Prove the refreshed live rows against the document as it stands, and
 * refuse with a sentence for the person where they do not fit. The planner
 * checks the levels it was handed, but the document can change between the
 * plan and this lock, and a place's new level or values can break a persona's
 * assignment or an owner rule that no planner sees.
 *
 * Archived rows are not proved. In a copy CommCare HQ manages, an archived
 * row is a place CommCare HQ no longer lists: no author can bring it back,
 * and the refresh that restores one writes its level, parent and values from
 * CommCare HQ's list. Proving it here would let a place deleted in CommCare
 * HQ refuse every later refresh, with nothing anyone could change.
 *
 * Every sentence names what the person can change: a place CommCare HQ has
 * is changed there, and a place the copy keeps only because the app uses it
 * though CommCare HQ no longer has it (`goneIds`) is released by changing
 * what uses it.
 */
async function assertRefreshedRowsFit(
	tx: Transaction<AppDatabase>,
	appId: string,
	doc: BlueprintDoc,
	copy: { readonly domain: string; readonly goneIds: ReadonlySet<string> },
): Promise<void> {
	const rows = await tx
		.selectFrom("app_locations")
		.select(["id", "name", "level_uuid", "parent_id", "values", "archived_at"])
		.where("app_id", "=", appId)
		// The order the places read in, so a sentence naming two of them
		// names them the same way every time.
		.orderBy("order_key")
		.orderBy("id")
		.execute();
	const refuse = (refusal: ManagedPlacesRefreshRefusal): OrganizationError =>
		new OrganizationError(
			"rejected",
			managedPlacesRefreshRefusal(refusal, copy.domain),
		);
	const levels = organizationLevelsOf(doc);
	const live = rows.filter((row) => row.archived_at === null);
	const liveById = new Map(live.map((row) => [row.id, row]));
	for (const row of live) {
		const level = levels[row.level_uuid];
		const parent =
			row.parent_id === null ? undefined : liveById.get(row.parent_id);
		const fits =
			level !== undefined &&
			(row.parent_id === null
				? level.parentLevelUuid === undefined
				: parent !== undefined &&
					levelMayNestUnder(row.level_uuid, parent.level_uuid, levels));
		const issue = fits
			? locationValueCatalogIssue(doc, row.level_uuid, row.values)
			: undefined;
		if (fits && issue === undefined) continue;
		if (copy.goneIds.has(row.id)) {
			throw refuse({ kind: "kept", place: row.name });
		}
		throw refuse(
			issue === undefined
				? { kind: "placement", place: row.name }
				: { kind: "value", place: row.name, issue },
		);
	}

	// A persona's assignment and a fixed owner name a place the app chose, and
	// their sentences already offer a step in Nova (another place, another
	// level setting).
	const kept = "Nova kept its copy as it was.";
	try {
		await assertPersonaAssignmentsValid(tx, { appId, candidateDoc: doc });
		await assertLocationOwnerTargetsValid(tx, { appId, candidateDoc: doc });
	} catch (error) {
		if (error instanceof BlueprintCommitRejectedError) {
			throw new OrganizationError("rejected", `${error.message} ${kept}`, {
				cause: error,
			});
		}
		throw error;
	}

	// A reverse owner hop needs exactly one place below each source, which
	// only CommCare HQ's places or a change of the rule can give.
	const verdictRows = ownerVerdictRows(rows);
	const isKept = (place: OwnerVerdictLocation): boolean =>
		copy.goneIds.has(place.id);
	for (const levelUuid of reverseHopDestinationLevelUuids(doc)) {
		const verdict = reverseLocationOwnerVerdict(doc, verdictRows, levelUuid);
		if (verdict === undefined) continue;
		switch (verdict.kind) {
			case "ambiguous":
				throw refuse({
					kind: "owner-ambiguous",
					level: verdict.level,
					source: verdict.source.name,
					places: [verdict.first.name, verdict.second.name],
					kept: isKept(verdict.first)
						? verdict.first.name
						: isKept(verdict.second)
							? verdict.second.name
							: null,
				});
			case "none-below":
				throw refuse({
					kind: "owner-none-below",
					level: verdict.level,
					source: verdict.source.name,
					sourceKept: isKept(verdict.source),
				});
			case "outside-address-book":
				throw refuse({
					kind: "owner-outside-address-book",
					level: verdict.level,
					place: verdict.destination.name,
					persona: verdict.persona,
				});
			default:
				// A rule the document alone refuses, which the commit gate keeps
				// out of every saved document.
				throw new OrganizationError(
					"rejected",
					`${reverseLocationOwnerIssue(doc, verdictRows, levelUuid)} ${kept}`,
				);
		}
	}
}

/**
 * Which row of the copy each planned place is, by the planned place's site
 * code.
 *
 * CommCare HQ's `location_id` first, because it never changes, while CommCare
 * HQ lets a place's site code change under it: the location form edits it
 * (`locations/forms.py::LocationForm.clean_site_code`), and the v0.6 API
 * makes a new one whenever a request renames a place without sending its
 * code (`locations/resources/v0_6.py::LocationResource._update`). A place
 * matched that way keeps its Nova id, which a case's owner and every persona
 * assignment name.
 *
 * Only by that id: a row of the copy is one CommCare HQ place for its whole
 * life. A place CommCare HQ lists under an id no row holds is a new place
 * with a new Nova id whatever its site code, since a site code is a name
 * CommCare HQ passes on: a place deleted there and made again under its code,
 * or a code another place gave up, is another place, and carrying a persona's
 * assignment, an owner rule or a saved case's owner across to it would hand
 * them a place no person chose. Where two rows hold one CommCare HQ id, the
 * live one is that place. A place a refresh kept after CommCare HQ stopped
 * listing it keeps its CommCare HQ id, so a place CommCare HQ lists again is
 * matched by that id even where it comes back under another code.
 */
function matchPlannedPlaces(
	rows: readonly LocationRow[],
	places: readonly ManagedPlaceWrite[],
): Map<string, LocationRow> {
	const byHqId = new Map<string, LocationRow>();
	for (const row of rows) {
		if (row.hq_location_id === null) continue;
		const held = byHqId.get(row.hq_location_id);
		if (
			held === undefined ||
			(held.archived_at !== null && row.archived_at === null)
		) {
			byHqId.set(row.hq_location_id, row);
		}
	}
	const matched = new Map<string, LocationRow>();
	for (const place of places) {
		const row = byHqId.get(place.hqLocationId);
		if (row === undefined) continue;
		matched.set(place.siteCode, row);
	}
	return matched;
}

/**
 * The code a row takes in place of its site code, where CommCare HQ now gives
 * that code to another of its places and no longer lists the row's own place
 * under it. The code and the first number from 2 that no row and no planned
 * place holds, the way Nova numbers a code it derives.
 */
function releasedSiteCode(code: string, taken: ReadonlySet<string>): string {
	const base = code.slice(0, SITE_CODE_MAX_LENGTH - 8);
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Set the site code of each row in `codes`, by row id. */
async function writeSiteCodes(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
	at: Date,
	codes: readonly { readonly id: string; readonly siteCode: string }[],
): Promise<void> {
	for (let start = 0; start < codes.length; start += WRITE_CHUNK) {
		const chunk = codes.slice(start, start + WRITE_CHUNK);
		await sql`
			UPDATE app_locations AS l
			SET site_code = v.site_code,
				updated_at = ${at},
				updated_by = ${scope.actorUserId}
			FROM (VALUES ${sql.join(
				chunk.map((code) => sql`(${code.id}::uuid, ${code.siteCode}::text)`),
			)}) AS v(id, site_code)
			WHERE l.app_id = ${scope.appId} AND l.id = v.id
		`.execute(tx);
	}
}

/**
 * Bring CommCare HQ's places into the copy: the one writer of a managed copy
 * after its birth.
 *
 * Matched by CommCare HQ's id alone ({@link matchPlannedPlaces}), which only
 * the insert writes: no refresh moves a row to another CommCare HQ place. A
 * place CommCare HQ lists and the copy lacks is inserted; one whose site
 * code, name, level, parent, coordinates or values differ, or that a refresh
 * kept as gone, is updated; one the copy holds live and
 * CommCare HQ no longer lists is archived, unless a persona, an owner rule or
 * an automation names it (`app_location_references`), in which case it stays
 * live with its CommCare HQ id, with every ancestor CommCare HQ no longer
 * lists kept live the same way, so no live place stands under an archived
 * one. Each kept place CommCare HQ no longer has takes `hq_gone_at`, and each
 * one named is reported; a kept place the plan leaves out because CommCare HQ
 * holds it at a level the app lacks is not gone. An archived one CommCare HQ
 * lists again is restored. A row CommCare HQ no longer lists whose site code
 * CommCare HQ now gives another place takes a numbered code
 * ({@link releasedSiteCode}), and where that row is kept because something
 * names it, its name is reported in `remade`: CommCare HQ made a place again
 * under its code, and what uses the old one stays with it. The refresh never
 * writes the document, so it never unassigns a persona: the person moves the
 * persona and refreshes again.
 *
 * Where the stored digest equals the plan's and the left-out counts are the
 * same, only the two refresh columns move and the revision does not.
 *
 * `at` is when the read of CommCare HQ began. No lock spans that read, so
 * two refreshes can read in one order and commit in the other: one whose
 * read began before the stored `hq_refreshed_at` writes nothing and answers
 * `superseded`, so an older read never replaces a newer one.
 */
export async function refreshManagedPlacesInTransaction(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
	input: {
		readonly plan: ManagedPlacePlan;
		readonly at: Date;
		readonly origin?: { server: string; domain: string };
	},
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
	if (
		input.origin &&
		(input.origin.server !== hq.server || input.origin.domain !== hq.domain)
	) {
		throw new OrganizationError(
			"rejected",
			"The source project space changed while Nova was reading its places. Refresh from the current source.",
		);
	}
	if (hq.refreshedAt !== null && hq.refreshedAt > at) {
		return {
			added: 0,
			changed: 0,
			archived: 0,
			keptInUse: [],
			remade: [],
			keptLeftOut: [],
			leftOut: hq.leftOut,
			superseded: true,
		};
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
			remade: [],
			keptLeftOut: [],
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
	const matched = matchPlannedPlaces(rows, plan.places);
	const matchedIds = new Set([...matched.values()].map((row) => row.id));

	const newPlaces = plan.places.filter((place) => !matched.has(place.siteCode));
	const minted = await mintLocationIds(tx, newPlaces.length);
	// Each planned place's row id, by the planned place's site code.
	const idBySiteCode = new Map(
		[...matched].map(([siteCode, row]) => [siteCode, row.id]),
	);
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
		const row = matched.get(place.siteCode);
		if (row === undefined) continue;
		const parentId = parentIdOf(place);
		const restored = row.archived_at !== null;
		const differs =
			row.hq_gone_at !== null ||
			row.site_code !== place.siteCode ||
			row.name !== place.name ||
			row.level_uuid !== place.levelUuid ||
			row.parent_id !== parentId ||
			row.external_id !== (place.externalId ?? null) ||
			canonicalJsonDigest(readSourceObservation(row.hq_observation)) !==
				canonicalJsonDigest(place.source ?? null) ||
			!sameCoordinate(row.latitude, place.latitude) ||
			!sameCoordinate(row.longitude, place.longitude) ||
			!sameValues(row.values, place.values);
		if (!restored && !differs) continue;
		if (restored) added += 1;
		else changed += 1;
		updates.push({ id: row.id, place, parentId });
		finalParent.set(row.id, parentId);
		finalName.set(row.id, place.name);
	}

	// Not in the plan: archive, except what a persona, an owner rule or an
	// automation names, and every unlisted ancestor of that, which stays live
	// with it. A kept place is gone from CommCare HQ unless the plan left it
	// out, which CommCare HQ holds at a level the app lacks.
	const byId = new Map(rows.map((row) => [row.id, row]));
	const leftOutHqIds = new Set(plan.leftOutHqLocationIds);
	const isGone = (row: LocationRow): boolean =>
		row.hq_location_id === null || !leftOutHqIds.has(row.hq_location_id);
	const gone = rows.filter(
		(row) => row.archived_at === null && !matchedIds.has(row.id),
	);
	const keptIds = new Set<string>();
	const keptInUse: LocationRow[] = [];
	const keptLeftOut: string[] = [];
	for (const row of gone) {
		if (!referenced.has(row.id)) continue;
		if (isGone(row)) keptInUse.push(row);
		else keptLeftOut.push(row.name);
		let current: LocationRow | undefined = row;
		while (
			current !== undefined &&
			!matchedIds.has(current.id) &&
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
	// Worker provisioning reads `hq_gone_at` as CommCare HQ no longer having
	// the place. The CommCare HQ id stays, so a refresh that finds the place
	// listed again, under any code, matches it by that id.
	const goneIds = new Set(
		[...keptIds].filter((id) => {
			const row = byId.get(id);
			return row !== undefined && isGone(row);
		}),
	);
	const goneMarks = [...goneIds].filter(
		(id) => byId.get(id)?.hq_gone_at === null,
	);
	const goneCleared = [...keptIds].filter(
		(id) => !goneIds.has(id) && byId.get(id)?.hq_gone_at !== null,
	);

	// Site codes. A row CommCare HQ no longer lists gives up a code CommCare HQ
	// now gives another place; a matched row whose code changed first takes a
	// placeholder no site code can spell (`~` is outside `SITE_CODE_PATTERN`),
	// so two places swapping codes, or a new place taking the code a re-coded
	// one left, never meets the app's unique site code midway.
	const plannedCodes = new Set(plan.places.map((place) => place.siteCode));
	const takenCodes = new Set([
		...rows.map((row) => row.site_code),
		...plannedCodes,
	]);
	const released: { id: string; siteCode: string }[] = [];
	for (const row of rows) {
		if (matchedIds.has(row.id) || !plannedCodes.has(row.site_code)) continue;
		const siteCode = releasedSiteCode(row.site_code, takenCodes);
		takenCodes.add(siteCode);
		released.push({ id: row.id, siteCode });
	}
	const releasedIds = new Set(released.map((row) => row.id));
	const recoded = updates
		.filter(
			(update) => byId.get(update.id)?.site_code !== update.place.siteCode,
		)
		.map((update) => {
			const siteCode = releasedSiteCode(`~${update.id}`, takenCodes);
			takenCodes.add(siteCode);
			return { id: update.id, siteCode };
		});

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

	await writeSiteCodes(tx, scope, at, [...released, ...recoded]);
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
			SET site_code = v.site_code,
				name = v.name,
				level_uuid = v.level_uuid,
				parent_id = v.parent_id,
				latitude = v.latitude,
				longitude = v.longitude,
				external_id = v.external_id,
				hq_observation = v.hq_observation,
				"values" = v.values,
				hq_gone_at = NULL,
				order_key = v.order_key,
				archived_at = NULL,
				updated_at = ${at},
				updated_by = ${scope.actorUserId}
			FROM (VALUES ${sql.join(
				chunk.map(
					(update) =>
						sql`(${update.id}::uuid, ${update.place.siteCode}::text, ${update.place.name}::text, ${update.place.levelUuid}::uuid, ${update.parentId}::uuid, ${update.place.latitude}::numeric, ${update.place.longitude}::numeric, ${update.place.externalId ?? null}::text, ${update.place.source ? JSON.stringify(update.place.source) : null}::text, ${JSON.stringify(update.place.values)}::jsonb, ${finalOrderKey.get(update.id) ?? ""}::text)`,
				),
			)}) AS v(id, site_code, name, level_uuid, parent_id, latitude, longitude, external_id, hq_observation, "values", order_key)
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

	for (const [ids, goneAt] of [
		[goneMarks, at],
		[goneCleared, null],
	] as const) {
		for (let start = 0; start < ids.length; start += WRITE_CHUNK) {
			await tx
				.updateTable("app_locations")
				.set({
					hq_gone_at: goneAt,
					updated_at: at,
					updated_by: scope.actorUserId,
				})
				.where("app_id", "=", scope.appId)
				.where("id", "in", ids.slice(start, start + WRITE_CHUNK))
				.execute();
		}
	}
	const rowsChanged =
		newPlaces.length > 0 ||
		updates.length > 0 ||
		archiveIds.length > 0 ||
		released.length > 0 ||
		goneMarks.length > 0 ||
		goneCleared.length > 0;
	if (rowsChanged) {
		const app = await loadAppInTransaction(tx, scope.appId);
		if (app === null) throw organizationNotFound();
		await assertRefreshedRowsFit(
			tx,
			scope.appId,
			hydratePersistedBlueprint(app.blueprint),
			{ domain: hq.domain, goneIds },
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
		keptInUse: keptInUse
			.filter((row) => !releasedIds.has(row.id))
			.map((row) => row.name)
			.sort(compareText),
		remade: keptInUse
			.filter((row) => releasedIds.has(row.id))
			.map((row) => row.name)
			.sort(compareText),
		keptLeftOut: keptLeftOut.sort(compareText),
		leftOut: plan.leftOut,
	};
}
