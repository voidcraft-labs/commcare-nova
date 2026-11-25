/**
 * The claims a reading settles outside its source's keys
 * (`gather.ts::settledClaims`): what it met through the application resource,
 * its own project space, the tables its document reads, the files it judged
 * and the media suite's resource HQ's build writes for each, a Connect app its
 * document holds, and what HQ's build of its document writes of its own (the
 * default app strings, the profile's checkoff, a form's meta block and a GPS
 * question's pollsensor), each recorded with no surface key but a held file's
 * class, which each of its map items holds at its `media_type`.
 *
 * It would catch a table counted that the document does not read or that Nova
 * cannot hold, a file counted before its verdict or with a verdict other than
 * held, a format filed under an entry that does not hold it, a path outside
 * `jr://file/` counted as a kept path, a Connect entry counted for an app that
 * is none, a build's meta block counted for a document with no form or a
 * pollsensor for one with no GPS question, a settled record that names a
 * surface key the source does not hold there, which the proof lane's parity
 * would read as a use the source does not hold, and a held file's class
 * recorded at the item rather than at its `media_type`, where the lane reads it.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqLookupTable } from "@/lib/commcare/hq/lookupTables";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import type { LookupRevision } from "@/lib/lookup/types";
import { canonicalLookupTable } from "../../hqResourceBaseline";
import { keptMediaClassClaims, settledClaims } from "../gather";
import {
	assembleReadingProjectData,
	type ReaderProjectDataReads,
} from "../projectData";
import type { HqLookupTableRead } from "../projectData/lookupTables";
import type { JudgedMediaFile, ReadingMediaPlan } from "../projectData/media";

const E = "expressions-and-data";
const A = "application-and-settings";
const Q = "questions";

/** One table of CommCare HQ's list, global, with one row. */
function tableRead(tag: string, id: string): HqLookupTableRead {
	const table: HqLookupTable = {
		id,
		tag,
		isGlobal: true,
		fields: ["code", "name"],
		fieldProperties: { code: [], name: [] },
		itemAttributes: [],
	};
	const rows = [{ id: `${id}-row`, fields: { code: "a", name: "Alpha" } }];
	return {
		kind: "read",
		table,
		rows,
		canonical: canonicalLookupTable(table, rows),
	};
}

/** One table shaped as the `hq-lookup-data` base's: a field with a property and two values a
 *  row, a row attribute, and a field one row holds, one holds no value of, one does not hold and
 *  one holds as the empty string. */
function richTableRead(
	tag: string,
	id: string,
	isGlobal = true,
): HqLookupTableRead {
	const table: HqLookupTable = {
		id,
		tag,
		isGlobal,
		fields: ["id", "name", "note"],
		fieldProperties: { id: [], name: ["lang"], note: [] },
		itemAttributes: ["code"],
	};
	const names = [
		{ value: "Maize", properties: { lang: "en" } },
		{ value: "Makka", properties: { lang: "hin" } },
	];
	const notes = [
		[{ value: "Grows fast", properties: {} }],
		[],
		undefined,
		[{ value: "", properties: {} }],
	];
	const rows = notes.map((note, index) => ({
		id: `${id}-row-${index}`,
		sortKey: index,
		itemAttributes: { code: `c-${index}` },
		fields: {
			id: [{ value: `crop-${index}`, properties: {} }],
			name: names,
			...(note === undefined ? {} : { note }),
		},
	}));
	return {
		kind: "read",
		table,
		rows,
		canonical: canonicalLookupTable(table, rows),
	};
}

/** The project data a reading gathers over `reads`, through the production assembly, with no
 *  Project table of any tag. */
function projectData(reads: readonly HqLookupTableRead[]) {
	return assembleReadingProjectData({
		origin: { server: "india", domain: "clinic" },
		appId: "0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6d",
		readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
		tablesReadAt: new Date("2026-11-10T09:00:00.000Z"),
		tables: reads,
		hqTags: reads.map((read) => read.table.tag),
		project: {
			projectId: "project-1",
			projectRevision: "7" as LookupRevision,
			definitions: [],
			rowsByTable: {},
			apps: {},
			keptColumns: {},
			siblings: [],
			mayAdminister: true,
		},
		measured: new Map(),
		places: null,
		placesUnread: null,
	});
}

const DATA = projectData([
	tableRead("villages", "a1"),
	tableRead("seasons", "b2"),
	/* A period in a tag is an XML name Nova holds: its tag settles the period entry. */
	tableRead("crop.types", "c3"),
]);

function judged(
	file: Pick<JudgedMediaFile, "mediaFormat" | "kind" | "mimeType">,
): JudgedMediaFile {
	return {
		...file,
		contentHash: "0".repeat(64),
		extension: ".bin",
		sizeBytes: 10,
		originalFilename: "file.bin",
	};
}

