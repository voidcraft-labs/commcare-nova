/**
 * The places of a CommCare HQ project space, as a reading brings them in and
 * a refresh brings them up to date: whether an app reads places at all, the
 * plan of Nova's copy, and the owner rules that copy would refuse.
 *
 * Pure: every function takes what was read and returns a verdict or a plan.
 * The copy's writers are `lib/organization/managed.ts`'s, reached at a birth
 * through `placeStore.ts`.
 */

import type { HqLocation } from "@/lib/commcare/hq/locations";
import {
	type BlueprintDoc,
	type LocationProperty,
	levelMayNestUnder,
	locationValueTextSchema,
	type OrganizationLevel,
	organizationLevelsOf,
	type Uuid,
} from "@/lib/domain";
import { walkExpression } from "@/lib/domain/expression/walk";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type {
	ManagedPlacePlan,
	ManagedPlaceWrite,
} from "@/lib/organization/managed";
import {
	type OwnerVerdictLocationRow,
	ownerVerdictRows,
	reverseHopDestinationLevelUuids,
	reverseLocationOwnerIssue,
} from "@/lib/organization/ownerTargetVerdicts";
import {
	coordinateSchema,
	LOCATION_NAME_MAX_LENGTH,
	MAX_LOCATIONS_PER_APP,
	siteCodeSchema,
} from "@/lib/organization/schema";
import { circumstanceFinding, type Finding } from "@/lib/publish/hqFindings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const ORGANIZATION = { kind: "organization" } as const;

// ── When places come in ──────────────────────────────────────────────────

/**
 * Whether `doc` reads places: a `locations` read, or a place's field, level
 * or the owner rule that finds a place at a level, in any expression slot of
 * any menu, form or question, a calculated value in a text included.
 */
export function documentReadsPlaces(doc: BlueprintDoc): boolean {
	const carriers: ExpressionCarrierRef[] = [
		...(Object.keys(doc.modules) as Uuid[]).map((uuid) => ({
			entity: "module" as const,
			uuid,
		})),
		...(Object.keys(doc.forms) as Uuid[]).map((uuid) => ({
			entity: "form" as const,
			uuid,
		})),
		...(Object.keys(doc.fields) as Uuid[]).map((uuid) => ({
			entity: "field" as const,
			uuid,
		})),
	];
	for (const owner of carriers)
		for (const { expression } of expressionSlotValues(doc, owner)) {
			let reads = false;
			walkExpression(expression, {
				visitExpression: (node) => {
					if (node.kind === "locations") reads = true;
				},
				visitTerm: (term) => {
					if (
						term.kind === "location-field" ||
						term.kind === "location-level" ||
						term.kind === "owner-location-at-level"
					)
						reads = true;
				},
			});
			if (reads) return true;
		}
	return false;
}

/** Each spelling of a quote mark the source's text can carry: as written, and
 *  as an XML attribute's or text's entity. Inside a JSON body a double quote
 *  is `\"`, which begins in `\` and ends in `"`. */
const QUOTED_LOCATIONS = [
	"'locations'",
	'"locations"',
	'"locations\\"',
	"&apos;locations&apos;",
	"&quot;locations&quot;",
] as const;

/** The fixture addresses a form's instance of places is declared from: the
 *  flat fixture and the hierarchical one, each of which the reader counts as a
 *  read of places (`reader/provisional.ts::textReadsPlaces`). */
const PLACE_FIXTURE_SOURCES = [
	"jr://fixture/locations",
	"jr://fixture/commtrack:locations",
] as const;

/**
 * Whether the source's text (the app's body and every form's attachment) may
 * read places: it names a fixture address a form's instance declares for
 * them, whatever id the form gives that instance, or holds the whole word
 * `locations` between two quote marks of one spelling, which is how a suite
 * expression names the instance by id in a string literal, in either quote
 * and with any white space inside the call's parentheses. A name that only
 * begins with the word, such as a question's `locations_visited`, is no
 * literal of the instance's id. This is a test of the text, not a reading of
 * an expression: it can say yes where nothing reads places, and a yes costs
 * two reads.
 */
