/**
 * Contract: a property column read through a relation (`via`) is one concept on every surface
 * the document reaches. The gate admits a walk that reaches one case type and refuses the rest
 * by reason; the order plan joins the column by HQ's own field text (`parent/<property>`); the
 * HQ JSON stores that text and the local suite reads it through the `casedb` join HQ's build
 * writes; a rename of the reached type's property renames the column; and Nova's export of every
 * property kind reads back as the column it was emitted from, its walk included. The failures it
 * catches: a sort rule landing on the wrong column because its join text drifted, a related
 * column reading the list's own case, a rename that leaves a column pointing nowhere, and a
 * related column that reads back as a plain one of the list's own type.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { moduleCaseListOrderPlan } from "@/lib/commcare/suite/case-list/orderPlanOptions";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc, Column, ColumnVia, Uuid } from "@/lib/domain";
import {
	columnSort,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { codes, comparableList, listOf, readLists } from "./listReading";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as Uuid;

const PARENT: ColumnVia = [{ identifier: "parent" }];
const GRANDPARENT: ColumnVia = [
	{ identifier: "parent" },
	{ identifier: "parent" },
];

/** Villages over households over members; the Members list shows `columns`. */
function app(
	columns: Column[],
	options: { readonly search?: boolean } = {},
): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "village",
				properties: [{ name: "district", label: "District" }],
			},
			{
				name: "household",
				parent_type: "village",
				properties: [
					{ name: "address", label: "Address" },
					{ name: "visit_date", label: "Visit date", data_type: "date" },
					{ name: "phone", label: "Phone" },
					{ name: "water", label: "Water" },
				],
			},
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "address",
								caseWrite: { caseType: "household", property: "address" },
							}),
							f({
								kind: "date",
								id: "visit_date",
								caseWrite: { caseType: "household", property: "visit_date" },
							}),
							f({
								kind: "text",
								id: "phone",
								caseWrite: { caseType: "household", property: "phone" },
							}),
							f({
								kind: "text",
								id: "water",
								caseWrite: { caseType: "household", property: "water" },
							}),
						],
					},
				],
				caseListConfig: {
					columns: [plainColumn(uuid(101), "case_name", "Name")],
					searchInputs: [],
				},
			},
			{
				name: "Members",
				caseType: "member",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
				caseListConfig: {
					columns: [plainColumn(uuid(100), "case_name", "Name"), ...columns],
					searchInputs: [],
				},
				...(options.search === true && {
					caseSearchConfig: { workflow: "skipToResults" },
				}),
			},
		],
	});
}

function membersOf(doc: BlueprintDoc) {
	const mod = doc.modules[doc.moduleOrder[1] as Uuid];
	if (mod === undefined) throw new Error("The fixture has no Members menu.");
	return { mod, index: 1 };
}

/** The document with the Members list holding exactly `columns`, in that order. */
function withMembersColumns(
	doc: BlueprintDoc,
	columns: Column[],
): BlueprintDoc {
	const { mod } = membersOf(doc);
	const config = mod.caseListConfig;
	if (config === undefined) throw new Error("The Members menu has no list.");
	return {
		...doc,
		modules: {
			...doc.modules,
			[mod.uuid]: {
				...mod,
				caseListConfig: {
					...config,
					columns,
					listColumnOrder: columns.map((column) => column.uuid),
					detailColumnOrder: columns.map((column) => column.uuid),
				},
			},
		},
	};
}

function relationFindings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.code.startsWith("CASE_LIST_COLUMN"))
		.map((error) => [error.code, error.details?.reason ?? null]);
}

