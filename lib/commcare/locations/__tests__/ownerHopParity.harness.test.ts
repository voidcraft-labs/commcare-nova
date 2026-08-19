// The device and the preview must resolve a reverse hop to the SAME place.
//
// One authored rule, `{ kind: "owner-location-at-level" }`, has two completely
// separate lowerings: `termEmitter.emitTerm` writes XPath over the restore's
// `locations` fixture, and `compileTerm.ts` writes a recursive CTE over
// `app_locations`. Nothing structural ties them together — they share a rule,
// not a code path — so they can drift silently, and the symptom would be a
// preview that assigns cases correctly and a device that assigns them somewhere
// else. Nobody would see that until the data was already wrong.
//
// This is the test that makes the fixture non-speculative. Without it the
// emitter is bytes nothing reads: `buildFlatLocationsFixture` and the XPath
// lowering could both be wrong in the same direction and every other test in
// the unit would still pass.
//
// The two sides are genuinely independent. The wire side runs the emitted
// string through `wireXPathReference`, a Lezer-driven evaluator that knows
// nothing about organizations; the SQL side runs Kysely's output through real
// Postgres. Neither shares a helper with the other.
//
// SCOPE, stated rather than implied: this isolates the LOWERING. The worker's
// footprint here is the whole live tree, because a footprint that differed
// between the two sides would make them disagree for a reason that has nothing
// to do with the rule. Footprint scoping is `lib/organization/footprint.ts`'s
// own test.

