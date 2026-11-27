/**
 * Contract: each column format CommCare HQ's page offers reads or raises as its manifest row
 * says, and a finding names the format by the label HQ's page shows. The failure it catches: a
 * format Nova cannot write back read as held. Each case edits Nova's emission at the keys HQ's
 * Case List page (`static/app_manager/js/details/bootstrap5/column.js`) writes.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	calculatedColumn,
	columnFieldText,
	plainColumn,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { assembleDocument } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readProjectionInputs } from "../../projectionInputs";
import { patients, uuid } from "./fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	comparableList,
	type Detail,
	listOf,
	readLists as readListsOf,
} from "./listReading";

const M = "menus-and-case-lists/";
const CASE_TEXT_KEY = "case_text_00000000000040008000000000000003";

const readLists = namingFromHqPages(readListsOf);

const twoColumns = () =>
	patients([
		plainColumn(uuid(1), "case_name", "Name"),
		plainColumn(uuid(2), "notes", "Notes"),
	]);

/** Reads the list after `edit` changed its two stored details. */
async function readDetails(
	edit: (short: Detail, long: Detail, app: AppJson) => void,
	firstPassOnly = true,
) {
	return readLists(twoColumns(), {
		edit: (app) => {
			const pair = app.modules[0]?.case_details;
			if (pair !== undefined) edit(pair.short, pair.long, app);
		},
		firstPassOnly,
	});
}

/** Reads the list after the second column of `screens` took `change`. */
async function readFormat(
	change: Record<string, unknown>,
	screens: readonly ("short" | "long")[] = ["short", "long"],
) {
	return readDetails((short, long) => {
		for (const screen of screens) {
			const column = (screen === "short" ? short : long).columns[1];
			if (column !== undefined) Object.assign(column, change);
		}
	});
}

/** A copy of the second column of `detail` with `change`, appended. */
function addColumn(detail: Detail, change: Record<string, unknown>): void {
	const second = detail.columns[1];
	if (second !== undefined) detail.columns.push({ ...second, ...change });
}