describe("the gate over a column read through a relation", () => {
	it("admits a walk to the parent and to the grandparent", () => {
		const doc = app([
			plainColumn(uuid(1), "address", "Address", { via: PARENT }),
			plainColumn(uuid(2), "district", "District", { via: GRANDPARENT }),
		]);
		expect(relationFindings(doc)).toEqual([]);
	});

	it("keeps unrestricted index walks and refuses type qualifiers or the worker spelling HQ cannot preserve", () => {
		const doc = app([
			plainColumn(uuid(1), "address", "Above the village", {
				via: [
					{ identifier: "parent" },
					{ identifier: "parent" },
					{ identifier: "parent" },
				],
			}),
			plainColumn(uuid(2), "address", "Typed parent", {
				via: [{ identifier: "parent", throughCaseType: "household" }],
			}),
			plainColumn(uuid(3), "address", "Worker", {
				via: [{ identifier: "user", throughCaseType: "household" }],
			}),
			plainColumn(uuid(4), "address", "Host", {
				via: [{ identifier: "host" }],
			}),
		]);
		expect(relationFindings(doc)).toEqual([
			["CASE_LIST_COLUMN_RELATION_INVALID", "parent-type"],
			["CASE_LIST_COLUMN_RELATION_INVALID", "worker"],
		]);
	});

	it("refuses a link whose name doesn't start with a letter, which HQ's field grammar and its build refuse", () => {
		const underscored: ColumnVia = [
			{ identifier: "_hh", throughCaseType: "household" },
		];
		const lettered: ColumnVia = [
			{ identifier: "hh", throughCaseType: "household" },
		];
		const shapes = (via: ColumnVia) => [
			// A sorted column: HQ's build validates its sort element's field.
			app([
				plainColumn(uuid(1), "address", "Address", {
					via,
					sort: columnSort("asc", 0),
				}),
			]),
			// A column hidden from Results ahead of every shown one, in an
			// unsorted list: HQ JSON writes it as an invisible column of its
			// field text, beside the implicit rule's sort element.
			withMembersColumns(app([]), [
				plainColumn(uuid(1), "address", "Address", {
					via,
					visibleInList: false,
				}),
				plainColumn(uuid(100), "case_name", "Name"),
			]),
		];
		for (const doc of shapes(underscored)) {
			expect(relationFindings(doc)).toEqual([
				["CASE_LIST_COLUMN_RELATION_INVALID", "index-name"],
			]);
			// The emission the gate keeps out is the one HQ refuses.
			expect(
				validateHqJson(expandDoc(doc)).map((error) => error.code),
			).toContain("HQJSON_BAD_DETAIL_FIELD");
		}
		for (const doc of shapes(lettered)) {
			expect(relationFindings(doc)).toEqual([]);
			const short = expandDoc(doc).modules[1]?.case_details.short;
			expect(short?.columns.map((column) => column.field)).toContain(
				"hh/address",
			);
			expect(validateHqJson(expandDoc(doc))).toEqual([]);
		}
	});

	it("publishes a native supporting-case path for a menu that offers Search", () => {
		const doc = app(
			[plainColumn(uuid(1), "address", "Address", { via: PARENT })],
			{
				search: true,
			},
		);
		expect(relationFindings(doc)).toEqual([]);
		expect(
			expandDoc(doc).modules[1].case_details.short.columns.map(
				(column) => column.field,
			),
		).toContain("parent/address");
	});

	it("checks the property against the type the walk reaches", () => {
		const doc = app([
			plainColumn(uuid(1), "address", "Ours", {}),
			plainColumn(uuid(2), "no_such", "Theirs", { via: PARENT }),
		]);
		expect(relationFindings(doc)).toEqual([
			["CASE_LIST_COLUMN_UNKNOWN_FIELD", null],
			["CASE_LIST_COLUMN_UNKNOWN_FIELD", null],
		]);
		const typed = app([
			dateColumn(uuid(1), "visit_date", "Visited", "%d/%m/%Y", { via: PARENT }),
		]);
		expect(relationFindings(typed)).toEqual([]);
		const mistyped = app([
			dateColumn(uuid(1), "address", "Not a date", "%d/%m/%Y", { via: PARENT }),
		]);
		expect(relationFindings(mistyped)).toEqual([
			["CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH", null],
		]);
	});
});

