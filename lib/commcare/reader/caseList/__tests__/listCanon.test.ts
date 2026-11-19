/**
 * Contract: three pairs of case lists that print one source, and the member the reader returns.
 * An unsorted list whose first field is hidden from Results writes the rule a list ordered by its
 * first shown field writes (`implicit-order-rule-is-absent`), and the reader returns no rule; where
 * that field's property is of the date class the rule's element names a date comparison, which no
 * list with no rule writes, and the rule stays. A sorted property only the catalog types, as a
 * date, a date and time or a time, prints one `date` element, and the reader declares it a date. A
 * tile list's column shown nowhere carries only its order rule
 * (`tile-columns-shown-nowhere-are-as-read`), and the reader returns it as a plain column with no
 * header, under the identity a re-read gives a plain column there, whatever its kind, or no column
 * where it has no rule. A menu that lists no cases is written the one name column every new menu
 * in CommCare HQ holds, whatever its list and search hold
 * (`columns-of-a-menu-that-lists-no-cases-are-its-one-name-column`), and the reader returns that one
 * column on both screens, under the identity of the menu's own name column or the one a re-read
 * mints. Each row's two members print the same export, the row leaves a document that holds its
 * member as it is, and a reading of the export holds that member. A blank alt text on a label's
 * entry, as HQ's pages store it, reads as none.
 *
 * The failures it catches, each a different document with no finding: the rule a list with no
 * rule writes read as an authored rule, or a date's rule read as none; a sorted property typed
 * only by the catalog read untyped, whose element then prints as text; a tile column read with a header no export carries, read
 * with a kind no export carries, or a column read that no export holds; a survey menu's columns,
 * header translations, order rules or Search fields kept though no export holds them; a row whose
 * two members print different exports.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	columnSort,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { expandDoc } from "../../../expander";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { withCandidate } from "../../candidate";
import { externalKey, matchingResolver, mintEntityUuid } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";
import { columnsOfAMenuThatListsNoCases } from "../details";
import { implicitOrderRuleIsAbsent } from "../order";
import { tileColumnsShownNowhereAsRead } from "../tile";
import { patients, uuid } from "./fixtures";
import { closedCodes, comparableList, listOf, readLists } from "./listReading";

/** The first menu's list. */
function firstList(doc: BlueprintDoc): CaseListConfig {
	const config = doc.modules[doc.moduleOrder[0] ?? ""]?.caseListConfig;
	if (config === undefined) throw new Error("The document holds no list.");
	return config;
}

/** The export's bytes. */
function exported(doc: BlueprintDoc): string {
	return JSON.stringify(expandDoc(doc));
}

/** The first menu's short detail's order elements, each without its `type`. */
function elementsWithoutType(doc: BlueprintDoc): unknown {
	const module = expandDoc(doc).modules[0] as unknown as {
		case_details: { short: { sort_elements: Record<string, unknown>[] } };
	};
	return module.case_details.short.sort_elements.map(
		({ type: _type, ...rest }) => rest,
	);
}

/** Each column's field, sort and visibility in the list's order. */
function columnFacts(config: CaseListConfig): unknown {
	return (comparableList(config) as { list: Column[] }).list.map((column) => ({
		kind: column.kind,
		field: "field" in column ? column.field : undefined,
		header: column.header,
		sort: column.sort,
		visibleInList: column.visibleInList,
		visibleInDetail: column.visibleInDetail,
	}));
}