describe("CommCare HQ's column formats", () => {
	it.each([
		["#owner_name", "owner_id", undefined, "name", "#owner_name"],
		["user/district", "district", "worker-record", undefined, "user/district"],
		[
			"user/parent/district",
			"district",
			"worker-record",
			undefined,
			"user/district",
		],
		[
			"user/manager/#owner_name",
			"owner_id",
			"worker-record",
			"name",
			"user/#owner_name",
		],
	] as const)(
		"reads the worker or owner field %s",
		async (source, property, worker, owner, output) => {
			const reading = await readDetails((short, long) => {
				for (const detail of [short, long])
					Object.assign(detail.columns[1] ?? {}, { field: source });
			}, false);
			expect(closedCodes(reading)).toEqual([]);
			const column = listOf(reading).columns.find(
				(one) => one.header === "Notes",
			);
			expect(column).toBeDefined();
			if (!column || column.kind === "calculated")
				throw new Error("Expected a property column");
			expect(column.field).toBe(property);
			expect(column.readFrom).toBe(worker);
			expect(column.showOwner).toBe(owner);
			expect(columnFieldText(column)).toBe(output);
		},
	);

	it("binds translated calculation pieces while preserving HQ's changes to quoted text", async () => {
		const read = await readDetails((short, long) => {
			for (const detail of [short, long])
				Object.assign(detail.columns[1], {
					field: "concat($greeting, ' greeting ', notes)",
					useXpathExpression: true,
					format: "translatable-enum",
					enum: [{ key: "greeting", value: { en: "Hello" } }],
				});
		}, false);
		expect(
			closedCodes(read),
			JSON.stringify(read.ctx.close().findings),
		).toEqual([]);
		const column = listOf(read).columns[1];
		if (column.kind !== "calculated")
			throw new Error("Missing translated calculation");
		expect(column.texts).toEqual([
			{ uuid: expect.any(String), label: "Hello" },
		]);
		expect(column.expression).toMatchObject({
			kind: "concat",
			parts: [
				{ kind: "case-text", textUuid: column.texts?.[0].uuid },
				{ kind: "term", term: { kind: "literal", value: " kgreeting " } },
				{ kind: "term", term: { kind: "prop", property: "notes" } },
			],
		});
		const doc = read.ctx.doc;
		if (!doc) throw new Error("Missing bound document");
		const reread = await readLists(doc, {
			identity: readProjectionInputs(read.ctx).identity,
			input: (input) => ({
				...input,
				resolver: matchingResolver(input.appId, read.ctx.identities.entries()),
			}),
		});
		expect(
			closedCodes(reread),
			JSON.stringify(reread.ctx.close().findings),
		).toEqual([]);
		expect(listOf(reread).columns[1]).toMatchObject({
			uuid: column.uuid,
			expression: column.expression,
			texts: column.texts,
		});
	});
	it.each([
		["", "v"],
		["v".repeat(256), "v00000002_"],
		[`v${CASE_TEXT_KEY} v00000002_`, "v00000003_"],
	])(
		"keeps an authored literal containing a translated piece's wire name (%s)",
		async (prefix, available) => {
			const word = { uuid: uuid(3), label: "Village" };
			const literal = `${prefix}${CASE_TEXT_KEY}`;
			const column = {
				...calculatedColumn(uuid(2), "Visit", {
					kind: "concat",
					parts: [
						{ kind: "case-text", textUuid: word.uuid },
						{ kind: "term", term: { kind: "literal", value: literal } },
					],
				}),
				texts: [word],
			};
			const read = await readLists(patients([column]));
			expect(
				closedCodes(read),
				JSON.stringify(read.ctx.close().findings),
			).toEqual([]);
			const stored = read.app.modules[0].case_details.short.columns[0];
			expect(stored.enum).toMatchObject([
				{ key: `${available}${CASE_TEXT_KEY}` },
			]);
			expect(listOf(read).columns[0]).toMatchObject({
				kind: "calculated",
				expression: {
					kind: "concat",
					parts: [
						{ kind: "case-text" },
						{ kind: "term", term: { kind: "literal", value: literal } },
					],
				},
			});
		},
	);
	it("normalizes a non-calculated translated value without losing its unused wording", async () => {
		const read = await readFormat({
			format: "translatable-enum",
			field: "notes",
			enum: [{ key: "greeting", value: { en: "Hello" } }],
		});
		expect(closedCodes(read)).toEqual([]);
		expect(listOf(read).columns[1]).toMatchObject({
			kind: "calculated",
			texts: [{ label: "Hello" }],
		});
	});
	it.each([
		[
			"parent/village",
			{
				kind: "prop",
				caseType: "patient",
				property: "village",
				via: { kind: "ancestor", via: [{ identifier: "parent" }] },
				readReached: true,
			},
		],
		[
			"host/parent/village",
			{
				kind: "prop",
				caseType: "patient",
				property: "village",
				via: {
					kind: "ancestor",
					via: [{ identifier: "host" }, { identifier: "parent" }],
				},
				readReached: true,
			},
		],
	] as const)(
		"holds translated text over %s as a calculation over HQ's own read",
		async (field, read) => {
			// HQ's build walks each index to whatever case it reaches, of any type, or reads the
			// worker's record (`PropertyXpathGenerator`); the app declares no parent type here, so
			// only the reached read is that walk.
			const reading = await readDetails((short, long) => {
				for (const detail of [short, long])
					Object.assign(detail.columns[1], {
						format: "translatable-enum",
						field,
						useXpathExpression: false,
						enum: [{ key: "north", value: { en: "North" } }],
					});
			}, false);
			expect(
				closedCodes(reading),
				JSON.stringify(reading.ctx.close().findings),
			).toEqual([]);
			const column = listOf(reading).columns[1];
			if (column.kind !== "calculated")
				throw new Error("Expected the translated text as a calculation");
			expect(column.texts).toEqual([
				{ uuid: expect.any(String), label: "North" },
			]);
			const reads: unknown[] = [];
			walkExpressionTerms(column.expression, (term) => {
				if (term.kind === "prop" || term.kind === "session-user")
					reads.push(term);
			});
			expect(reads).toEqual([read]);
			// Nova's own emission of the calculation reads back to the same column.
			const doc = reading.ctx.doc;
			if (!doc) throw new Error("Missing bound document");
			const reread = await readLists(doc, {
				identity: readProjectionInputs(reading.ctx).identity,
				input: (input) => ({
					...input,
					resolver: matchingResolver(
						input.appId,
						reading.ctx.identities.entries(),
					),
				}),
			});
			expect(
				closedCodes(reread),
				JSON.stringify(reread.ctx.close().findings),
			).toEqual([]);
			expect(listOf(reread).columns[1]).toMatchObject({
				uuid: column.uuid,
				expression: column.expression,
				texts: column.texts,
			});
		},
	);
	it.each([
		["a menu that offers Search", true],
		["a menu with no Search", false],
	] as const)(
		"reads a calculated column over HQ's untyped walk in %s",
		async (_label, search) => {
			// Search supplies no case an untyped walk reaches, so a searching
			// menu's gate refuses the reached read
			// (`searchRelatedCalculationCompatibility`): the reading leaves the
			// column to a finding rather than hold a read the gate refuses.
			const doc = patients(
				[
					plainColumn(uuid(1), "case_name", "Name"),
					calculatedColumn(uuid(2), "Village", {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: "notes" },
					}),
				],
				search ? { search: {} } : {},
			);
			const reading = await readLists(doc, {
				edit: (app) => {
					const pair = app.modules[0]?.case_details;
					for (const detail of [pair?.short, pair?.long])
						Object.assign(detail?.columns[1] ?? {}, {
							field:
								"instance('casedb')/casedb/case[@case_id=current()/index/host]/village",
						});
				},
			});
			const column = listOf(reading).columns.find(
				(one) => one.uuid === uuid(2) || one.header === "Village",
			);
			const reads: unknown[] = [];
			if (column?.kind === "calculated")
				walkExpressionTerms(column.expression, (term) => {
					if (term.kind === "prop") reads.push(term);
				});
			const reached = {
				kind: "prop",
				caseType: "patient",
				property: "village",
				via: { kind: "ancestor", via: [{ identifier: "host" }] },
				readReached: true,
			};
			if (search) {
				// One finding a detail, under the calculation's own row.
				expect(closedCodes(reading)).toEqual([
					"menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression",
					"menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression",
				]);
				expect(reads).toEqual([]);
			} else {
				expect(closedCodes(reading)).toEqual([]);
				expect(reads).toEqual([reached]);
			}
		},
	);
	async function readTranslatedProperty(field: string) {
		return readDetails((short, long) => {
			for (const detail of [short, long])
				Object.assign(detail.columns[1], {
					format: "translatable-enum",
					field,
					useXpathExpression: false,
					enum: [{ key: "north", value: { en: "North" } }],
				});
		}, false);
	}
	it("binds translated text over a worker record to the worker property", async () => {
		const reading = await readTranslatedProperty("user/district");
		expect(closedCodes(reading)).toEqual([]);
		const column = listOf(reading).columns.find(
			(one) => one.header === "Notes",
		);
		if (column?.kind !== "calculated")
			throw new Error("Missing worker calculation.");
		const terms: unknown[] = [];
		walkExpressionTerms(column.expression, (term) => {
			if (term.kind === "session-user" || term.kind === "session-user-property")
				terms.push(term);
		});
		const district = reading.ctx.draft.userProperties.find(
			(property) => property.slug === "district",
		);
		expect(district).toBeDefined();
		expect(terms).toEqual([
			{
				kind: "session-user-property",
				userPropertyUuid: district?.uuid,
				source: "worker-record",
			},
		]);
		expect(column.texts?.map(({ label }) => label)).toEqual(["North"]);
	});
	it("refuses the parent owner-name calculation at each detail as an unsupported value expression", async () => {
		const reading = await readTranslatedProperty("parent/#owner_name");
		expect(closedCodes(reading)).toEqual([
			`${M}usexpathexpression-field-xpath-outside-valueexpression`,
			`${M}usexpathexpression-field-xpath-outside-valueexpression`,
		]);
	});
	it("keeps a distance order on a translated saved property bound to the real row", async () => {
		const read = await readDetails((short, long) => {
			for (const detail of [short, long])
				Object.assign(detail.columns[1], {
					format: "translatable-enum",
					field: "notes",
					useXpathExpression: false,
					enum: [{ key: "visit", value: { en: "Visit" } }],
				});
			short.sort_elements = [
				{
					field: "notes",
					type: "distance",
					direction: "ascending",
					blanks: "first",
					display: { en: "" },
					sort_calculation: "",
					doc_type: "SortElement",
				},
			];
		}, false);
		expect(
			closedCodes(read),
			JSON.stringify(read.ctx.close().findings),
		).toEqual([]);
		expect(listOf(read).columns[1]).toMatchObject({
			kind: "calculated",
			sort: { comparator: "distance" },
			texts: [{ label: "Visit" }],
		});
	});
	it.each(["conditional-enum", "enum-image"])(
		"retains each ordered %s rule when distinct keys have the same effective condition",
		async (format) => {
			const keys = [". = 'urgent'", "urgent", "(notes = 'urgent')"];
			const read = await readDetails((short, long) => {
				for (const detail of [short, long])
					Object.assign(detail.columns[1], {
						format,
						field: "notes",
						enum: keys.map((key, index) =>
							format === "conditional-enum"
								? { key, value: { en: `Label ${index}` } }
								: {
										key,
										value: { en: "" },
										alt_text: { en: `Image ${index}` },
									},
						),
					});
			}, false);
			expect(
				closedCodes(read),
				JSON.stringify(read.ctx.close().findings),
			).toEqual([]);
			const column = listOf(read).columns[1];
			if (column.kind !== "image-map" && column.kind !== "id-mapping")
				throw new Error("Missing case rules");
			expect(column.mapping).toHaveLength(3);
			expect(new Set(column.mapping.map((entry) => entry.uuid)).size).toBe(3);
			expect(
				column.mapping.map((entry) => (entry.when ? "condition" : entry.value)),
			).toEqual(["condition", "urgent", "condition"]);
			expect(column.mapping[0].when).toEqual(column.mapping[2].when);
		},
	);
	it("binds an ordered native condition to the displayed case property on both screens", async () => {
		const read = await readDetails((short, long) => {
			for (const detail of [short, long])
				Object.assign(detail.columns[1], {
					field: "risk_score",
					format: "conditional-enum",
					enum: [
						{ key: ". > 3", value: { en: "Many" } },
						{ key: "true()", value: { en: "Other" } },
					],
				});
		}, false);
		expect(
			closedCodes(read),
			JSON.stringify(read.ctx.close().findings),
		).toEqual([]);
		expect(listOf(read).columns[1]).toMatchObject({
			kind: "id-mapping",
			behavior: "first-match",
			mapping: [
				{ uuid: expect.any(String), when: expect.any(Object), label: "Many" },
				{
					uuid: expect.any(String),
					when: { kind: "match-all" },
					label: "Other",
				},
			],
		});
	});
	it.each([
		["address", "map-location"],
		["distance", "worker-distance"],
	])("keeps a native %s cell on both screens", async (format, kind) => {
		const read = await readFormat({ format });
		expect(
			closedCodes(read),
			JSON.stringify(read.ctx.close().findings),
		).toEqual([]);
		expect(listOf(read).columns[1]).toMatchObject({ kind, field: "notes" });
	});
	it("keeps blank and multiword mapping keys and their individual labels on both screens", async () => {
		const mapping = [
			{ key: "", value: { en: "Unspecified" } },
			{ key: "east bank", value: { en: "East Bank" } },
		];
		const read = await readFormat({ format: "enum", enum: mapping });
		expect(closedCodes(read)).toEqual([]);
		expect(listOf(read).columns[1]).toMatchObject({
			kind: "id-mapping",
			mapping: [
				{ value: "", label: "Unspecified" },
				{ value: "east bank", label: "East Bank" },
			],
		});
	});
	it.each([
		[365.25, "years-since"],
		[365.25 / 12, "months-since"],
		[7, "weeks-since"],
		[1, "days-since"],
		[-1, "days-until"],
		[-7, "weeks-until"],
		[-365.25 / 12, "months-until"],
	])(
		"reads the editor's relative date interval %s as %s",
		async (interval, period) => {
			const read = await readDetails((short, long) => {
				for (const screen of [short, long])
					Object.assign(screen.columns[1] ?? {}, {
						field: "dob",
						format: "time-ago",
						time_ago_interval: interval,
					});
			}, false);
			expect(closedCodes(read)).toEqual([]);
			expect(listOf(read).columns[1]).toMatchObject({
				kind: "date-count",
				field: "dob",
				period,
			});
		},
	);
	it.each([
		[false, "notes", "formatted-text"],
		[true, "concat(notes, '!')", "calculated"],
	] as const)(
		"publishes a formatted case cell with calculated=%s back to both screens",
		async (calculated, field, kind) => {
			const read = await readDetails((short, long) => {
				for (const screen of [short, long])
					Object.assign(screen.columns[1] ?? {}, {
						field,
						format: "markdown",
						useXpathExpression: calculated,
					});
			}, false);
			expect(closedCodes(read)).toEqual([]);
			expect(listOf(read).columns[1]).toMatchObject(
				calculated ? { kind, showAs: "formatted-text" } : { kind, field },
			);
		},
	);
	const findings: [string, Record<string, unknown>, string][] = [
		[
			"time-ago over another interval",
			{ format: "time-ago", time_ago_interval: 3 },
			`${M}3p-time-ago-other-interval`,
		],
		["picture", { format: "picture" }, `${M}17-picture`],
		["audio", { format: "audio" }, `${M}18-audio`],
		["graph", { format: "graph" }, `${M}22-graph`],
		["image", { format: "image" }, `${M}23-image-cc-case-image`],
		["address-popup", { format: "address-popup" }, `${M}15-address-popup`],

		[
			"a date pattern Core does not format",
			{ format: "date", date_format: "%Q" },
			`${M}2p-date-any-other-date-format`,
		],
		[
			"an enum key holding &",
			{ format: "enum", enum: [{ key: "a&b", value: { en: "A" } }] },
			`${M}5p-enum-key-containing`,
		],
		[
			"an enum key holding <",
			{ format: "enum", enum: [{ key: "a<b", value: { en: "A" } }] },
			`${M}5p-enum-key-containing`,
		],
		[
			"two enum entries of one key",
			{
				format: "enum",
				enum: [
					{ key: "a", value: { en: "A" } },
					{ key: "a", value: { en: "B" } },
				],
			},
			`${M}an-enum-enum-image-conditional-enum-or-translatable-enum-column`,
		],
		[
			"a translatable-enum key outside the editor's grammar",
			{
				format: "translatable-enum",
				enum: [{ key: "a.b", value: { en: "A" } }],
			},
			`${M}21p-translatable-enum-key-outside-a-za-z0-9`,
		],
		["a product column", { model: "product" }, `${M}model-product`],
		[
			"a related case ID read as a missing child element",
			{ field: "parent/case_id" },
			`${M}case-id-as-a-property-column-s-field`,
		],
	];
	for (const [name, change, entry] of findings)
		it(`raises ${name}`, async () => {
			const reading = await readFormat(change);
			expect(codes(reading)).toContain(entry);
		});

	// The variant `hq-case-lists/conditional-id-mapping-unparsed-key` exhibits it.
	it("refuses a display rule whose condition is no expression", async () => {
		const read = await readDetails((short, long) => {
			for (const detail of [short, long])
				Object.assign(detail.columns[1] ?? {}, {
					format: "conditional-enum",
					enum: [{ key: ". > (", value: { en: "Many" } }],
				});
		}, false);
		expect(closedCodes(read)).toContain(
			`${M}mapping-condition-outside-predicate`,
		);
	});

	it.each([
		[101, "detail-max-select-value-101-outside-flat-close"],
		[2_147_483_647, "detail-max-select-value-above-100"],
		[2_147_483_648, "detail-max-select-value-above-2147483647"],
	] as const)(
		"distinguishes the Nova limit from Core's integer limit at %s",
		async (maximum, entry) => {
			const read = await readDetails((short) => {
				Object.assign(short, { multi_select: true, max_select_value: maximum });
			}, false);
			assembleDocument(read.ctx);
			expect(closedCodes(read)).toContain(`${M}${entry}`);
		},
	);

	it.each([false, true])(
		"keeps the bounded flat close maximum with auto-select %s",
		async (autoSelect) => {
			const name = plainColumn(uuid(1), "case_name", "Name");
			const doc = buildDoc({
				appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
				caseTypes: [{ name: "patient", properties: [] }],
				modules: [
					{
						name: "Cases",
						caseType: "patient",
						caseListConfig: {
							columns: [name],
							listColumnOrder: [name.uuid],
							detailColumnOrder: [name.uuid],
							searchInputs: [],
							selection: {
								kind: "multiple",
								maximum: 101,
								...(autoSelect && { autoSelect: true }),
							},
						},
						forms: [
							{
								name: "Close selected cases",
								type: "close",
								postSubmit: "app_home",
								fields: [f({ kind: "hidden", id: "done", calculate: "'yes'" })],
							},
						],
					},
				],
			});
			const reading = await readLists(doc, {
				input: (input) => ({
					...input,
					source: { ...input.source, cloudcareEnabled: true },
				}),
			});
			assembleDocument(reading.ctx);
			expect(reading.ctx.close().findings).toEqual([]);
			expect(reading.ctx.assembled).toBeDefined();
			expect(reading.app.modules[0]?.case_details.short.max_select_value).toBe(
				101,
			);
			expect(listOf(reading).selection).toEqual({
				kind: "multiple",
				maximum: 101,
				...(autoSelect && { autoSelect: true }),
			});
		},
	);

	// HQ's build writes no `max-select-value` for a null, and Core then takes 100
	// (`SessionDatumParser.DEFAULT_MAX_SELECT_VAL`); a text HQ's model refuses as it wraps the app.
	it("reads a null maximum of a multi-select list as 100, and a text maximum as no entry's", async () => {
		const zero = `${M}detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic`;
		const unnamed = "unrecognized:schema:Detail.max_select_value";
		const read = (max: unknown) =>
			readDetails((short) => {
				Object.assign(short, { multi_select: true, max_select_value: max });
			});
		const held = closedCodes(await read(null));
		expect(held).not.toContain(zero);
		expect(held).not.toContain(unnamed);
		const text = closedCodes(await read("150"));
		expect(text).not.toContain(zero);
		expect(text).toContain(unnamed);
	});

	// A translatable-enum column refused for its keys still claims its field and its format: the
	// field outside Nova's grammar is a finding of its own, and nothing is left for the close.
	it("claims the field and format of a translatable-enum column refused for its keys", async () => {
		for (const field of ["notes", "#x"]) {
			const reading = await readFormat(
				{
					format: "translatable-enum",
					field,
					enum: [{ key: "a.b", value: { en: "A" } }],
				},
				["short"],
			);
			const closed = closedCodes(reading);
			expect(closed).toContain(
				`${M}21p-translatable-enum-key-outside-a-za-z0-9`,
			);
			expect(closed.filter((code) => code.startsWith("unrecognized:"))).toEqual(
				[],
			);
		}
	});

	it("shows a choice’s saved value while keeping the catalog its registration form writes", async () => {
		const doc = buildDoc({
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
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "single_select",
									id: "risk",
									caseWrite: { caseType: "patient", property: "risk" },
									optionsSource: {
										kind: "inline",
										options: [
											{
												value: "low",
												label: proseText("Low"),
												uuid: testUuid("o-low"),
											},
										],
									},
								}),
							],
						},
					],
					caseListConfig: {
						columns: [plainColumn(uuid(1), "case_name", "Name")],
						searchInputs: [],
					},
				},
			],
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				const pair = app.modules[0]?.case_details;
				for (const detail of [pair?.short, pair?.long]) {
					const column = detail?.columns[0];
					if (column !== undefined)
						detail?.columns.push({ ...column, field: "risk" });
				}
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(
			listOf(reading).columns.map((column) =>
				column.kind === "plain" ? column.field : column.kind,
			),
		).toEqual(["case_name", "risk"]);
		const risk = reading.ctx.doc?.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((property) => property.name === "risk");
		expect(risk?.data_type).toBe("single_select");
		expect(risk?.options).toEqual([{ value: "low", label: proseText("Low") }]);
		expect(listOf(reading).columns[1]).toMatchObject({
			kind: "plain",
			showChoice: "saved-value",
		});
	});

	it.each([30, 0, -3])(
		"preserves the overdue marker threshold %s through both details",
		async (afterDays) => {
			const read = await readDetails((short, long) => {
				for (const screen of [short, long])
					Object.assign(screen.columns[1] ?? {}, {
						field: "dob",
						format: "late-flag",
						late_flag: afterDays,
					});
			}, false);
			expect(closedCodes(read)).toEqual([]);
			expect(listOf(read).columns[1]).toMatchObject({
				kind: "overdue-marker",
				afterDays,
			});
		},
	);

	it("reads a slug HQ registers no format for as a plain column", async () => {
		const reading = await readFormat({ format: "calculate" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { kind: string; field: string }[];
		};
		expect(read.list[1]).toMatchObject({ kind: "plain", field: "notes" });
	});

	it("reads HQ's renamed names as Nova's standard properties", async () => {
		const reading = await readFormat({ field: "date-opened" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string }[];
		};
		expect(read.list[1]?.field).toBe("date_opened");
	});
});