describe("the order and both emitters of a related column", () => {
	const sorted = app([
		dateColumn(uuid(1), "visit_date", "Visited", "%d/%m/%Y", {
			via: PARENT,
			sort: columnSort("desc", 0),
		}),
	]);

	it("joins the column by HQ's field text and keys its rule by the related property", () => {
		const { mod } = membersOf(sorted);
		const plan = moduleCaseListOrderPlan(mod, sorted, true);
		const field = plan.fields.find((one) => one.column.uuid === uuid(1));
		expect(field?.joinText).toBe("parent/visit_date");
		expect(field?.wire).toBe("property");
		expect(field?.key).toEqual({
			kind: "property",
			property: "visit_date",
			via: PARENT,
		});
		expect(field?.rule?.element).toEqual({
			kind: "property",
			property: "parent/visit_date",
		});
	});

	it("stores HQ's field and sort element in the HQ JSON", () => {
		const emitted = expandDoc(sorted);
		const short = emitted.modules[1]?.case_details.short;
		const column = short?.columns.find(
			(one) => (one.header as Record<string, string>).en === "Visited",
		);
		expect(column?.field).toBe("parent/visit_date");
		expect(column?.format).toBe("date");
		expect(column?.useXpathExpression).toBe(false);
		expect(short?.sort_elements[0]?.field).toBe("parent/visit_date");
		expect(short?.sort_elements[0]?.type).toBe("date");
	});

	it("reads the related case through casedb in the local suite, on both details", () => {
		const { mod, index } = membersOf(sorted);
		const short = emitShortDetail({
			module: mod,
			moduleIndex: index,
			doc: sorted,
		});
		const join =
			"instance('casedb')/casedb/case[@case_id = current()/index/parent]/visit_date";
		expect(short.xml.replaceAll("&apos;", "'")).toContain(join);
		expect(short.instances.map((one) => one.id)).toContain("casedb");
		expect(short.strings).toHaveProperty(
			"m1.case_short.case_parent/visit_date_2.header",
		);
		const long = emitLongDetail({
			module: mod,
			moduleIndex: index,
			doc: sorted,
		});
		expect(long.xml.replaceAll("&apos;", "'")).toContain(join);
	});
});

