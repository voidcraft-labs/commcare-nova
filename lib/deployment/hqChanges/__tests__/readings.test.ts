/**
 * The two readings a change made in CommCare HQ is the difference of.
 *
 * Contract (`readings.ts::makeHqChangeReadings`): the base reading reads the
 * baseline as it is stored, the reading now reads CommCare HQ's app now, and
 * both share every input but the source, its menus and the media index; an
 * app CommCare HQ serves again unchanged reads as one document on both sides,
 * whatever order its maps hold their keys in; each side's media index answers
 * a path by its standing (Nova's own file where the reference publishes it and
 * CommCare HQ still holds it, CommCare HQ's file where it replaced it, and the
 * file each source's own map names elsewhere); and a base reading that is an account is
 * `base-needs-project-data` where it reads a table, a column or a level the
 * Project's data no longer has, or the Project's data it reads has a finding of
 * its own, and `base-unreadable` otherwise.
 *
 * Plausible failure: a reading that depends on the order CommCare HQ serves a
 * map's keys in while the stored baseline holds them sorted, so a save that
 * changed nothing reads as a change; Nova's own upload, which a baseline's map
 * lags, reading as a file a person replaced; a file CommCare HQ no longer
 * serves reading as one the base names; or a lookup table the Project no
 * longer holds, a column renamed since the publish or a level CommCare HQ
 * removed reading as Nova's defect.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type HqAppSource,
	type HqMediaType,
	parseHqAppSource,
} from "@/lib/commcare/hq/appSource";
import type { HqLocationType } from "@/lib/commcare/hq/locations";
import { LOCATION_LEVELS } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { levelsAsPublished } from "@/lib/commcare/reader/worldEntities";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { type BlueprintDoc, NEW_APP_SETTINGS } from "@/lib/domain";
import { count, eq, literal, term } from "@/lib/domain/expression";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { projectSearchOf } from "@/lib/domain/modules";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import type {
	LookupFixtureDataSnapshot,
	LookupRevision,
} from "@/lib/lookup/types";
import type { HqMediaPath, HqMediaStanding } from "../../hqMedia";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import {
	lookupCatalog,
	NOVA_DOMAIN,
	NOVA_ORIGIN,
	servedExport,
} from "../../reading/__tests__/novaReading";
import { provisionalReadingMediaId } from "../../reading/mediaIds";
import type { ReadingProjectData } from "../../reading/projectData";
import {
	type ReadingMediaPlan,
	readingMediaFindings,
} from "../../reading/projectData/media";
import { readBackDifferences } from "../../reading/readBack";
import { EMPTY_TARGET_IDENTITY } from "../../targetIdentity";
import { alignedFromSource } from "../baselineSource";
import {
	type HqChangeReadingsInput,
	makeHqChangeReadings,
	planChangeReadingMedia,
} from "../readings";

const APP_ID = "readings-app";
const TABLE = "018f0000-0000-7000-8000-0000000000a1" as LookupTableId;
const VALUE = "018f0000-0000-7000-8000-0000000000b1" as LookupColumnId;

/** A clinic whose registration saves three properties out of code-unit order. */
function clinic(options: { readonly readsTable?: boolean } = {}): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "Clinic",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "zeta", label: "Zeta" },
					{ name: "alpha", label: "Alpha" },
					{ name: "mid", label: "Mid" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...["zeta", "alpha", "mid"].map((property) =>
								f({
									kind: "text",
									id: property,
									label: property,
									caseWrite: { caseType: "patient", property },
								}),
							),
							...(options.readsTable === true
								? [
										f({
											kind: "single_select",
											id: "status",
											label: proseText("Status"),
											optionsSource: {
												kind: "lookup",
												tableId: TABLE,
												valueColumnId: VALUE,
												labelColumnId: VALUE,
											},
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
}

/** The Project's data of a reading that met no lookup table and read no place. */
function noProjectData(): ReadingProjectData {
	return {
		lookups: { table: () => undefined, definitions: new Map() },
		organization: { levelCodes: [], levels: [] },
		placesRead: false,
		placesUnread: null,
		gathered: {
			origin: { server: "india", domain: NOVA_DOMAIN },
			appId: APP_ID,
			readingId: "readings-reading",
			tablesReadAt: new Date("2026-11-01T00:00:00Z"),
			tables: [],
			project: {
				projectId: "project-1",
				projectRevision: "0" as LookupRevision,
				rowsByTable: {},
				apps: {},
				siblings: [],
				mayAdminister: true,
			},
			hqTags: [],
			hqLevels: [],
			hqPlaces: [],
		},
	};
}

/** The Project's table of statuses, its one column under `wireName`. */
function statuses(wireName: string): LookupFixtureDataSnapshot {
	return {
		projectId: "project-1",
		projectRevision: "1" as LookupRevision,
		definitions: [
			{
				id: TABLE,
				name: "Statuses",
				tag: "statuses",
				definitionRevision: "1" as LookupRevision,
				columns: [{ id: VALUE, wireName, label: "Value", dataType: "text" }],
			},
		],
		rowsByTable: new Map(),
	} as never;
}

/** The Project's data of a reading told `lookup`'s tables, each listed in CommCare HQ. */
function withTable(lookup: LookupFixtureDataSnapshot): ReadingProjectData {
	const data = noProjectData();
	return {
		...data,
		lookups: lookupCatalog(lookup),
		gathered: {
			...data.gathered,
			hqTags: lookup.definitions.map((table) => table.tag),
		},
	};
}

/** The Project's data of a reading told CommCare HQ's `levels`, with no place. */
function withLevels(levels: readonly HqLocationType[]): ReadingProjectData {
	const data = noProjectData();
	return {
		...data,
		organization: { levelCodes: levels.map((level) => level.code), levels },
		gathered: { ...data.gathered, hqLevels: levels },
	};
}

/** A clinic whose visit form counts the places at the level `clinic`. */
function placesReader(): BlueprintDoc {
	const clinicLevel = LOCATION_LEVELS[2];
	const doc = buildDoc({
		appId: APP_ID,
		appName: "Clinic",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								id: "clinics",
								calculate: count({
									kind: "locations",
									where: [
										eq(
											term({ kind: "location-field", field: "type" }),
											term({
												kind: "location-level",
												levelUuid: clinicLevel.uuid,
											}),
										),
									],
								}),
							}),
						],
					},
				],
			},
		],
	});
	doc.organizationLevels = Object.fromEntries(
		LOCATION_LEVELS.map((level) => [level.uuid, level]),
	);
	doc.organizationLevelOrder = LOCATION_LEVELS.map((level) => level.uuid);
	return doc;
}