export function sourceMayReadPlaces(sourceText: string): boolean {
	return (
		PLACE_FIXTURE_SOURCES.some((source) => sourceText.includes(source)) ||
		QUOTED_LOCATIONS.some((quoted) => sourceText.includes(quoted))
	);
}

// ── The plan of the copy ─────────────────────────────────────────────────

/** `"12,400 places"`, or `"more place information than Nova reads"` where the list passed its byte bound. */
function placesOverLimitName(totalCount: number | null): string {
	return totalCount === null
		? "more place information than Nova reads"
		: `${totalCount.toLocaleString("en-US")} places`;
}

/**
 * The circumstance of a project space with more places than an app holds,
 * named by CommCare HQ's total, or, where the list passed
 * `bounds.ts::HQ_LOCATION_LIST_MAX_BYTES`, by that.
 */
export function placesOverNovaLimitFinding(totalCount: number | null): Finding {
	return circumstanceFinding("places-over-nova-limit", ORGANIZATION, {
		name: placesOverLimitName(totalCount),
	});
}

/** Code unit order: the same answer on every machine, unlike a locale's. */
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The plan's digest: the places in site code order, each with every field a
 *  write holds, so the order CommCare HQ listed them in changes nothing. */
function placesDigest(places: readonly ManagedPlaceWrite[]): string {
	return canonicalJsonDigest(
		[...places].sort((left, right) =>
			compareText(left.siteCode, right.siteCode),
		),
	);
}

/** A coordinate as the store holds it, or `false` where it holds none such. */
function heldCoordinate(raw: string | null): string | null | false {
	if (raw === null) return null;
	const parsed = coordinateSchema.safeParse(raw);
	return parsed.success ? parsed.data : false;
}

/**
 * Nova's copy of CommCare HQ's places, planned over the app's levels and
 * location properties, parent before child.
 *
 * A list longer than an app holds is one `places-over-nova-limit` and no
 * place, whatever the places hold. Otherwise each place is read from its top
 * down, and every problem of every place is found in one pass, each the
 * circumstance `place-not-holdable` at the organization, named by the place:
 * a site code the store refuses, that is not its own lower case, or that
 * another listed place holds in any letters; a name over the store's length;
 * a coordinate the store refuses; a parent that is not listed, or a chain of
 * parents that never reaches the top; and a level that may not stand where
 * the place stands (a top place at a level with a level above it, or a level
 * that may not nest under its parent's). A value read for a location property
 * that applies at the place's level, and is not text the store holds, is
 * named `"<place>: <slug>"`. A place under one with a problem is held back
 * with it and adds no problem of its own placement; its own fields are still
 * read.
 *
 * A place whose level code no level of the app has is left out, with every
 * place under it. At a `birth` the levels are the ones the reading brings, so
 * such a level is one the levels' own finding already stands for, and nothing
 * more is found or counted. At a `refresh` each place left out is counted in
 * `leftOut` under the level code that left it out: its own where the app has
 * no such level, else the code of the nearest place above it that was left
 * out. Their CommCare HQ ids are `leftOutHqLocationIds`, so a refresh tells a
 * place left out from one CommCare HQ no longer has.
 *
 * `values` holds, for each location property that applies at the place's
 * level, the place's `location_data` under the property's slug, where it has
 * one. Keys no property reads are not copied.
 */