describe("a rename of the reached type's property", () => {
	it("renames the related column and leaves the list's own columns", () => {
		const doc = app([
			plainColumn(uuid(1), "address", "Address", { via: PARENT }),
		]);
		const rename: Mutation = {
			kind: "renameCaseProperties",
			renames: [{ caseType: "household", from: "address", to: "street" }],
		};
		const verdict = mutationCommitVerdict(
			doc,
			[mutationSchema.parse(JSON.parse(JSON.stringify(rename)))],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		const { mod } = membersOf(verdict.nextDoc);
		expect(
			mod.caseListConfig?.columns.find((one) => one.uuid === uuid(1)),
		).toMatchObject({ field: "street", via: PARENT });
		expect(
			mod.caseListConfig?.columns.find((one) => one.uuid === uuid(100)),
		).toMatchObject({ field: "case_name" });
	});
});

describe("Nova's export of a related column reads back as itself", () => {
	const icon = testUuid("asset-related-icon") as unknown as MediaAssetId;
	const kinds: [string, Column][] = [
		["plain", plainColumn(uuid(1), "address", "Address", { via: PARENT })],
		[
			"plain standard",
			plainColumn(uuid(1), "case_name", "Household", { via: PARENT }),
		],
		[
			"date",
			dateColumn(uuid(1), "visit_date", "Visited", "%d/%m/%Y", { via: PARENT }),
		],
		["phone", phoneColumn(uuid(1), "phone", "Phone", { via: PARENT })],
		[
			"id-mapping",
			idMappingColumn(
				uuid(1),
				"water",
				"Water",
				[idMappingEntry("tap", "Tap"), idMappingEntry("well", "Well")],
				{ via: PARENT },
			),
		],
		["link", linkColumn(uuid(1), "address", "Map", "Open", { via: PARENT })],
		[
			"interval",
			intervalColumn(uuid(1), "visit_date", "Due", 7, "days", "flag", "Late", {
				via: PARENT,
			}),
		],
		[
			"grandparent",
			plainColumn(uuid(1), "district", "District", { via: GRANDPARENT }),
		],
		[
			"sorted",
			plainColumn(uuid(1), "address", "Address", {
				via: PARENT,
				sort: columnSort("asc", 0),
			}),
		],
		[
			"hidden from Results",
			plainColumn(uuid(1), "address", "Address", {
				via: PARENT,
				visibleInList: false,
			}),
		],
	];
	for (const [kind, column] of kinds)
		it(`reads a ${kind} column`, async () => {
			const doc = app([column]);
			expect(relationFindings(doc)).toEqual([]);
			const reading = await readLists(doc);
			expect(codes(reading)).toEqual([]);
			expect(comparableList(listOf(reading, 1))).toEqual(
				comparableList(membersOf(doc).mod.caseListConfig as never),
			);
		});

	it("reads an image map", async () => {
		const doc = app([
			imageMapColumn(uuid(1), "water", "Water", [imageMapEntry("tap", icon)], {
				via: PARENT,
			}),
		]);
		const reading = await readLists(doc, { media: true });
		expect(codes(reading)).toEqual([]);
		expect(comparableList(listOf(reading, 1))).toEqual(
			comparableList(membersOf(doc).mod.caseListConfig as never),
		);
	});

	it("reads HQ's own spelling of a standard property through the walk, `parent/name`", async () => {
		const doc = app([
			plainColumn(uuid(1), "case_name", "Household", { via: PARENT }),
		]);
		const reading = await readLists(doc, {
			edit: (json) => {
				const pair = json.modules[1]?.case_details;
				for (const detail of [pair?.short, pair?.long])
					for (const column of detail?.columns ?? [])
						if (column.field === "parent/case_name")
							column.field = "parent/name";
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading, 1).columns).toContainEqual(
			expect.objectContaining({ field: "case_name", via: PARENT }),
		);
	});

	it("keeps the wire path to a historical case without inventing a destination type", async () => {
		const doc = app([
			plainColumn(uuid(1), "address", "Address", { via: PARENT }),
		]);
		const reading = await readLists(doc, {
			edit: (json) => {
				const pair = json.modules[1]?.case_details;
				for (const detail of [pair?.short, pair?.long])
					for (const column of detail?.columns ?? [])
						if (column.field === "parent/address")
							column.field = "nowhere/address";
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading, 1).columns).toContainEqual(
			expect.objectContaining({
				field: "address",
				via: [{ identifier: "nowhere" }],
			}),
		);
	});

	/** Reads the Members list after HQ's pages saved `field` over its address column. */
	const readField = (field: string) =>
		readLists(
			app([plainColumn(uuid(1), "address", "Address", { via: PARENT })]),
			{
				edit: (json) => {
					const pair = json.modules[1]?.case_details;
					for (const detail of [pair?.short, pair?.long])
						for (const column of detail?.columns ?? [])
							if (column.field === "parent/address") column.field = field;
				},
			},
		);

	// HQ's page saves a property name of any length (`details/utils.js::isValidPropertyName`)
	// and Core's lexer reads one (`Lexer.matchNCName` has no bound): the name is a read.
	it("holds a property name past 255 characters, on the list's own case and through an index", async () => {
		const long = "x".repeat(256);
		for (const [field, via] of [
			[long, undefined],
			[`site-link/${long}`, [{ identifier: "site-link" }]],
		] as const) {
			const reading = await readField(field);
			expect(codes(reading), field).toEqual([]);
			expect(listOf(reading, 1).columns).toContainEqual(
				expect.objectContaining({
					field: long,
					...(via !== undefined && { via }),
				}),
			);
		}
	});

	// HQ's build rewrites `#owner_name` alone (`PropertyXpathGenerator.xpath`) and writes any
	// other `#` word into the step, which Core's lexer refuses: the column breaks on both workers.
	it("refuses a `#` word other than #owner_name, on the list's own case and through an index", async () => {
		for (const field of ["#visit", "site-link/#visit"]) {
			const reading = await readField(field);
			expect(codes(reading), field).toContain(
				"menus-and-case-lists/column-reading-an-unknown-hash-property",
			);
		}
	});
});