describe("the rule an unsorted list with a hidden first field writes", () => {
	/** A list whose first field is hidden, then `shown` with no rule, then a name, over a catalog
	 *  that lists the properties the form writes, so their writers' types reach the export. */
	const unsorted = (shown: Column) =>
		withCandidate(
			patients([
				plainColumn(uuid(1), "phone", "Phone", { visibleInList: false }),
				shown,
				plainColumn(uuid(3), "case_name", "Name"),
			]),
			(draft) => {
				draft.caseTypes = [
					{
						name: "patient",
						properties: ["notes", "dob", "phone"].map((name) => ({
							name,
							label: proseText(name),
						})),
					},
				];
			},
		);
	const text = plainColumn(uuid(2), "notes", "Notes");
	const date = dateColumn(uuid(2), "dob", "Born", "%d/%m/%Y");
	/** `doc` with its shown column ordered by `sort`. */
	const ordered = (doc: BlueprintDoc, sort: ReturnType<typeof columnSort>) =>
		withCandidate(doc, (draft) => {
			const column = draft.modules[
				draft.moduleOrder[0] ?? ""
			]?.caseListConfig?.columns.find((one) => one.uuid === uuid(2));
			if (column !== undefined) column.sort = sort;
		});

	it("is what a list ordered by its first shown field prints, where that field compares as text", () => {
		const plain = unsorted(text);
		expect(exported(ordered(plain, columnSort("asc", 0)))).toBe(
			exported(plain),
		);
		// A date's element names its comparison as a date where the rule is authored, which HQ's
		// build reads as it reads the plain one, but the export holds another `type`.
		const dated = unsorted(date);
		const datedSorted = ordered(dated, columnSort("asc", 0));
		expect(elementsWithoutType(datedSorted)).toEqual(
			elementsWithoutType(dated),
		);
		expect(exported(datedSorted)).not.toBe(exported(dated));
	});

	it("is returned as no rule, and the row leaves a list with no rule, or a date's rule, as it is", () => {
		const plain = unsorted(text);
		const sorted = ordered(plain, columnSort("asc", 0));
		const chosen = implicitOrderRuleIsAbsent(sorted);
		expect(firstList(chosen).columns.some((one) => one.sort)).toBe(false);
		expect(exported(chosen)).toBe(exported(sorted));
		expect(implicitOrderRuleIsAbsent(plain)).toBe(plain);
		// A rule descending is the author's.
		const descending = ordered(plain, columnSort("desc", 0));
		expect(implicitOrderRuleIsAbsent(descending)).toBe(descending);
		// So is a date's, whose element no list with no rule writes.
		const dated = ordered(unsorted(date), columnSort("asc", 0));
		expect(implicitOrderRuleIsAbsent(dated)).toBe(dated);
	});

	for (const [name, shown] of [
		["a text", text],
		["a date", date],
	] as const)
		for (const sorted of [false, true])
			it(`reads ${name} column's export ${sorted ? "with" : "without"} the rule as the row returns it`, async () => {
				const plain = unsorted(shown);
				const source = sorted ? ordered(plain, columnSort("asc", 0)) : plain;
				const reading = await readLists(source);
				expect(closedCodes(reading)).toEqual([]);
				expect(columnFacts(listOf(reading))).toEqual(
					columnFacts(firstList(implicitOrderRuleIsAbsent(source))),
				);
			});
});

/** The document a whole reading of `doc`'s export gives, with the identities a re-read of the
 *  app gives, after asserting the reading holds no finding and no defect. */
async function readWhole(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
	expect(outcome.defects).toEqual([]);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error("The export reads to an account.");
	return outcome.draft.doc;
}

/** Every reader's canonical choice applied to `doc`, in list order. */
function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** The first menu's list and search, the catalog and every translation, as JSON holds them. */
function listFacts(doc: BlueprintDoc): unknown {
	const module = doc.modules[doc.moduleOrder[0] ?? ""];
	return JSON.parse(
		JSON.stringify({
			list: module?.caseListConfig,
			search: module?.caseSearchConfig,
			caseTypes: doc.caseTypes,
			translations: doc.localization?.translations,
		}),
	);
}

describe("a tile list's column shown nowhere", () => {
	/** The tile fixture, its fourth column (hidden from both screens) ordered where `sorted`. */
	const tile = (sorted: boolean) => {
		const doc = tileFixture("tile");
		if (!sorted)
			for (const column of firstList(doc).columns) delete column.sort;
		return doc;
	};

	it("prints what it prints with no header, or as no column where it has no rule", () => {
		for (const sorted of [true, false]) {
			const doc = tile(sorted);
			const chosen = tileColumnsShownNowhereAsRead(doc);
			expect(chosen).not.toBe(doc);
			expect(exported(chosen)).toBe(exported(doc));
			expect(tileColumnsShownNowhereAsRead(chosen)).toEqual(chosen);
		}
		const sorted = firstList(tileColumnsShownNowhereAsRead(tile(true)));
		expect(sorted.columns.map((one) => one.header)).toEqual([
			"Name",
			"Village",
			"Last visit",
			"",
		]);
		const traceless = firstList(tileColumnsShownNowhereAsRead(tile(false)));
		expect(traceless.columns.map((one) => one.header)).toEqual([
			"Name",
			"Village",
			"Last visit",
		]);
		expect(traceless.listColumnOrder).toHaveLength(3);
		expect(traceless.detailColumnOrder).toHaveLength(3);
	});

	for (const sorted of [true, false])
		it(`reads back as the row returns it${sorted ? "" : ", with no rule"}`, async () => {
			const doc = tile(sorted);
			const reading = await readLists(doc);
			expect(closedCodes(reading)).toEqual([]);
			const facts = (config: CaseListConfig) =>
				(columnFacts(config) as Record<string, unknown>[]).map(
					({ kind, field, header, sort }) => ({ kind, field, header, sort }),
				);
			expect(facts(listOf(reading))).toEqual(
				facts(firstList(tileColumnsShownNowhereAsRead(doc))),
			);
		});
});