export function planManagedPlaces(input: {
	readonly hqPlaces: readonly HqLocation[];
	readonly levels: readonly OrganizationLevel[];
	readonly properties: readonly LocationProperty[];
	/** `birth`: a level the app lacks cannot happen. `refresh`: such places are left out. */
	readonly mode: "birth" | "refresh";
}): ManagedPlacePlan {
	const { hqPlaces, levels, properties, mode } = input;
	if (hqPlaces.length > MAX_LOCATIONS_PER_APP) {
		return {
			places: [],
			digest: placesDigest([]),
			leftOut: NO_ENTRIES,
			leftOutHqLocationIds: [],
			findings: [placesOverNovaLimitFinding(hqPlaces.length)],
		};
	}

	const levelByCode = new Map(levels.map((level) => [level.code, level]));
	const levelRecord: Record<string, OrganizationLevel> = recordFromEntries(
		levels.map((level) => [level.uuid, level]),
	);
	const byId = new Map(hqPlaces.map((place) => [place.locationId, place]));
	const children = new Map<string | null, HqLocation[]>();
	for (const place of hqPlaces) {
		const parent =
			place.parentLocationId !== null && byId.has(place.parentLocationId)
				? place.parentLocationId
				: null;
		const siblings = children.get(parent);
		if (siblings === undefined) children.set(parent, [place]);
		else siblings.push(place);
	}
	const siteCodeHolders = new Map<string, number>();
	for (const place of hqPlaces) {
		const key = place.siteCode.toLowerCase();
		siteCodeHolders.set(key, (siteCodeHolders.get(key) ?? 0) + 1);
	}

	const places: ManagedPlaceWrite[] = [];
	const leftOut = recordFromEntries<number>([]);
	const leftOutHqLocationIds: string[] = [];
	const findingNames: string[] = [];
	const found = new Set<string>();
	const notHoldable = (name: string) => {
		if (found.has(name)) return;
		found.add(name);
		findingNames.push(name);
	};

	/** The place as a write, or undefined where one of its own fields is one
	 *  the store cannot hold; each such field is found. */
	const ownWrite = (
		place: HqLocation,
		level: OrganizationLevel,
		parentSiteCode: string | null,
	): ManagedPlaceWrite | undefined => {
		let holdable = true;
		if (
			!siteCodeSchema.safeParse(place.siteCode).success ||
			place.siteCode !== place.siteCode.toLowerCase() ||
			(siteCodeHolders.get(place.siteCode.toLowerCase()) ?? 0) > 1
		)
			holdable = false;
		if (place.name.length > LOCATION_NAME_MAX_LENGTH) holdable = false;
		const latitude = heldCoordinate(place.latitude);
		const longitude = heldCoordinate(place.longitude);
		if (latitude === false || longitude === false) holdable = false;
		if (!holdable) notHoldable(place.name);

		const values = recordFromEntries<string>([]);
		for (const property of properties) {
			if (
				property.levelUuids !== undefined &&
				!property.levelUuids.includes(level.uuid)
			)
				continue;
			if (!Object.hasOwn(place.values, property.slug)) continue;
			const raw = place.values[property.slug];
			if (
				typeof raw !== "string" ||
				!locationValueTextSchema.safeParse(raw).success
			) {
				notHoldable(`${place.name}: ${property.slug}`);
				holdable = false;
				continue;
			}
			values[property.uuid] = raw;
		}
		if (!holdable || latitude === false || longitude === false)
			return undefined;
		return {
			hqLocationId: place.locationId,
			siteCode: place.siteCode,
			name: place.name,
			levelUuid: level.uuid,
			parentSiteCode,
			latitude,
			longitude,
			values,
		};
	};

	type Visit = {
		readonly place: HqLocation;
		/** The parent as the plan holds it; null for a place at the top, and
		 *  for one whose parent is held back or left out. */
		readonly parent: ManagedPlaceWrite | null;
		/** Whether a place above was held back by a problem. */
		readonly heldBack: boolean;
		/** The level code a place above was left out under, or null. */
		readonly leftOutUnder: string | null;
	};
	const visited = new Set<string>();
	const stack: Visit[] = [];
	const pushChildren = (
		parentId: string | null,
		of: (place: HqLocation) => Visit,
	) => {
		const kids = children.get(parentId) ?? [];
		for (let index = kids.length - 1; index >= 0; index--)
			stack.push(of(kids[index]));
	};
	pushChildren(null, (place) => ({
		place,
		parent: null,
		heldBack: false,
		leftOutUnder: null,
	}));

	while (stack.length > 0) {
		const visit = stack.pop() as Visit;
		const { place } = visit;
		if (visited.has(place.locationId)) continue;
		visited.add(place.locationId);

		const level = levelByCode.get(place.locationTypeCode);
		if (visit.leftOutUnder !== null || level === undefined) {
			const under =
				level === undefined ? place.locationTypeCode : visit.leftOutUnder;
			if (mode === "refresh" && under !== null) {
				leftOut[under] = (leftOut[under] ?? 0) + 1;
				leftOutHqLocationIds.push(place.locationId);
			}
			pushChildren(place.locationId, (child) => ({
				place: child,
				parent: null,
				heldBack: false,
				leftOutUnder: under,
			}));
			continue;
		}

		let placed = !visit.heldBack;
		const listedParent =
			place.parentLocationId !== null && byId.has(place.parentLocationId);
		if (place.parentLocationId !== null && !listedParent) {
			notHoldable(place.name);
			placed = false;
		} else if (placed) {
			const fits =
				visit.parent === null
					? level.parentLevelUuid === undefined
					: levelMayNestUnder(level.uuid, visit.parent.levelUuid, levelRecord);
			if (!fits) {
				notHoldable(place.name);
				placed = false;
			}
		}
		const write = ownWrite(
			place,
			level,
			visit.parent === null ? null : visit.parent.siteCode,
		);
		const kept = placed && write !== undefined;
		if (kept) places.push(write);
		pushChildren(place.locationId, (child) => ({
			place: child,
			parent: kept ? write : null,
			heldBack: !kept,
			leftOutUnder: null,
		}));
	}

	// A place no walk from the top reached stands in a chain of parents that
	// runs in a circle.
	for (const place of hqPlaces)
		if (!visited.has(place.locationId)) notHoldable(place.name);

	return {
		places,
		digest: placesDigest(places),
		leftOut,
		leftOutHqLocationIds,
		findings: findingNames.map((name) =>
			circumstanceFinding("place-not-holdable", ORGANIZATION, { name }),
		),
	};
}