describe("geo formats", () => {
	it("reads the list boundary and its map location as separate case sources", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-boundary" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).columns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "map-layer",
					layer: "boundary",
					field: "notes",
				}),
				expect.objectContaining({ kind: "map-location", field: "phone" }),
			]),
		);
		expect(codes(reading)).not.toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("raises a geo format on the list without its address column", async () => {
		const reading = await readFormat({ format: "geo-points" }, ["short"]);
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
		expect(codes(reading)).not.toContain(
			`${M}13-geo-points-on-the-case-list-only`,
		);
	});

	it("raises a geo color format without the geo column it colors", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-points-colors" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("reads a geo format on the detail beside its address column as a plain column", async () => {
		const reading = await readDetails((_short, long) => {
			Object.assign(long.columns[1] ?? {}, { format: "geo-boundary" });
			addColumn(long, { format: "address", field: "phone" });
		});
		const found = codes(reading);
		expect(found).not.toContain(`${M}8-address`);
		expect(listOf(reading).columns).toContainEqual(
			expect.objectContaining({ kind: "map-location", field: "phone" }),
		);
		expect(found).not.toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
		expect(found).not.toContain(`${M}11-geo-boundary`);
	});

	it("raises a geo format on the detail without its address column", async () => {
		const reading = await readFormat({ format: "geo-boundary" }, ["long"]);
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("raises two geo columns of one format in a detail of a basic menu", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-points" });
			addColumn(short, { format: "geo-points", field: "dob" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
		expect(codes(reading)).not.toContain(
			`${M}13-geo-points-on-the-case-list-only`,
		);
	});

	it("raises two address columns in a detail of a basic menu", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "address" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
	});

	it("reads the boundary color on a list with a location and boundary", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-boundary-color" });
			addColumn(short, { format: "address", field: "phone" });
			addColumn(short, { format: "geo-boundary", field: "dob" });
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).columns).toContainEqual(
			expect.objectContaining({ kind: "map-layer", layer: "boundary-color" }),
		);
		expect(codes(reading)).not.toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	/** The menu made an advanced module, as HQ stores one. */
	const advanced = (app: AppJson) => {
		const module = app.modules[0];
		if (module !== undefined) module.doc_type = "AdvancedModule";
	};

	it("keeps two ordered locations on an advanced list", async () => {
		const reading = await readDetails((short, _long, app) => {
			advanced(app);
			Object.assign(short.columns[1] ?? {}, { format: "address" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).not.toContain(
			`${M}more-than-one-address-column-in-a-detail-of-an-advanced-module`,
		);
		expect(
			listOf(reading)
				.columns.filter((c) => c.kind === "map-location")
				.map((c) => c.field),
		).toEqual(["notes", "phone"]);
		expect(codes(reading)).not.toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
	});

	it("raises two geo columns of one format in a detail of an advanced menu by the advanced menu's row", async () => {
		const reading = await readDetails((short, _long, app) => {
			advanced(app);
			Object.assign(short.columns[1] ?? {}, { format: "geo-points" });
			addColumn(short, { format: "geo-points", field: "dob" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}more-than-one-image-or-geo-column-of-the-same-format-in-a-detail`,
		);
		expect(codes(reading)).not.toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
	});
});

describe("clickable icons", () => {
	it("raises one on the list naming an entry point", async () => {
		const reading = await readFormat(
			{ format: "clickable-icon", endpoint_action_id: "open_visit" },
			["short"],
		);
		expect(codes(reading)).toContain(
			`${M}clickable-icon-with-an-unusable-form-endpoint`,
		);
	});

	it("raises one on the list with no entry point", async () => {
		const reading = await readFormat({ format: "clickable-icon" }, ["short"]);
		expect(codes(reading)).toContain(
			`${M}16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
		);
	});

	it("raises one on the detail whatever its entry point", async () => {
		const reading = await readFormat(
			{ format: "clickable-icon", endpoint_action_id: "open_visit" },
			["long"],
		);
		expect(codes(reading)).toContain(
			`${M}16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
		);
	});
});

describe("a custom tile", () => {
	it("requires physical cells for its placed Search Only information", async () => {
		const reading = await readDetails((short) => {
			short.case_tile_template = "custom";
			Object.assign(short.columns[1] ?? {}, {
				format: "invisible",
				grid_x: null,
				grid_y: null,
			});
		});
		expect(codes(reading)).toContain(
			`${M}custom-tile-column-with-grid-null-unplaced`,
		);
	});
});

describe("filter columns", () => {
	it("drops one that changes no build, and the list reads back without it", async () => {
		const reading = await readDetails((short, long) => {
			addColumn(short, { format: "filter", field: "dob" });
			addColumn(long, { format: "filter", field: "dob" });
		}, false);
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string }[];
		};
		expect(read.list.map((column) => column.field)).toEqual([
			"case_name",
			"notes",
		]);
	});

	it("raises one that is the column HQ's default sort reads", async () => {
		const reading = await readDetails((short) => {
			short.columns.unshift({
				...(short.columns[0] ?? {}),
				format: "filter",
				field: "dob",
			});
		});
		expect(codes(reading)).toContain(`${M}24p-filter-otherwise`);
	});

	it("raises one whose field a sort element names", async () => {
		const reading = await readDetails((short) => {
			addColumn(short, { format: "filter", field: "dob" });
			short.sort_elements = [
				{ field: "dob", type: "string", direction: "ascending", blanks: "" },
			];
		});
		expect(codes(reading)).toContain(`${M}24p-filter-otherwise`);
	});
});

describe("every column's other keys", () => {
	it("holds Nova's own emission with every key claimed", async () => {
		const reading = await readDetails(() => {}, false);
		expect(closedCodes(reading)).toEqual([]);
	});

	it("drops the format extras HQ's editor saves on a column of another format", async () => {
		const reading = await readFormat({
			date_format: "%d/%m/%y",
			late_flag: 7,
			time_ago_interval: 7,
		});
		expect(closedCodes(reading)).toEqual([]);
	});

	it("drops every key HQ's column editor gives a column that no model declares", async () => {
		// `details/bootstrap5/column.js` writes these on every column it saves.
		const reading = await readFormat({
			hasAutocomplete: true,
			calc_xpath: ".",
			isTab: false,
			hasNodeset: false,
			nodeset: "",
			nodesetCaseType: "",
			nodesetFilter: "",
			relevant: "",
		});
		expect(closedCodes(reading)).toEqual([]);
	});

	it("claims the plain format of a column refused for its field, so its one finding is the field's", async () => {
		const reading = await readFormat({ field: "parent/case_id" }, ["long"]);
		expect(closedCodes(reading)).toEqual([
			`${M}case-id-as-a-property-column-s-field`,
		]);
	});

	it("raises a key no model declares, naming nothing", async () => {
		const reading = await readFormat({ planted_key: 1 }, ["short"]);
		const finding = reading.findings.find(
			(one) => one.code === `${M}any-other-undeclared-key`,
		);
		expect(finding).toBeDefined();
		expect(finding?.detail.name).toBeUndefined();
	});
});

describe("a detail's persistence switches", () => {
	it("drops the three switches HQ's Case List page writes false on every save", async () => {
		// `views/modules.py::_update_short_details`, over the page's own `false`.
		const reading = await readDetails((short) => {
			Object.assign(short, {
				persist_case_context: false,
				persistent_case_context_xml: "case_name",
				persist_tile_on_forms: false,
				pull_down_tile: false,
			});
		}, false);
		expect(closedCodes(reading)).toEqual([]);
	});

	it("reads the case context line HQ defaults to the case's name", async () => {
		// `models/case_list.py::Detail.persistent_case_context_xml` defaults to
		// `case_name`, which `EntriesHelper.get_detail_persistent_attr` shows.
		const reading = await readDetails((short) => {
			Object.assign(short, { persist_case_context: true });
		}, false);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).contextAboveForm).toMatchObject({
			kind: "line",
			expression: {
				kind: "term",
				term: { kind: "prop", property: "case_name" },
			},
		});
	});

	it("raises a pull-down where no tile persists to expand", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				persist_case_context: true,
				pull_down_tile: true,
			});
		});
		expect(codes(reading)).toEqual([
			`${M}form-context-without-a-compatible-case-tile`,
		]);
	});
});

describe("a detail's callout and tabs", () => {
	it("brings in fixed text lookup extras and keeps fallback response order", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				lookup_enabled: true,
				lookup_action: "org.nova.proof.CASE_LOOKUP",
				lookup_name: "Find a visit",
				lookup_autolaunch: true,
				lookup_extras: [
					{ key: "mode", value: `concat("Worker's ", '"visit"')` },
				],
				lookup_responses: [{ key: "first" }, { key: "second" }],
			});
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).deviceLookup).toEqual({
			action: "org.nova.proof.CASE_LOOKUP",
			label: "Find a visit",
			automatic: true,
			extras: [{ name: "mode", value: `Worker's "visit"` }],
			responses: ["first", "second"],
		});
	});

	it("brings in a lookup image through the Project media index", async () => {
		const path = "jr://file/commcare/image/case-lookup.png";
		const assetId = testMediaAssetId("case-lookup");
		const read = await readLists(twoColumns(), {
			edit: (app) => {
				Object.assign(app.modules[0].case_details.short, {
					lookup_enabled: true,
					lookup_action: "org.example.SCAN",
					lookup_name: "Scan",
					lookup_image: path,
					lookup_extras: [{ key: "mode", value: "'scan'" }],
					lookup_responses: [{ key: "first" }],
				});
			},
			input: (input) => ({
				...input,
				media: {
					resolve: (ref) =>
						ref === path
							? { kind: "asset", assetId, mediaKind: "image" }
							: { kind: "no-entry" },
				},
			}),
		});
		expect(closedCodes(read)).toEqual([]);
		expect(listOf(read).deviceLookup?.icon).toBe(assetId);
		expect(read.ctx.facts.mediaReferences).toContainEqual(
			expect.objectContaining({
				path,
				assetId,
				slot: "case_list_lookup_icon",
				mediaKind: "image",
			}),
		);
	});

	it.each([
		["@case_id", undefined],
		["scan_id", "scan_id"],
	] as const)(
		"keeps %s keyed confidence and its translated heading",
		async (template, property) => {
			const reading = await readDetails((short, _long, app) => {
				app.langs = ["en", "fr"];
				Object.assign(short, {
					lookup_enabled: true,
					lookup_action: "org.example.MATCH",
					lookup_name: "Find a match",
					lookup_extras: [{ key: "mode", value: "'scan'" }],
					lookup_responses: [{ key: "first" }],
					lookup_display_results: true,
					lookup_field_template: template,
					lookup_field_header: { en: "Confidence", fr: "Confiance" },
				});
			}, false);
			expect(closedCodes(reading)).toEqual([]);
			expect(listOf(reading).deviceLookup?.resultHeading).toBe("Confidence");
			expect(listOf(reading).deviceLookup?.resultProperty).toBe(property);
			expect(
				reading.ctx.translations
					.units()
					.some(
						(unit) =>
							unit.unit.endsWith(":list-lookup-text") &&
							[...unit.byLanguage.values()].includes("Confiance"),
					),
			).toBe(true);
		},
	);

	it.each([
		["1 + 2", undefined],
		["2147483646 + 1", undefined],
		["2147483647 + 1", "lookup-enabled-lookup-action"],
		["1.0 + 2", "lookup-enabled-lookup-action"],
		["1+2", "lookup-enabled-lookup-action"],
		["properties/mode", "lookup-enabled-lookup-action"],
		["'3'", undefined],
	] as const)(
		"accounts for the exact meaning of the lookup argument %s",
		async (value, finding) => {
			const reading = await readDetails((short) => {
				Object.assign(short, {
					lookup_enabled: true,
					lookup_action: "org.example.SCAN",
					lookup_name: "Scan",
					lookup_extras: [{ key: "mode", value }],
					lookup_responses: [{ key: "patient_id" }],
				});
			});
			expect(closedCodes(reading)).toEqual(finding ? [`${M}${finding}`] : []);
			if (value === "'3'") {
				expect(listOf(reading).deviceLookup?.extras).toEqual([
					{ name: "mode", value: "3" },
				]);
			} else if (finding === undefined) {
				const [left, right] = value.split(" + ").map(Number);
				expect(listOf(reading).deviceLookup?.extras).toEqual([
					{
						name: "mode",
						expression: {
							kind: "arith",
							op: "+",
							left: { kind: "term", term: { kind: "literal", value: left } },
							right: { kind: "term", term: { kind: "literal", value: right } },
						},
					},
				]);
			}
		},
	);

	it("raises a callout on the list as one finding, each of its keys claimed under it", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_name: { en: "Scan" },
				lookup_extras: [{ key: "k", value: "v" }],
				lookup_responses: [{ key: "r" }],
			});
		});
		expect(closedCodes(reading)).toEqual([`${M}lookup-enabled-lookup-action`]);
	});

	it("raises a callout with no responses as HQ's own refusal alone", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_extras: [{ key: "k", value: "v" }],
			});
		});
		expect(closedCodes(reading)).toEqual([
			`${M}callout-with-no-extras-or-no-responses`,
		]);
	});

	it("drops a callout on an icon_text_grid list", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				case_tile_template: "icon_text_grid",
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_name: { en: "Scan" },
			});
		});
		const found = closedCodes(reading);
		expect(found).toContain(`${M}named-case-tile-missing-a-required-slot`);
		expect(found.filter((one) => one.includes("lookup"))).toEqual([]);
	});

	it("brings in populated case detail tabs and keeps each title on its first field", async () => {
		const reading = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Visit" },
					starting_index: 0,
				},
				{ doc_type: "DetailTab", header: { en: "Notes" }, starting_index: 1 },
			];
		}, false);
		expect(closedCodes(reading)).toEqual([]);
		const config = listOf(reading);
		expect(
			config.detailTabs?.map((tab) => [tab.title, tab.startColumnUuid]),
		).toEqual([
			["Visit", config.detailColumnOrder[0]],
			["Notes", config.detailColumnOrder[1]],
		]);
	});

	it("keeps the adopted tab identity when HQ reorders its fields and renames the group", async () => {
		const doc = patients(
			[
				plainColumn(uuid(1), "notes", "Notes"),
				plainColumn(uuid(2), "case_name", "Name"),
				plainColumn(uuid(3), "phone", "Phone"),
			],
			{
				list: {
					detailTabs: [
						{ uuid: uuid(41), title: "Review", startColumnUuid: uuid(1) },
						{ uuid: uuid(42), title: "Contact", startColumnUuid: uuid(3) },
					],
				},
			},
		);
		const reading = await readLists(doc, {
			edit: (app) => {
				const detail = app.modules[0].case_details.long;
				const [notes, name, phone] = detail.columns;
				if (!notes || !name || !phone)
					throw new Error("The fixture needs three emitted fields.");
				detail.columns = [name, notes, phone];
				const tabs = detail.tabs as { header: Record<string, string> }[];
				tabs[0].header = { en: "Summary" };
			},
			input: (input) => ({
				...input,
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
			}),
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).detailTabs).toEqual([
			{ uuid: uuid(41), title: "Summary", startColumnUuid: uuid(2) },
			{ uuid: uuid(42), title: "Contact", startColumnUuid: uuid(3) },
		]);
	});
	it("binds a tab display condition to the selected case and reads it back", async () => {
		const reading = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Visit" },
					starting_index: 0,
					relevant: "notes = 'review'",
				},
			];
		}, false);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).detailTabs?.[0]?.displayCondition?.kind).toBe("eq");
	});
	it("reads a child-record tab with its row filter and physical hidden ordering field", async () => {
		const result = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					starting_index: 0,
					header: { en: "Visits" },
					has_nodeset: true,
					nodeset_case_type: "visit",
					nodeset_filter: "notes = 'due'",
				},
			];
			Object.assign(long.columns[1], { format: "invisible" });
		}, false);
		// No form of this app adds that child type, which HQ's Case Detail page would clear; the
		// tab itself reads as stored.
		expect(closedCodes(result)).toEqual([
			`${M}detail-tab-child-type-no-form-of-its-menu-s-case-type-adds`,
		]);
		const config = listOf(result);
		expect(config.detailTabs?.[0]).toMatchObject({
			rowSource: {
				kind: "children",
				caseType: "visit",
				condition: { kind: "eq" },
			},
			orderFields: [config.detailColumnOrder[1]],
		});
	});
	it("reads a record collection and keeps its independent search child type", async () => {
		const result = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					starting_index: 0,
					header: { en: "Roster" },
					has_nodeset: true,
					nodeset: "instance('casedb')/casedb/case[@case_type='patient']",
					nodeset_case_type: "other",
					nodeset_filter: "unknown-function()",
				},
			];
		}, false);
		// No form of this app adds that child type, which HQ's Case Detail page would clear; the
		// tab itself reads as stored.
		expect(closedCodes(result)).toEqual([
			`${M}detail-tab-child-type-no-form-of-its-menu-s-case-type-adds`,
		]);
		expect(listOf(result).detailTabs?.[0]?.rowSource).toMatchObject({
			kind: "records",
			includeChildrenOfType: "other",
			rows: { kind: "cases" },
		});
	});
	it("reads a table field and a calculated value over the same rows with their distinct header identities", async () => {
		const tableId = lookupTableIdSchema.parse(
			"01890000-0000-7000-8000-000000000301",
		);
		const columnId = lookupColumnIdSchema.parse(
			"01890000-0000-7000-8000-000000000302",
		);
		const table = {
			id: tableId,
			tag: "visits",
			name: "Visits",
			columns: [
				{
					id: columnId,
					wireName: "label",
					label: "Visit label",
					dataType: "text" as const,
				},
			],
		};
		const reading = await readLists(twoColumns(), {
			edit: (app) => {
				const { long } = app.modules[0].case_details;
				long.tabs = [
					{
						doc_type: "DetailTab",
						isTab: true,
						header: { en: "Visits" },
						starting_index: 0,
						has_nodeset: true,
						nodeset: "instance('item-list:visits')/visits_list/visits",
					},
				];
				Object.assign(long.columns[0], {
					field: "label",
					useXpathExpression: false,
				});
				Object.assign(long.columns[1], {
					field: "label",
					useXpathExpression: true,
				});
			},
			input: (input) => ({
				...input,
				lookup: {
					definitions: new Map([[table.id, table]]),
					table: (tag) =>
						tag === table.tag
							? {
									tableId,
									column: (name) => (name === "label" ? columnId : undefined),
								}
							: undefined,
				},
			}),
		});
		expect(closedCodes(reading)).toEqual([]);
		const config = listOf(reading);
		const shown = config.detailColumnOrder
			.map((uuid) => config.columns.find((c) => c.uuid === uuid))
			.filter((c) => c && c.visibleInDetail !== false);
		expect(shown).toHaveLength(2);
		for (const c of shown)
			expect(c).toMatchObject({
				kind: "calculated",
				expression: {
					kind: "term",
					term: { kind: "table-column", tableId, columnId },
				},
			});
		expect(
			shown.map((c) => c?.kind === "calculated" && c.rowField === true),
		).toEqual([true, false]);
	});
	it("refuses a basic menu's detail tile row that holds fields of two tabs, and claims its tabs under it", async () => {
		// HQ's build refuses such a tile (`invalid tile configuration`); the tabs are a class of
		// the same refusal, so no key of the detail is left unclaimed.
		const result = await readDetails((_short, long) => {
			long.case_tile_template = "custom";
			for (const [index, column] of long.columns.entries())
				Object.assign(column, {
					grid_x: index * 6,
					grid_y: 0,
					width: 6,
					height: 1,
					horizontal_align: "left",
					vertical_align: "start",
					font_size: "medium",
				});
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Visit" },
					starting_index: 0,
				},
				{ doc_type: "DetailTab", header: { en: "Notes" }, starting_index: 1 },
			];
		}, false);
		const found = closedCodes(result);
		expect(found).toContain(
			`${M}a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`,
		);
		expect(found.filter((code) => code.startsWith("unrecognized"))).toEqual([]);
	});
	it("refuses a data tab's child type no form adds, which HQ's Case Detail page would clear", async () => {
		const result = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Visits" },
					starting_index: 0,
					has_nodeset: true,
					nodeset_case_type: "visit",
				},
			];
		}, false);
		expect(closedCodes(result)).toContain(
			`${M}detail-tab-child-type-no-form-of-its-menu-s-case-type-adds`,
		);
	});
	it("places a refusal on a scalar that cannot supply records for a tab", async () => {
		const result = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Roster" },
					starting_index: 0,
					has_nodeset: true,
					nodeset: "'a scalar'",
				},
			];
		}, false);
		expect(closedCodes(result)).toContain(
			`${M}detail-tab-without-a-resolvable-row-source`,
		);
	});
	it("holds the page's isTab on a tab and refuses any other key a tab does not declare", async () => {
		const tab = (extra: Record<string, unknown>) =>
			readDetails((_short, long) => {
				long.tabs = [
					{
						doc_type: "DetailTab",
						isTab: true,
						header: { en: "Main" },
						starting_index: 0,
						...extra,
					},
				];
			}, false);
		expect(closedCodes(await tab({}))).not.toContain(
			`${M}any-other-undeclared-key`,
		);
		expect(closedCodes(await tab({ foo: 1 }))).toContain(
			`${M}any-other-undeclared-key`,
		);
	});
	it("refuses a tab's display condition that no parse reads as the selected case's condition", async () => {
		// Core's parse refuses it too, which is how the manifest check places it
		// (`proof/checks/manifest_value_classes.py::tab_condition_outside_case_scope`).
		const result = await readDetails((_short, long) => {
			long.tabs = [
				{
					doc_type: "DetailTab",
					isTab: true,
					header: { en: "Main" },
					starting_index: 0,
					relevant: "notes = (",
				},
			];
		}, false);
		expect(closedCodes(result)).toContain(
			`${M}tab-display-condition-outside-its-case-scope`,
		);
	});
	// The variants `hq-case-lists/tab-predicate-outside-its-menu`, `unavailable-case-context-line`
	// and `scalar-in-place-of-tab-records` exhibit these: the refusal is the slot's own class, and
	// the list the menu's details hold back is no second, unrecognized difference.
	it.each([
		[
			"a tab condition reading an instance no scheme names",
			{ relevant: "instance('unknown-roster')/rows/row" },
			`${M}tab-display-condition-outside-its-case-scope`,
		],
		[
			"records rows that are no collection",
			{ has_nodeset: true, nodeset: "'a scalar'" },
			`${M}detail-tab-without-a-resolvable-row-source`,
		],
	] as const)(
		"refuses %s as the tab's own class and nothing else",
		async (_name, extra, entry) => {
			const result = await readDetails((_short, long) => {
				long.tabs = [
					{
						doc_type: "DetailTab",
						header: { en: "Main" },
						starting_index: 0,
						...extra,
					},
				];
			}, false);
			expect(closedCodes(result)).toEqual([entry]);
		},
	);
	it("refuses a form context line reading an instance no scheme names as the line's own class", async () => {
		const result = await readDetails((short) => {
			Object.assign(short, {
				persist_case_context: true,
				persistent_case_context_xml: "instance('unknown-roster')/rows/row",
			});
		}, false);
		expect(closedCodes(result)).toEqual([
			`${M}form-context-expression-outside-its-case-scope`,
		]);
	});
	it("reads a form context source menu that holds no tile as the setting no build reads", async () => {
		// `hq-case-lists/form-context-menu-without-a-tile`: the list names itself, which has no tile.
		const result = await readDetails((short, _long, app) => {
			short.persistent_case_tile_from_module = app.modules[0]?.unique_id;
		}, false);
		expect(closedCodes(result)).toEqual([]);
		expect(listOf(result).contextAboveForm).toBeUndefined();
	});
	it("refuses columns above the first tab without reporting supported child tabs", async () => {
		const reading = await readDetails((_short, long) => {
			long.tabs = [
				{ header: { en: "Main" }, starting_index: 1, relevant: "notes != ''" },
				{
					header: { en: "Kids" },
					starting_index: 2,
					has_nodeset: true,
					nodeset_case_type: "child",
				},
			];
		});
		const found = codes(reading);
		expect(found).toContain(`${M}columns-above-the-first-tab-when-tabs-exist`);
		expect(found).not.toContain(`${M}plain-tab-header-starting-index`);
		expect(found).not.toContain(
			`${M}data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
		);
		expect(found).not.toContain(`${M}tab-relevant-lifts-into-predicate-not`);
	});
});

/**
 * Contract: a column the first pass reads as a plain column passes the settle as one, which
 * compares each stored column as HQ's build reads it: an unregistered slug and `invisible` on the
 * case detail are plain columns, and a mapping a format reads none of is the save's leftover. The
 * failure it catches: a list the manifest holds refused as `unrecognized` once the projection
 * writes `plain` back, which a first-pass test never sees.
 */
describe("a column read as plain, through the whole reading", () => {
	const whole = (edit: (short: Detail, long: Detail) => void) =>
		readDetails(edit, false);

	const notesPlain = (reading: Awaited<ReturnType<typeof whole>>) => {
		const read = comparableList(listOf(reading)) as {
			list: { kind: string; field: string; visibleInDetail?: boolean }[];
		};
		return read.list[1];
	};

	it("reads a slug HQ registers no format for on both screens", async () => {
		const reading = await whole((short, long) => {
			Object.assign(short.columns[1] ?? {}, { format: "calculate" });
			Object.assign(long.columns[1] ?? {}, { format: "calculate" });
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(notesPlain(reading)).toMatchObject({
			kind: "plain",
			field: "notes",
		});
	});

	it("reads Search Only on the case detail as a column the detail shows", async () => {
		const reading = await whole((_short, long) => {
			Object.assign(long.columns[1] ?? {}, { format: "invisible" });
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(notesPlain(reading)).toMatchObject({
			kind: "plain",
			field: "notes",
		});
		expect(notesPlain(reading)?.visibleInDetail).toBeUndefined();
	});

	it("reads an ID mapping left on a column switched back to plain as nothing", async () => {
		const stale = [
			{ key: "m", value: { en: "Male" } },
			{ key: "f", value: { en: "Female" } },
		];
		const reading = await whole((short, long) => {
			Object.assign(short.columns[1] ?? {}, { enum: stale });
			Object.assign(long.columns[1] ?? {}, { enum: stale });
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(notesPlain(reading)).toMatchObject({
			kind: "plain",
			field: "notes",
		});
	});
});

/**
 * Contract: a property column over `case_id` reads the child element `case_id`, which no case
 * holds, so HQ's build shows it blank for every case (`CASE_PROPERTY_MAP` has no `case_id`;
 * Core holds the id as an attribute), while Nova's column over `case_id` shows the id. The
 * failure it catches: the column read as Nova's, and the first publish showing an id where HQ's
 * app showed nothing.
 */
describe("a property column over case_id", () => {
	it("is refused as blank for every case, on either screen", async () => {
		for (const screens of [["short"], ["long"]] as const) {
			const reading = await readFormat(
				{ field: "case_id", useXpathExpression: false },
				screens,
			);
			expect(codes(reading)).toContain(
				`${M}case-id-as-a-property-column-s-field`,
			);
		}
	});

	it("leaves Nova's own column over case_id, the expression `@case_id`, held", async () => {
		const reading = await readLists(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "case_id", "Record ID"),
			]),
		);
		expect(closedCodes(reading)).toEqual([]);
	});
});