describe("a tile list's sorted column shown nowhere that is not plain", () => {
	/** The tile fixture, its fourth column (hidden from both screens, ordered first) of `kind`,
	 *  over `rank`, which nothing types. */
	const tile = (kind: "date" | "phone" | "id-mapping") =>
		withCandidate(tileFixture("tile"), (draft) => {
			const config = draft.modules[draft.moduleOrder[0] ?? ""]?.caseListConfig;
			const hidden = config?.columns[3];
			if (config === undefined || hidden === undefined)
				throw new Error("The tile fixture holds four columns.");
			const slots = {
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("asc", 0),
			};
			config.columns[3] =
				kind === "date"
					? dateColumn(hidden.uuid, "rank", "Order", "%d/%m/%Y", slots)
					: kind === "phone"
						? phoneColumn(hidden.uuid, "rank", "Order", slots)
						: idMappingColumn(
								hidden.uuid,
								"rank",
								"Order",
								[idMappingEntry("1", "First")],
								slots,
							);
			for (const property of draft.caseTypes?.[0]?.properties ?? [])
				if (property.name === "rank") delete property.data_type;
		});

	for (const kind of ["date", "phone", "id-mapping"] as const) {
		it(`prints what the plain column a re-read mints prints, for a ${kind} column`, () => {
			const doc = tile(kind);
			const chosen = tileColumnsShownNowhereAsRead(doc);
			expect(exported(chosen)).toBe(exported(doc));
			expect(tileColumnsShownNowhereAsRead(chosen)).toEqual(chosen);
			const config = firstList(chosen);
			const carried = config.columns.find(
				(column) => column.kind !== "calculated" && column.field === "rank",
			);
			const minted = mintEntityUuid(
				doc.appId,
				externalKey.caseListColumn(
					DERIVED_WIRE_IDENTITY.moduleUniqueId(doc.moduleOrder[0] ?? ""),
					"plain",
					"rank",
					0,
				),
			);
			expect(carried).toEqual({
				uuid: minted,
				kind: "plain",
				field: "rank",
				header: "",
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("asc", 0),
			});
			expect(config.listColumnOrder.at(-1)).toBe(minted);
			expect(config.detailColumnOrder).toContain(minted);
		});

		it(`reads back as the row returns it, for a ${kind} column`, async () => {
			const doc = tile(kind);
			expect(listFacts(await readWhole(doc))).toEqual(
				listFacts(canonical(doc)),
			);
		});
	}
});

describe("a sorted property only the catalog types as a date, a date and time or a time", () => {
	/** A menu of patients whose catalog alone types `seen` as `dataType`, listed by `columns`. */
	const seen = (
		dataType: "date" | "datetime" | "time",
		columns: Column[],
	): BlueprintDoc =>
		buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "seen", label: "Seen", data_type: dataType }],
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
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
					caseListConfig: { columns, searchInputs: [] },
				},
			],
		});
	const lists: [string, Column[]][] = [
		[
			"ordered by it descending",
			[
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "seen", "Seen", { sort: columnSort("desc", 0) }),
			],
		],
		[
			"ordered by it as a list with no rule is, behind a hidden first field",
			[
				plainColumn(uuid(1), "case_name", "Name", { visibleInList: false }),
				plainColumn(uuid(2), "seen", "Seen", { sort: columnSort("asc", 0) }),
			],
		],
		[
			"ordered by it from a column hidden from Results",
			[
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "seen", "Seen", {
					visibleInList: false,
					sort: columnSort("asc", 0),
				}),
			],
		],
	];

	for (const dataType of ["date", "datetime", "time"] as const)
		for (const [label, columns] of lists)
			it(`reads back as the canonical document, ${label}, typed ${dataType}`, async () => {
				const doc = seen(dataType, columns);
				const want = canonical(doc);
				// The canonical document prints the export the document prints, a `date` element
				// among it.
				expect(exported(want)).toBe(exported(doc));
				const module = expandDoc(doc).modules[0] as unknown as {
					case_details: { short: { sort_elements: { type: string }[] } };
				};
				expect(
					module.case_details.short.sort_elements.map((one) => one.type),
				).toEqual(["date"]);
				const read = await readWhole(doc);
				expect(listFacts(read)).toEqual(listFacts(want));
			});
});