// ── The owner rules the copy would refuse ────────────────────────────────

/**
 * The owner rules of `doc` that the copy would refuse, as findings: the
 * check a birth's organization integrity step runs over the stored rows
 * (`commitIntegrity.ts::assertReverseHopTargetsUnambiguous`), run over the
 * planned places, each a live place whose id is its site code. A rule that
 * gives a case to the place at a level below its owner holds only where
 * exactly one such place stands below each place that owns cases; one where
 * it does not is `owner-rule-needs-one-place`, named by the level.
 */
export function managedPlacesOwnerFindings(
	doc: BlueprintDoc,
	plan: ManagedPlacePlan,
): readonly Finding[] {
	const destinations = reverseHopDestinationLevelUuids(doc);
	if (destinations.length === 0) return [];
	const rows = ownerVerdictRows(
		plan.places.map(
			(place): OwnerVerdictLocationRow => ({
				id: place.siteCode,
				name: place.name,
				level_uuid: place.levelUuid,
				parent_id: place.parentSiteCode,
				archived_at: null,
			}),
		),
	);
	const findings: Finding[] = [];
	for (const levelUuid of destinations) {
		if (reverseLocationOwnerIssue(doc, rows, levelUuid) === undefined) continue;
		findings.push(
			circumstanceFinding("owner-rule-needs-one-place", ORGANIZATION, {
				name: organizationLevelsOf(doc)[levelUuid]?.name ?? levelUuid,
			}),
		);
	}
	return findings;
}