function parsed(body: Record<string, unknown>): HqAppSource {
	const one = parseHqAppSource(body, { admit: "any" });
	if (one.kind !== "source") throw new Error("The body is no app source.");
	return one.source;
}

/** The value a baseline of `body` stores, parsed back as `readAppBaseline` parses it. */
function storedBaseline(body: Record<string, unknown>): unknown {
	const normalized = normalizeHqAppSource(body);
	if ("malformed" in normalized)
		throw new Error(`The body does not normalize: ${normalized.malformed}`);
	return JSON.parse(normalized.text);
}

function readingsOf(
	doc: BlueprintDoc,
	base: Record<string, unknown>,
	now: Record<string, unknown>,
	options: {
		readonly published?: readonly HqMediaPath[];
		readonly media?: HqChangeReadingsInput["media"];
		readonly data?: ReadingProjectData;
		readonly targetIdentity?: HqChangeReadingsInput["targetIdentity"];
	} = {},
) {
	const source = parsed(now);
	return makeHqChangeReadings({
		appId: doc.appId,
		target: { origin: NOVA_ORIGIN, domain: NOVA_DOMAIN },
		baselineSource: storedBaseline(base),
		now: { source, modules: alignedFromSource(source) },
		data: options.data ?? noProjectData(),
		reference: {
			kind: "ok",
			doc,
			identityDoc: doc,
			renamesSince: [],
			actors: [],
		},
		targetIdentity: options.targetIdentity ?? EMPTY_TARGET_IDENTITY,
		media: options.media ?? {
			published: options.published ?? [],
			base: null,
			now: null,
		},
	});
}

/** The properties the registration's own operation writes, in order. */
function writtenProperties(doc: BlueprintDoc): readonly string[] {
	const form = Object.values(doc.forms).find(
		(one) => one.type === "registration",
	);
	const own = form?.caseOperations?.find((one) => one.action === "own");
	return (own?.writes ?? []).map((write) => write.property);
}