describe("a menu that lists no cases", () => {
	/** A menu of household surveys, in English then Spanish, whose list holds `columns` (each
	 *  header translated) and, where `searches`, a Search field and a title. */
	const surveys = (
		columns: readonly Column[],
		searches = false,
	): BlueprintDoc => {
		const doc = buildDoc({
			modules: [
				{
					name: "Household surveys",
					caseType: "household",
					caseListConfig: {
						columns: [...columns],
						searchInputs: searches
							? [
									simpleSearchInputDef(
										uuid(9),
										"name",
										"Name",
										"text",
										"case_name",
									),
								]
							: [],
					},
					...(searches && {
						caseSearchConfig: { searchScreenTitle: "Find a household" },
					}),
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
		});
		const units = translationUnitsById(doc);
		const spanish: Record<TranslationUnitId, TranslationEntry> = {};
		for (const column of columns) {
			const id = makeTranslationUnitId("column", column.uuid, "header");
			const unit = units.get(id);
			if (unit === undefined) continue;
			spanish[id] = {
				value: `${column.header} (es)`,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			};
		}
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: spanish },
		};
		return doc;
	};
	const name = plainColumn(uuid(1), "case_name", "Household");
	const village = plainColumn(uuid(2), "village", "Village", {
		sort: columnSort("desc", 0),
	});
	const shell = (column: Column): CaseListConfig => ({
		columns: [column],
		listColumnOrder: [column.uuid],
		detailColumnOrder: [column.uuid],
		searchInputs: [],
	});
	const minted = (doc: BlueprintDoc) =>
		mintEntityUuid(
			doc.appId,
			externalKey.caseListColumn(
				DERIVED_WIRE_IDENTITY.moduleUniqueId(doc.moduleOrder[0] ?? ""),
				"plain",
				"case_name",
				0,
			),
		);

	it("prints the same export as the one name column it is written, which the row returns", () => {
		for (const [doc, kept] of [
			[surveys([village, name], true), name.uuid],
			[surveys([village]), undefined],
			[surveys([]), undefined],
		] as const) {
			const chosen = columnsOfAMenuThatListsNoCases(doc);
			expect(exported(chosen)).toBe(exported(doc));
			expect(columnsOfAMenuThatListsNoCases(chosen)).toBe(chosen);
			const module = chosen.modules[chosen.moduleOrder[0] ?? ""];
			expect(module?.caseSearchConfig).toBeUndefined();
			expect(module?.caseListConfig).toEqual(
				shell(plainColumn(kept ?? minted(doc), "case_name", "Name")),
			);
			expect(chosen.localization?.translations.spa).toEqual({});
		}
		// A menu with a form that loads a case shows its list.
		const listed = patients([plainColumn(uuid(1), "case_name", "Name")]);
		expect(columnsOfAMenuThatListsNoCases(listed)).toBe(listed);
	});

	for (const [label, doc] of [
		["its own name column among others", surveys([village, name], true)],
		["no name column", surveys([village])],
		["no column", surveys([])],
	] as const)
		it(`reads back as the row returns it, holding ${label}`, async () => {
			const read = await readWhole(doc);
			const want = canonical(doc);
			expect(listFacts(read)).toEqual(listFacts(want));
		});
});

it("reads a label's entry whose alt text HQ's pages stored blank as none", async () => {
	const doc = patients([
		plainColumn(uuid(1), "case_name", "Name"),
		idMappingColumn(uuid(2), "notes", "Zone", [
			idMappingEntry("2", "North"),
			idMappingEntry("10", "South"),
		]),
	]);
	const reading = await readLists(doc, {
		edit: (app) => {
			const details = app.modules[0]?.case_details;
			for (const detail of [details?.short, details?.long])
				for (const column of detail?.columns ?? [])
					for (const entry of (column.enum ?? []) as Record<string, unknown>[])
						entry.alt_text = { en: "" };
		},
	});
	const closed = reading.ctx.close();
	expect(
		closed.findings.map((finding) => [finding.code, finding.detail.name]),
	).toEqual([]);
	expect(
		closed.claims.counts["menus-and-case-lists/enum-mappingitem-alt-text-lang"],
	).toBeGreaterThan(0);
	expect(columnFacts(listOf(reading))).toEqual(columnFacts(firstList(doc)));
});