function planFile(
	key: string,
	kind: ReadingMediaPlan["files"][number]["kind"],
	paths: readonly string[],
): ReadingMediaPlan["files"][number] {
	return {
		key,
		mediaType: kind === "image" ? "CommCareImage" : "CommCareVideo",
		multimediaId: key,
		kind,
		paths,
		provisionalId: `provisional-${key}` as MediaAssetId,
	};
}

const MEDIA: ReadingMediaPlan = {
	files: [
		planFile("picture", "image", [
			"jr://file/commcare/image/a.png",
			"jr://file/commcare/image/b.png",
		]),
		planFile("film", "video", ["jr://file/commcare/video/c.mp4"]),
		planFile("gone", "image", ["jr://file/commcare/image/gone.png"]),
	],
	verdicts: {
		picture: {
			kind: "held",
			file: judged({
				mediaFormat: "png",
				kind: "image",
				mimeType: "image/png",
			}),
		},
		film: {
			kind: "held",
			file: judged({
				mediaFormat: "mp4-h264-main",
				kind: "video",
				mimeType: "video/mp4",
			}),
		},
		gone: { kind: "missing" },
	},
	staged: new Map(),
	published: {},
};

/** What the reader read of project data: the fields of each table its document reads, the tags
 *  it read that the catalog lacks, and no place. */
function readsOf(
	lookupFields: Readonly<Record<string, readonly string[]>>,
	unreadTables: readonly string[] = [],
): ReaderProjectDataReads {
	return { lookupFields, unreadTables, declaredTables: [], readsPlaces: false };
}

/** What every reading met: the application resource and its own project space. */
const ALWAYS = [
	{ artifact: "application", where: "/id", entry: `${A}/id` },
	{
		artifact: "application",
		where: "/version",
		entry: `${A}/rev-domain-copy-of-version`,
	},
	{
		artifact: "project-space",
		where: "",
		entry: `${A}/target-derived-profile-properties-posturl-posttesturl-ota`,
	},
];

/** What HQ's build of any document writes of its own. */
const BUILT = [
	{
		artifact: "build",
		where: "/app_strings",
		entry: `${A}/hq-default-app-strings`,
	},
	{
		artifact: "build",
		where: "/profile.ccpr",
		entry: `${A}/profile-feature-checkoff`,
	},
];

/** The media suite's resource HQ's build writes for a held file, at the file's first path. */
function mediaSuite(where: string) {
	return {
		artifact: "build",
		where,
		entry: `${E}/media-suite-xml-resource-shape`,
	};
}

/** A held file's class at one map item's `media_type`, under the format's entry. */
function mediaClass(where: string, mediaType: string, entry: string) {
	return {
		artifact: "app.json",
		where: `${where}/media_type`,
		entry,
		key: `media-class:${mediaType}`,
	};
}

function shown(records: ReturnType<typeof settledClaims>) {
	return records.map(({ artifact, where, entry, key }) =>
		key === null ? { artifact, where, entry } : { artifact, where, entry, key },
	);
}