import { type Element, isTag } from "domhandler";
import { describe, expect } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCaseRow, test } from "@/lib/case-store/sql/__tests__/setup";
import { compileTerm } from "@/lib/case-store/sql/compileTerm";
import { emitCasePropertyWirePath } from "@/lib/commcare/casePropertyWire";
import { el, text } from "@/lib/commcare/elementBuilders";
import { emitTerm } from "@/lib/commcare/predicate/termEmitter";
import type { CaseType, OrganizationLevel, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { StoredLocation } from "@/lib/organization/types";
import { buildFlatLocationsFixture } from "./flatLocationsFixture";
import { evaluateWireXPath } from "./wireXPathReference";

const APP_ID = "app-location-parity";
const PROJECT_ID = "project-location-parity";
const CASE_ID = testUuid("parity-current-case");
const CASE_TYPE = "patient";
const SCHEMAS = new Map<string, CaseType>([
	[
		CASE_TYPE,
		{
			name: CASE_TYPE,
			properties: [{ name: "status", label: proseText("Status") }],
		},
	],
]);

/** `caseOps.ts::formCasePropertyResolver` — the anchor every form-surface
 *  emission uses, so the owner sub-expression here is the one a real XForm
 *  carries rather than the bare relative form. */
const SESSION_CASE_ID = "instance('commcaresession')/session/data/case_id";
function anchorOnSessionCase(property: { readonly property: string }): string {
	return `instance('casedb')/casedb/case[@case_id=${SESSION_CASE_ID}]/${emitCasePropertyWirePath(property.property)}`;
}

// ── Generated organizations ──────────────────────────────────────────

/** A seeded generator, so a failure names a world that can be re-run. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

interface Place {
	readonly id: string;
	readonly levelIndex: number;
	readonly parentId: string | null;
	readonly siteCode: string;
	archived: boolean;
}

interface World {
	readonly seed: number;
	readonly levels: readonly OrganizationLevel[];
	readonly places: readonly Place[];
}

function generateWorld(seed: number): World {
	const rand = seeded(20260819 + seed * 7919);
	// Three levels minimum, so every world HAS a middle rung. Two-level worlds
	// can only ever produce a parent hop, and a sweep made mostly of those
	// leaves the emitter's walk to the nearest case-owning ancestor proved by
	// almost nothing.
	const levelCount = 3 + (seed % 2);
	const levels: OrganizationLevel[] = [];
	for (let index = 0; index < levelCount; index += 1) {
		// Enumerated from the world index rather than rolled. Ownership is the
		// one input that decides whether the walk-up runs at all, and leaving it
		// to chance is what made an earlier version of this sweep cover the
		// multi-rung hop exactly once across 24 worlds. Level 0 always owns
		// cases, so every world has a usable source.
		const ownsCases = index === 0 || ((seed >> (index + 1)) & 1) === 1;
		levels.push({
			uuid: testUuid(`parity-level-${seed}-${index}`),
			code: `lvl${index}`,
			name: `Level ${index}`,
			...(index > 0 && {
				parentLevelUuid: testUuid(`parity-level-${seed}-${index - 1}`),
			}),
			caseFlow: { workers: "none", ownsCases },
			addressBook: { reach: "own-branch" },
		});
	}

	const spine = Math.floor(seed / 2) % 2 === 0;
	const places: Place[] = [];
	let counter = 0;
	const spawn = (levelIndex: number, parentId: string | null): void => {
		const id = testUuid(`parity-place-${seed}-${counter}`);
		counter += 1;
		places.push({
			id,
			levelIndex,
			parentId,
			siteCode: `site-${String(counter).padStart(3, "0")}`,
			archived: false,
		});
		if (levelIndex + 1 >= levelCount) return;
		// Half the worlds are SPINES — one child per place, all the way down —
		// and half are BUSHY. Only spines reliably put a destination under every
		// source, which is what makes an assertion prove an ID rather than prove
		// two empties match; only bushy trees produce the empty and ambiguous
		// cases. Generating one kind makes the property vacuous in one direction.
		const children = spine ? 1 : Math.floor(rand() * 3);
		for (let index = 0; index < children; index += 1) spawn(levelIndex + 1, id);
	};
	const roots = 1 + Math.floor(rand() * 2);
	for (let index = 0; index < roots; index += 1) spawn(0, null);

	// Archiving CASCADES in Nova, the same as `SQLLocation.archive` taking
	// `get_descendants(include_self=True)`. Modelling it any other way would
	// generate a live place under an archived parent — a state the product
	// cannot reach, and one where the two sides legitimately differ (the SQL
	// walk filters `archived_at` on the destination only, while the fixture
	// never carries an archived ancestor to hop through).
	const byId = new Map(places.map((place) => [place.id, place]));
	for (const place of places) {
		if (place.levelIndex === 0 || rand() >= 0.12) continue;
		const pending = [place.id];
		while (pending.length > 0) {
			const id = pending.pop();
			if (id === undefined) continue;
			const target = byId.get(id);
			if (target !== undefined) target.archived = true;
			for (const child of places) {
				if (child.parentId === id) pending.push(child.id);
			}
		}
	}
	return { seed, levels, places };
}

/** The place's ancestor at `levelIndex`, or undefined. */
function ancestorAt(
	place: Place,
	levelIndex: number,
	byId: ReadonlyMap<string, Place>,
): Place | undefined {
	let cursor: Place | undefined = place;
	while (cursor !== undefined && cursor.levelIndex > levelIndex) {
		cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
	}
	return cursor?.levelIndex === levelIndex ? cursor : undefined;
}

/** The nearest strictly-higher level that owns cases — the emitter's own walk
 *  and `compileTerm`'s `ancestorLevels(...).find(levelOwnsCases)`. */
function sourceIndexFor(
	world: World,
	destinationIndex: number,
): number | undefined {
	for (let index = destinationIndex - 1; index >= 0; index -= 1) {
		if (world.levels[index].caseFlow.ownsCases) return index;
	}
	return undefined;
}

// ── The two evaluators ───────────────────────────────────────────────

function storedLocations(world: World): StoredLocation[] {
	return world.places.map((place) => ({
		id: place.id as Uuid,
		levelUuid: world.levels[place.levelIndex].uuid,
		parentId: place.parentId as Uuid | null,
		siteCode: place.siteCode,
		name: place.siteCode,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: place.archived ? new Date("2026-01-01T00:00:00Z") : null,
		orderKey: "a",
	}));
}

function wireWorld(world: World, ownerId: string) {
	const fixture = buildFlatLocationsFixture({
		userId: "parity-worker",
		places: storedLocations(world),
		levels: world.levels,
		locationProperties: [],
	}).fixture;
	// The restore's own shapes: one `<casedb>` holding the current case, and
	// the session's selected `case_id`. Building them rather than stubbing the
	// owner value keeps the whole emitted expression under test, including how
	// it addresses the case.
	const casedb = el("instance-casedb", {}, [
		el("casedb", {}, [el("case", { case_id: CASE_ID, owner_id: ownerId }, [])]),
	]);
	const session = el("instance-session", {}, [
		el("session", {}, [el("data", {}, [el("case_id", {}, [text(CASE_ID)])])]),
	]);
	return {
		instances: { locations: fixture, casedb, commcaresession: session },
	};
}

function organizationLevels(
	world: World,
): Readonly<Record<string, OrganizationLevel>> {
	return Object.fromEntries(
		world.levels.map((level) => [level.uuid as string, level]),
	);
}

async function seedOrganization(
	db: Parameters<typeof compileTerm>[1]["db"],
	world: World,
): Promise<void> {
	// Parents before children: `app_locations.parent_id` is a real edge and the
	// insert order has to respect it.
	const ordered = [...world.places].sort((a, b) => a.levelIndex - b.levelIndex);
	for (const place of ordered) {
		await db
			.insertInto("app_locations")
			.values({
				id: place.id,
				app_id: APP_ID,
				level_uuid: world.levels[place.levelIndex].uuid,
				parent_id: place.parentId,
				site_code: place.siteCode,
				name: place.siteCode,
				external_id: null,
				latitude: null,
				longitude: null,
				values: JSON.stringify({}),
				archived_at: place.archived ? new Date("2026-01-01T00:00:00Z") : null,
				order_key: "a",
			})
			.execute();
	}
}

async function sqlDestination(
	db: Parameters<typeof compileTerm>[1]["db"],
	world: World,
	levelUuid: string,
): Promise<string> {
	const compiled = compileTerm(
		{
			kind: "owner-location-at-level",
			levelUuid: levelUuid as Uuid,
			ownerCaseType: CASE_TYPE,
		},
		{
			db,
			appId: APP_ID,
			projectId: PROJECT_ID,
			anchorAlias: "c",
			currentCaseType: CASE_TYPE,
			caseTypeSchemas: SCHEMAS,
			organizationLevels: organizationLevels(world),
			bindings: {},
		},
	);
	const row = await db
		.selectFrom("cases as c")
		.where("c.case_id", "=", CASE_ID)
		.where("c.app_id", "=", APP_ID)
		.select(compiled.as("destination"))
		.executeTakeFirst();
	const value = (row as { destination?: string | null } | undefined)
		?.destination;
	return value ?? "";
}

function wireDestination(
	world: World,
	levelUuid: string,
	ownerId: string,
): string {
	const expression = emitTerm(
		{
			kind: "owner-location-at-level",
			levelUuid: levelUuid as Uuid,
			ownerCaseType: CASE_TYPE,
		},
		"casedb",
		{
			organizationLevels: organizationLevels(world),
			caseProperty: (property, _root, scope) =>
				scope === "root" && property.caseType === CASE_TYPE
					? anchorOnSessionCase(property)
					: undefined,
		},
	);
	return evaluateWireXPath(expression, wireWorld(world, ownerId));
}

// ── The property ─────────────────────────────────────────────────────

const WORLDS = Array.from({ length: 24 }, (_, index) => generateWorld(index));

describe("a reverse hop resolves to the same place on both sides", () => {
	test("over generated organizations", async ({ db }) => {
		let checked = 0;
		let ambiguous = 0;
		/** Pairs whose expected answer is an actual place id. An empty answer is
		 *  also what a broken emitter produces, so these are the assertions that
		 *  carry weight. */
		let resolved = 0;
		/** Pairs where the source is more than one rung above the destination —
		 *  the only shape where the walk to the nearest case-owning ancestor
		 *  does anything. */
		let multiRung = 0;
		let multiRungResolved = 0;
		for (const world of WORLDS) {
			await db
				.insertInto("cases")
				.values(
					makeCaseRow({
						case_id: CASE_ID,
						app_id: APP_ID,
						project_id: PROJECT_ID,
						case_type: CASE_TYPE,
						owner_id: "unset",
					}),
				)
				.execute();
			await seedOrganization(db, world);
			const byId = new Map(world.places.map((place) => [place.id, place]));
			const live = world.places.filter((place) => !place.archived);

			for (
				let destinationIndex = 1;
				destinationIndex < world.levels.length;
				destinationIndex += 1
			) {
				const sourceIndex = sourceIndexFor(world, destinationIndex);
				if (sourceIndex === undefined) continue;
				const levelUuid = world.levels[destinationIndex].uuid as string;

				for (const owner of world.places) {
					if (owner.levelIndex !== sourceIndex) continue;
					const candidates = live.filter(
						(place) =>
							place.levelIndex === destinationIndex &&
							ancestorAt(place, sourceIndex, byId)?.id === owner.id,
					);
					if (candidates.length > 1) {
						// `commitIntegrity::assertReverseHopTargetsUnambiguous` refuses
						// this shape, and both sides pick arbitrarily here — SQL by
						// `LIMIT 1` with no order, XPath by document order. Comparing
						// them would be testing two coin flips.
						ambiguous += 1;
						continue;
					}
					const expected = owner.archived ? "" : (candidates[0]?.id ?? "");
					if (expected !== "") resolved += 1;
					if (sourceIndex < destinationIndex - 1) {
						multiRung += 1;
						if (expected !== "") multiRungResolved += 1;
					}

					await db
						.updateTable("cases")
						.set({ owner_id: owner.id })
						.where("case_id", "=", CASE_ID)
						.execute();

					const sql = await sqlDestination(db, world, levelUuid);
					const wire = wireDestination(world, levelUuid, owner.id);
					expect(
						{ sql, wire },
						`world ${world.seed}: owner ${owner.siteCode} → level ${destinationIndex}`,
					).toEqual({ sql: expected, wire: expected });
					checked += 1;
				}
			}
			await db
				.deleteFrom("app_locations")
				.where("app_id", "=", APP_ID)
				.execute();
			await db.deleteFrom("cases").where("case_id", "=", CASE_ID).execute();
		}
		// A generator that quietly stopped producing hoppable worlds would make
		// every assertion above vacuous, so the SHAPE of the coverage is
		// asserted too, not just its size. Counting pairs alone hid exactly this
		// once: 73 pairs of which 56 were empty-equals-empty and one exercised
		// the multi-rung walk.
		expect(checked).toBeGreaterThan(60);
		expect(resolved).toBeGreaterThan(40);
		expect(multiRung).toBeGreaterThan(20);
		expect(multiRungResolved).toBeGreaterThan(12);
		expect(ambiguous).toBeGreaterThan(0);
	});

	test("both answer nothing for an owner that is not a place", async ({
		db,
	}) => {
		// The ordinary case: a case owned by a worker rather than a place. The
		// hop has no source row to start from, and "no answer" has to be the
		// answer on both sides — an owner rule that silently fell back to the
		// first place in the tree would hand a case to a stranger.
		const world = WORLDS[0];
		await seedOrganization(db, world);
		await db
			.insertInto("cases")
			.values(
				makeCaseRow({
					case_id: CASE_ID,
					app_id: APP_ID,
					project_id: PROJECT_ID,
					case_type: CASE_TYPE,
					owner_id: testUuid("parity-a-worker"),
				}),
			)
			.execute();
		const levelUuid = world.levels[1].uuid as string;
		expect(await sqlDestination(db, world, levelUuid)).toBe("");
		expect(wireDestination(world, levelUuid, testUuid("parity-a-worker"))).toBe(
			"",
		);
	});

	test("the emitted fixture holds every destination the rule can reach", async () => {
		// The unit's own acceptance: every valid destination is present in the
		// emitted fixture. Read the other way, this is what would fail if the
		// footprint and the fixture ever disagreed about which places ship.
		for (const world of WORLDS) {
			const fixture = buildFlatLocationsFixture({
				userId: "parity-worker",
				places: storedLocations(world),
				levels: world.levels,
				locationProperties: [],
			}).fixture;
			const emitted = new Set(
				(fixture.children[0] as Element).children
					.filter((child): child is Element => isTag(child))
					.map((child) => child.attribs.id),
			);
			for (const place of world.places) {
				expect(
					emitted.has(place.id),
					`world ${world.seed}: ${place.siteCode}`,
				).toBe(!place.archived);
			}
		}
	});
});