describe("both readings of one app", () => {
	it("read a served app beside its stored baseline as one document, its writes out of code-unit order", () => {
		const doc = clinic();
		const { body } = servedExport(doc);
		const made = readingsOf(doc, body, body);
		if (made.kind !== "readings") throw new Error(`No base: ${made.reason}`);
		const { base, now } = made.readings;
		if (now.kind !== "read") throw new Error("The reading now is an account.");
		// The served map holds the writes in Nova's order, and the stored text in code-unit order.
		expect(writtenProperties(doc)).toEqual(["zeta", "alpha", "mid"]);
		expect(
			readBackDifferences(base.draft.doc, {
				doc: now.draft.doc,
				choices: null,
			}),
		).toEqual([]);
	});

	it.each([
		{
			label: "continues a shared search when both menus move",
			before: [17, 17],
			after: [22, 22],
			owners: ["first", "first"],
		},
		{
			label: "keeps the original search when its menus split",
			before: [17, 17],
			after: [17, 22],
			owners: ["first", "new"],
		},
		{
			label: "converges on the search already at the destination ID",
			before: [17, 35],
			after: [35, 35],
			owners: ["second", "second"],
		},
		{
			label: "gives two converging menus a new search at a new ID",
			before: [17, 35],
			after: [22, 22],
			owners: ["new", "new"],
		},
	])(
		"$label even when a contributor has chosen an unpublished ID",
		({ before, after, owners }) => {
			const first = testUuid("directory first");
			const second = testUuid("directory second");
			const menus = before.map((id, index) => ({
				name: `Visit ${index}`,
				caseType: "visit",
				forms: [
					{
						name: "Register",
						type: "registration" as const,
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
						],
					},
				],
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Visit" },
				]),
				caseSearchConfig: {
					projectSearch: {
						searchUuid: id === 17 ? first : second,
						defaults: [
							{
								uuid: testUuid(`region ${index}`),
								name: "region",
								value: term(literal("north")),
							},
						],
					},
				},
			}));
			const doc = buildDoc({
				appId: APP_ID,
				modules: menus,
				appSettings: {
					...NEW_APP_SETTINGS,
					projectSearches: {
						[first]: { name: "Outreach" },
						...(before.includes(35) && { [second]: { name: "Outreach" } }),
					},
				},
			});
			const issued = [
				{ searchUuid: first, endpointId: 17 },
				...(before.includes(35)
					? [{ searchUuid: second, endpointId: 35 }]
					: []),
			];
			const { body } = servedExport(doc, {
				identity: targetWireIdentity([], [], issued),
			});
			const now = structuredClone(body);
			const native = now.modules as {
				search_config: { case_search_endpoint_id: number };
			}[];
			native.forEach((module, index) => {
				module.search_config.case_search_endpoint_id = after[index];
			});
			const made = readingsOf(doc, body, now, {
				targetIdentity: {
					...EMPTY_TARGET_IDENTITY,
					projectSearches: issued.map((row) => ({
						...row,
						endpointId: row.endpointId + 100,
					})),
				},
			});
			if (made.kind !== "readings")
				throw new Error(`No baseline: ${made.reason}`);
			const changed = made.readings.now;
			if (changed.kind !== "read")
				throw new Error(JSON.stringify(changed.findings));
			const identities = changed.draft.doc.moduleOrder.map(
				(uuid) => projectSearchOf(changed.draft.doc.modules[uuid])?.searchUuid,
			);
			for (const [index, expected] of owners.entries()) {
				if (expected === "new") {
					expect(identities[index]).toBeDefined();
					expect([first, second]).not.toContain(identities[index]);
				} else
					expect(identities[index]).toBe(expected === "first" ? first : second);
			}
			expect(identities[0] === identities[1]).toBe(after[0] === after[1]);
			expect(changed.draft.identities.projectSearches).toEqual(
				expect.arrayContaining(
					after.map((endpointId, index) => ({
						searchUuid: identities[index],
						endpointId,
					})),
				),
			);
		},
	);

	it("share every input but the source, its menus and the media index", () => {
		const doc = clinic();
		const { body } = servedExport(doc);
		const made = readingsOf(doc, body, body);
		if (made.kind !== "readings") throw new Error(`No base: ${made.reason}`);
		const { base, now } = made.readings.inputs;
		const {
			source: _baseSource,
			modules: _baseModules,
			media: _baseMedia,
			...baseShared
		} = base;
		const {
			source: _nowSource,
			modules: _nowModules,
			media: _nowMedia,
			...nowShared
		} = now;
		expect(Object.keys(nowShared).sort()).toEqual(
			Object.keys(baseShared).sort(),
		);
		for (const key of Object.keys(baseShared) as (keyof typeof baseShared)[])
			expect(nowShared[key], key).toBe(baseShared[key]);
		// One resolver serves both, since a reading keeps what it claims to itself.
		expect(Object.keys(baseShared)).toContain("resolver");
		expect(base.knownCaseTypes).toBeDefined();
		expect(base.knownLanguageCodes).toBeDefined();
	});
});

// ── The media index of each side ─────────────────────────────────────