describe("settledClaims", () => {
	it("settles only what every reading meets for an account, which holds no document and no judged file", () => {
		const records = settledClaims({
			data: DATA,
			reads: readsOf({}, ["villages"]),
			doc: null,
			media: null,
		});
		expect(shown(records)).toEqual(ALWAYS);
		expect(records.map((record) => record.standing)).toEqual([
			"kept",
			"kept",
			"kept",
		]);
	});

	it("settles each table the document reads that Nova holds, each held file by its format, kept path and class, and a Connect app", () => {
		const records = settledClaims({
			data: DATA,
			reads: readsOf({ villages: ["name"], "crop.types": ["name"] }),
			doc: buildDoc({}, (doc) => {
				doc.connectType = "learn";
			}),
			media: MEDIA,
		});
		expect(shown(records)).toEqual([
			...ALWAYS,
			{
				artifact: "lookup-tables",
				where: "/villages/tag",
				entry: `${E}/table-tag-in-nova-s-grammar`,
			},
			{
				artifact: "lookup-tables",
				where: "/villages/id",
				entry: `${E}/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table`,
			},
			{
				artifact: "lookup-tables",
				where: "/crop.types/tag",
				entry: `${E}/tag-or-field-name-holding-a-period`,
			},
			{
				artifact: "lookup-tables",
				where: "/crop.types/id",
				entry: `${E}/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table`,
			},
			{
				artifact: "app.json",
				where: "/multimedia_map/jr:~1~1file~1commcare~1image~1a.png",
				entry: `${E}/image-png-jpeg-gif-webp`,
			},
			mediaSuite("/multimedia_map/jr:~1~1file~1commcare~1image~1a.png"),
			{
				artifact: "app.json",
				where: "/multimedia_map/jr:~1~1file~1commcare~1image~1a.png",
				entry: `${E}/media-path-jr-file`,
			},
			mediaClass(
				"/multimedia_map/jr:~1~1file~1commcare~1image~1a.png",
				"CommCareImage",
				`${E}/image-png-jpeg-gif-webp`,
			),
			{
				artifact: "app.json",
				where: "/multimedia_map/jr:~1~1file~1commcare~1image~1b.png",
				entry: `${E}/media-path-jr-file`,
			},
			mediaClass(
				"/multimedia_map/jr:~1~1file~1commcare~1image~1b.png",
				"CommCareImage",
				`${E}/image-png-jpeg-gif-webp`,
			),
			{
				artifact: "app.json",
				where: "/multimedia_map/jr:~1~1file~1commcare~1video~1c.mp4",
				entry: `${E}/video-mp4-h-264-baseline-or-main-with-aac-lc-or-no-audio-webm`,
			},
			mediaSuite("/multimedia_map/jr:~1~1file~1commcare~1video~1c.mp4"),
			{
				artifact: "app.json",
				where: "/multimedia_map/jr:~1~1file~1commcare~1video~1c.mp4",
				entry: `${E}/media-path-jr-file`,
			},
			mediaClass(
				"/multimedia_map/jr:~1~1file~1commcare~1video~1c.mp4",
				"CommCareVideo",
				`${E}/video-mp4-h-264-baseline-or-main-with-aac-lc-or-no-audio-webm`,
			),
			{
				artifact: "app.json",
				where: "",
				entry: `${A}/connect-app-opened-in-the-connect-app`,
			},
			...BUILT,
		]);
	});

	it("settles a rich table's field values, row attributes and absent cells where HQ's definition holds them, and none of a table HQ keeps per owner", () => {
		const records = settledClaims({
			data: projectData([
				richTableRead("crops", "d4"),
				richTableRead("plots", "e5", false),
			]),
			reads: readsOf({ crops: ["name"], plots: ["name"] }),
			doc: null,
			media: null,
		});
		const tables = records.filter(
			(record) => record.artifact === "lookup-tables",
		);
		expect(
			tables.map(({ where, entry, standing }) => ({ where, entry, standing })),
		).toEqual([
			{
				where: "/crops/tag",
				entry: `${E}/table-tag-in-nova-s-grammar`,
				standing: "held",
			},
			{
				where: "/crops/fields/1/properties",
				entry: `${E}/fields-properties-and-multi-valued-cells-name-lang-en-name-name`,
				standing: "held",
			},
			{
				where: "/crops/fields/2",
				entry: `${E}/absent-field-vs-zero-values-vs-empty-string`,
				standing: "held",
			},
			{
				where: "/crops/item_attributes",
				entry: `${E}/item-attributes-and-per-row-attribute-values`,
				standing: "held",
			},
			{
				where: "/crops/id",
				entry: `${E}/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table`,
				standing: "kept",
			},
			{
				where: "/plots/tag",
				entry: `${E}/table-tag-in-nova-s-grammar`,
				standing: "held",
			},
			{
				where: "/plots/id",
				entry: `${E}/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table`,
				standing: "kept",
			},
		]);
	});

	it("settles a held file past its kind's upload cap at its first path, and none at the cap", () => {
		const at = "/multimedia_map/jr:~1~1file~1commcare~1image~1large.png";
		for (const sizeBytes of [5 * 1024 * 1024, 5 * 1024 * 1024 + 1]) {
			const records = settledClaims({
				data: DATA,
				reads: readsOf({}),
				doc: null,
				media: {
					files: [
						planFile("large", "image", ["jr://file/commcare/image/large.png"]),
					],
					verdicts: {
						large: {
							kind: "held",
							file: {
								...judged({
									mediaFormat: "png",
									kind: "image",
									mimeType: "image/png",
								}),
								sizeBytes,
							},
						},
					},
					staged: new Map(),
					published: {},
				},
			});
			const large = records.filter(
				(record) =>
					record.entry ===
					`${E}/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
			);
			expect(large).toEqual(
				sizeBytes > 5 * 1024 * 1024
					? [
							{
								artifact: "app.json",
								where: at,
								key: null,
								entry: `${E}/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
								standing: "held",
							},
						]
					: [],
			);
		}
	});

	it("settles no file before its verdict, no path outside jr://file/, and no Connect entry for an app that is none", () => {
		const records = settledClaims({
			data: DATA,
			reads: readsOf({}),
			doc: buildDoc({}),
			media: {
				...MEDIA,
				files: [planFile("picture", "image", ["commcare/image/a.png"])],
			},
		});
		expect(shown(records)).toEqual([
			...ALWAYS,
			{
				artifact: "app.json",
				where: "/multimedia_map/commcare~1image~1a.png",
				entry: `${E}/image-png-jpeg-gif-webp`,
			},
			mediaSuite("/multimedia_map/commcare~1image~1a.png"),
			mediaClass(
				"/multimedia_map/commcare~1image~1a.png",
				"CommCareImage",
				`${E}/image-png-jpeg-gif-webp`,
			),
			...BUILT,
		]);
		expect(
			shown(
				settledClaims({
					data: DATA,
					reads: readsOf({}),
					doc: null,
					media: { ...MEDIA, verdicts: {} },
				}),
			),
		).toEqual(ALWAYS);
	});

	it("settles a form's meta block where the document holds a form, and a pollsensor where a form binds a GPS question", () => {
		const form = (fields: ReturnType<typeof f>[]) =>
			buildDoc({
				modules: [
					{
						name: "Visits",
						forms: [{ name: "Visit", type: "survey", fields }],
					},
				],
			});
		const meta = {
			artifact: "build",
			where: "/meta",
			entry: `${Q}/hq-generated-meta-deviceid-timestart-timeend-username-userid`,
		};
		const settle = (doc: ReturnType<typeof buildDoc>) =>
			shown(
				settledClaims({ data: DATA, reads: readsOf({}), doc, media: null }),
			);
		expect(settle(form([f({ kind: "text", id: "note" })]))).toEqual([
			...ALWAYS,
			...BUILT,
			meta,
		]);
		expect(settle(form([f({ kind: "geopoint", id: "where" })]))).toEqual([
			...ALWAYS,
			...BUILT,
			meta,
			{
				artifact: "build",
				where: "/pollsensor",
				entry: `${Q}/hq-generated-pollsensor`,
			},
		]);
	});

	it("settles the query HQ's build adds to a menu whose forms read its search under a parent selection", () => {
		const doc = buildDoc(
			{
				modules: [
					{ name: "Households", caseType: "household", uuid: "households" },
					{ name: "Members", caseType: "member", uuid: "members" },
				],
			},
			(draft) => {
				const [households, members] = draft.moduleOrder;
				const child =
					members === undefined ? undefined : draft.modules[members];
				if (child === undefined || households === undefined)
					throw new Error("The document holds both menus.");
				child.parentCaseModuleUuid = households;
				child.caseSearchConfig = { formsReadSearch: true };
			},
		);
		const records = shown(
			settledClaims({ data: DATA, reads: readsOf({}), doc, media: null }),
		);
		expect(
			records.filter(
				(one) =>
					one.entry ===
					"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query",
			),
		).toEqual([
			{
				artifact: "build",
				where: `/menus/${doc.moduleOrder[1]}/search`,
				entry:
					"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query",
			},
		]);
	});

	it("records the class of each map item no held file holds under the entry that keeps the map, and none it does not name", () => {
		const records = keptMediaClassClaims(
			[
				/* A held file's path: its class stands under its format's entry. */
				{
					path: "jr://file/commcare/image/a.png",
					multimediaId: "picture",
					mediaType: "CommCareImage",
					unreadable: false,
				},
				/* A file no slot references, and one judged missing. */
				{
					path: "jr://file/commcare/audio/unused.mp3",
					multimediaId: "sound",
					mediaType: "CommCareAudio",
					unreadable: false,
				},
				{
					path: "jr://file/commcare/image/gone.png",
					multimediaId: "gone",
					mediaType: "CommCareImage",
					unreadable: false,
				},
				/* A class the map's entry does not name, and an item Nova cannot read. */
				{
					path: "jr://file/commcare/text/print.html",
					multimediaId: "print",
					mediaType: "CommCareMultimedia",
					unreadable: false,
				},
				{
					path: "jr://file/commcare/image/odd.png",
					multimediaId: null,
					mediaType: null,
					unreadable: true,
				},
			],
			MEDIA,
		);
		expect(shown(records)).toEqual([
			mediaClass(
				"/multimedia_map/jr:~1~1file~1commcare~1audio~1unused.mp3",
				"CommCareAudio",
				`${A}/multimedia-map`,
			),
			mediaClass(
				"/multimedia_map/jr:~1~1file~1commcare~1image~1gone.png",
				"CommCareImage",
				`${A}/multimedia-map`,
			),
		]);
		expect(records.map((record) => record.standing)).toEqual(["kept", "kept"]);
	});
});