const ASSET = asMediaAssetId("018f0000-0000-7000-8000-0000000000d1");
const PATHS = {
	recorded: "commcare/image/recorded.png",
	absent: "commcare/image/absent.png",
	replaced: "commcare/image/replaced.png",
	other: "commcare/image/other.png",
	gone: "commcare/image/gone.png",
	none: "commcare/image/none.png",
} as const;
const JR = (path: string) => `jr://file/${path}`;

function published(
	wirePath: string,
	standing: HqMediaStanding,
	id: string | null,
): HqMediaPath {
	return {
		wirePath,
		assetId: ASSET,
		contentHash: "a".repeat(64),
		kind: "image",
		hq: id === null ? null : { mediaType: "CommCareImage", multimediaId: id },
		standing,
	};
}

/** A `multimedia_map` holding each `[path, id]` as an image. */
function mediaMap(
	entries: readonly (readonly [string, string])[],
): Record<string, unknown> {
	return Object.fromEntries(
		entries.map(([path, id]) => [
			JR(path),
			{ multimedia_id: id, media_type: "CommCareImage" },
		]),
	);
}

/** A plan of the files a source names, each `missing` where `missing` names it. */
function plan(missing: readonly string[]): ReadingMediaPlan {
	return {
		files: [],
		verdicts: Object.fromEntries(
			missing.map((id) => [`CommCareImage/${id}`, { kind: "missing" }]),
		),
		staged: new Map(),
		published: {},
	};
}

describe("each reading's media index", () => {
	const doc = clinic();
	const served = servedExport(doc).body;
	const base = {
		...served,
		multimedia_map: mediaMap([
			[PATHS.recorded, "rec-1"],
			[PATHS.replaced, "rep-1"],
			[PATHS.other, "oth-1"],
			[PATHS.gone, "gon-1"],
		]),
	};
	const now = {
		...served,
		multimedia_map: mediaMap([
			[PATHS.recorded, "rec-1"],
			[PATHS.replaced, "rep-2"],
			[PATHS.other, "oth-2"],
			[PATHS.gone, "gon-2"],
		]),
	};
	const made = readingsOf(doc, base, now, {
		media: {
			published: [
				published(PATHS.recorded, "recorded", "rec-1"),
				published(PATHS.absent, "absent", null),
				published(PATHS.replaced, "replaced", "rep-2"),
			],
			base: plan(["gon-1"]),
			now: plan([]),
		},
	});
	if (made.kind !== "readings") throw new Error(`No base: ${made.reason}`);
	const { inputs } = made.readings;
	const own = { kind: "asset", assetId: ASSET, mediaKind: "image" } as const;
	const hq = (id: string) =>
		({
			kind: "asset",
			assetId: provisionalReadingMediaId(
				doc.appId,
				"CommCareImage" as HqMediaType,
				id,
			),
			mediaKind: "image",
		}) as const;
	const rows: readonly {
		readonly path: string;
		readonly base: unknown;
		readonly now: unknown;
	}[] = [
		// A published path standing `recorded` or `absent`: Nova's own file on both sides.
		{ path: PATHS.recorded, base: own, now: own },
		{ path: PATHS.absent, base: own, now: own },
		// Standing `replaced`: Nova's file in the base, CommCare HQ's file there now.
		{ path: PATHS.replaced, base: own, now: hq("rep-2") },
		// Any other path with an entry: the file each source's own map names there.
		{ path: PATHS.other, base: hq("oth-1"), now: hq("oth-2") },
		// The base's file CommCare HQ no longer serves reads as no entry.
		{ path: PATHS.gone, base: { kind: "no-entry" }, now: hq("gon-2") },
		{ path: PATHS.none, base: { kind: "no-entry" }, now: { kind: "no-entry" } },
	];
	for (const row of rows)
		it(`answers ${row.path} by its standing`, () => {
			expect(inputs.base.media.resolve(JR(row.path))).toEqual(row.base);
			expect(inputs.now.media.resolve(JR(row.path))).toEqual(row.now);
		});
});

it("remembers which missing icon an earlier HQ reading already left out", () => {
	const doc = clinic();
	const { body } = servedExport(doc);
	const modules = structuredClone(body.modules) as Record<string, unknown>[];
	const menu = modules[0] as Record<string, unknown>;
	const form = (menu.forms as Record<string, unknown>[])[0] as Record<
		string,
		unknown
	>;
	menu.media_image = { en: JR(PATHS.gone) };
	form.media_image = { en: JR(PATHS.absent) };
	const source = {
		...body,
		modules,
		multimedia_map: mediaMap([[PATHS.gone, "gone-icon"]]),
	};
	// Both sources refer to the same missing HQ icon. The other path is a
	// published Nova asset, even though the baseline's media map omits it.
	const made = readingsOf(
		doc,
		source,
		{ ...source, name: "Clinic after an edit" },
		{
			media: {
				published: [published(PATHS.absent, "absent", null)],
				base: plan(["gone-icon"]),
				now: plan(["gone-icon"]),
			},
		},
	);
	if (made.kind !== "readings") throw new Error(`No base: ${made.reason}`);
	expect(made.readings.baseMediaClaims).toEqual([
		expect.objectContaining({
			brokenPicture: true,
			reference: expect.objectContaining({ path: JR(PATHS.gone) }),
		}),
	]);
});

it("keeps a published audio label in Android's content check for the neighboring missing icon", () => {
	const doc = clinic();
	const { body } = servedExport(doc);
	const modules = structuredClone(body.modules) as Record<string, unknown>[];
	const [form] = (modules[0] as Record<string, unknown>).forms as [
		Record<string, unknown>,
	];
	const audio = JR("commcare/audio/nova.mp3");
	const image = JR(PATHS.gone);
	form.media_image = { en: image };
	form.media_audio = { en: audio };
	const source = {
		...body,
		modules,
		profile: { properties: { "cc-content-valid": "no" } },
		multimedia_map: {
			...mediaMap([[PATHS.gone, "gone-icon"]]),
			[audio]: { media_type: "CommCareAudio", multimedia_id: "nova-audio" },
		},
	};
	const made = readingsOf(doc, source, source);
	if (made.kind !== "readings" || made.readings.now.kind !== "read")
		throw new Error("Both sources must admit a media reading.");
	const { media } = planChangeReadingMedia(
		made.readings.inputs.now.source,
		doc.appId,
		made.readings.now.draft,
		new Set([audio]),
		["android"],
	);
	expect(media.files.map((file) => file.paths)).toEqual([[image]]);
	const { claims, findings } = readingMediaFindings({
		media,
		plan: plan(["gone-icon"]),
		runsOn: ["android"],
	});
	expect(claims).toEqual([]);
	expect(findings.map((finding) => finding.code)).toEqual([
		"expressions-and-data/a-media-reference-with-no-file-on-a-slot-android-s-install",
	]);
});

// ── A base that is no base ───────────────────────────────────────────

describe("a base reading that is an account", () => {
	it("is base-needs-project-data where it reads a lookup table CommCare HQ no longer lists", () => {
		const doc = clinic({ readsTable: true });
		const { body } = servedExport(doc, {
			lookup: {
				projectId: "project-1",
				projectRevision: "1" as LookupRevision,
				definitions: [
					{
						id: TABLE,
						name: "Statuses",
						tag: "statuses",
						definitionRevision: "1" as LookupRevision,
						columns: [
							{
								id: VALUE,
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
						],
					},
				],
				rowsByTable: new Map(),
			} as never,
		});
		expect(readingsOf(doc, body, body)).toEqual({
			kind: "no-base",
			reason: "base-needs-project-data",
		});
	});

	it("is base-needs-project-data where it reads a column the Project's table no longer has", () => {
		// Nova published a select over the column `value`, then renamed it to `code`: CommCare HQ
		// still lists the table, and the base's choices read a column it lacks.
		const doc = clinic({ readsTable: true });
		const { body } = servedExport(doc, { lookup: statuses("value") });
		expect(
			readingsOf(doc, body, body, { data: withTable(statuses("value")) }).kind,
		).toBe("readings");
		expect(
			readingsOf(doc, body, body, { data: withTable(statuses("code")) }),
		).toEqual({ kind: "no-base", reason: "base-needs-project-data" });
	});

	it("is base-needs-project-data where it reads an organization level CommCare HQ no longer has", () => {
		const doc = placesReader();
		const { body } = servedExport(doc);
		const levels = levelsAsPublished(doc);
		expect(readingsOf(doc, body, body, { data: withLevels(levels) }).kind).toBe(
			"readings",
		);
		expect(
			readingsOf(doc, body, body, {
				data: withLevels(levels.filter((level) => level.code !== "clinic")),
			}),
		).toEqual({ kind: "no-base", reason: "base-needs-project-data" });
	});

	it("is base-unreadable where the Project's data it reads has no finding", () => {
		const doc = clinic();
		const { body } = servedExport(doc);
		const modules = structuredClone(body.modules) as Record<string, unknown>[];
		// A key no entry of the manifest names, at a value other than CommCare HQ's default.
		(modules[0] as Record<string, unknown>).nova_reading_unknown_key = 5;
		const base = { ...body, modules };
		expect(readingsOf(doc, base, body)).toEqual({
			kind: "no-base",
			reason: "base-unreadable",
		});
	});
});
