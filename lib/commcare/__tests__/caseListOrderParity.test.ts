// The two emitters hold to the order plan. One admitted document goes
// through `expandDoc` and the local compiler as an export does, with a media
// manifest; for each field the HQ JSON's column and sort element and the
// local suite's `<sort>` are read from the emitted JSON and the parsed suite,
// never by pattern, and compared with the plan the readers build. That HQ's
// build then joins each element as the plan says is proof 3's, on
// `targeted-attribute-columns`.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import type { HqApplication } from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { moduleCaseListOrderPlan } from "@/lib/commcare/suite/case-list/orderPlanOptions";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CaseListOrderPlan,
	type CaseListOrderRule,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { mediaIds, mediaManifest } from "./mediaWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence, xmlChildren } from "./xmlEvidence";

const id = (name: string) => testUuid(`order-parity-${name}`);
const HIDDEN = { visibleInList: false } as const;
const ZONE = term(prop("client", "zone"));

/** One list per menu: the two equal-text joins an admitted document can
 *  hold, a list whose first field is hidden, an unsorted list, the two menus
 *  of `targeted-shared-property-sort` (a hidden order column joining a shown
 *  column over one property, and an image map carrying the rule beside a
 *  hidden plain column over its property), and the attribute-backed columns
 *  over `owner_id` and `status`, shown and hidden. */
const LISTS: Record<string, CaseListConfig> = {
	"Record order": resolveCaseListConfig({
		columns: [
			plainColumn(id("name"), "case_name", "Name"),
			plainColumn(id("record"), "case_id", "Record ID"),
			plainColumn(id("order"), "case_id", "Record order", {
				...HIDDEN,
				sort: { direction: "asc", priority: 0 },
			}),
		],
		searchInputs: [],
	}),
	"Zone copies": resolveCaseListConfig({
		columns: [
			calculatedColumn(id("zone-1"), "Zone", ZONE),
			calculatedColumn(id("zone-2"), "Zone again", ZONE, {
				sort: { direction: "desc", priority: 0 },
			}),
			plainColumn(id("age"), "age", "Age", {
				sort: { direction: "asc", priority: 1 },
			}),
		],
		searchInputs: [],
	}),
	"Hidden first": resolveCaseListConfig({
		columns: [
			plainColumn(id("level-hidden"), "level", "Level", HIDDEN),
			dateColumn(id("visited"), "visit_date", "Visited", "%Y-%m-%d"),
			plainColumn(id("level"), "level", "Level label"),
		],
		searchInputs: [],
	}),
	Unsorted: resolveCaseListConfig({
		columns: [
			idMappingColumn(id("zone-name"), "zone", "Zone name", [
				idMappingEntry("2", "North"),
				idMappingEntry("10", "South"),
			]),
			plainColumn(id("name-2"), "case_name", "Name"),
		],
		searchInputs: [],
	}),
	"Shared phone": resolveCaseListConfig({
		columns: [
			plainColumn(id("phone-name"), "case_name", "Name"),
			plainColumn(id("phone"), "phone", "Phone"),
			plainColumn(id("phone-order"), "phone", "Phone order", {
				...HIDDEN,
				sort: { direction: "asc", priority: 0 },
			}),
		],
		searchInputs: [],
	}),
	"Shared code": resolveCaseListConfig({
		columns: [
			plainColumn(id("code-name"), "case_name", "Name"),
			imageMapColumn(
				id("code-image"),
				"code",
				"Code",
				[
					imageMapEntry("alpha", mediaIds.label),
					imageMapEntry("bravo", mediaIds.label),
				],
				{ sort: { direction: "asc", priority: 0 } },
			),
			plainColumn(id("code-order"), "code", "Code order", HIDDEN),
		],
		searchInputs: [],
	}),
	Attributes: resolveCaseListConfig({
		columns: [
			plainColumn(id("attribute-name"), "case_name", "Name"),
			plainColumn(id("owner"), "owner_id", "Owner"),
			plainColumn(id("status"), "status", "Status", {
				sort: { direction: "desc", priority: 1 },
			}),
			plainColumn(id("owner-order"), "owner_id", "Owner order", {
				...HIDDEN,
				sort: { direction: "asc", priority: 0 },
			}),
			plainColumn(id("status-hidden"), "status", "Status again", HIDDEN),
		],
		searchInputs: [],
	}),
};

function parityDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Order parity",
		modules: Object.entries(LISTS).map(([name, caseListConfig]) => ({
			name,
			caseType: "client",
			caseListOnly: true,
			caseListConfig,
		})),
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "zone", label: proseText("Zone") },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
					{ name: "code", label: proseText("Code"), data_type: "text" },
					{
						name: "visit_date",
						label: proseText("Visited"),
						data_type: "date",
					},
					{
						name: "level",
						label: proseText("Level"),
						data_type: "single_select",
						options: [
							{ value: "2", label: proseText("Few") },
							{ value: "10", label: proseText("Many") },
						],
					},
				],
			},
		],
	});
}

/** The HQ sort element a rule implies, in the Case List page's spelling. */
function impliedElement(
	plan: CaseListOrderPlan,
	rule: CaseListOrderRule,
	propertyType: (name: string) => string | undefined,
) {
	const field =
		rule.element.kind === "property"
			? rule.element.property
			: `_cc_calculated_${rule.element.position}`;
	const ruled = [
		...plan.fields.flatMap((planned) =>
			planned.rule === rule ? [planned] : [],
		),
	];
	const comparator =
		ruled[0]?.comparator ??
		plan.carriers.find((carrier) => carrier.rule === rule)?.comparator;
	const dateKey =
		ruled[0]?.key?.kind === "property" &&
		["date", "datetime", "time"].includes(
			propertyType(ruled[0].key.property) ?? "",
		);
	const type = rule.implicit
		? "plain"
		: comparator === "integer"
			? "int"
			: comparator === "decimal"
				? "double"
				: dateKey
					? "date"
					: "plain";
	return {
		field,
		type,
		direction: rule.direction === "asc" ? "ascending" : "descending",
		blanks: rule.blanks,
		display: { en: "" },
		sort_calculation: "",
	};
}

function shortDetail(suite: XmlEvidence, moduleIndex: number): XmlEvidence {
	const detail = xmlChildren(suite, "detail").find(
		(candidate) => candidate.attributes.id === `m${moduleIndex}_case_short`,
	);
	if (detail === undefined) throw new Error(`Missing m${moduleIndex} detail`);
	return detail;
}

describe("the order plan's two emitters", () => {
	const doc = parityDoc();
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const assets = mediaManifest();
	const hq: HqApplication = expandDoc(doc, { assets });
	const suite = readXmlEvidence(
		new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				assets,
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml"),
	);
	const propertyType = (name: string) =>
		doc.caseTypes
			?.find((type) => type.name === "client")
			?.properties.find((property) => property.name === name)?.data_type;

	it.each(Object.keys(LISTS).map((name, index) => [name, index] as const))(
		"%s: the HQ columns and sort elements, and the local sorts, are the plan's",
		(_name, index) => {
			const mod = doc.modules[doc.moduleOrder[index]];
			const plan = moduleCaseListOrderPlan(mod, doc, true);
			const short = hq.modules[index].case_details.short;

			// HQ JSON: one stored column per field, its `field` the join text.
			expect(
				short.columns.map((column) => [
					column.field,
					column.useXpathExpression,
				]),
			).toEqual(
				plan.fields.map((field) => [
					field.joinText,
					field.wire === "expression",
				]),
			);
			// Two fields have equal join text exactly when their HQ fields are equal.
			for (const a of plan.fields)
				for (const b of plan.fields)
					expect(a.joinText === b.joinText).toBe(
						short.columns[a.position].field === short.columns[b.position].field,
					);
			// One element per written rule, in order.
			const written = [
				...plan.fields.flatMap((field) => (field.rule ? [field.rule] : [])),
				...plan.carriers.map((carrier) => carrier.rule),
			]
				.filter((rule) => rule.written)
				.sort((a, b) => a.order - b.order);
			expect(short.sort_elements).toEqual(
				written.map((rule) => impliedElement(plan, rule, propertyType)),
			);

			// The local suite: the plan's fields, then one per carrier; a `<sort>`
			// exactly where a key is kept, and `@order` exactly where a rule lands.
			const fields = xmlChildren(shortDetail(suite, index), "field");
			expect(fields).toHaveLength(plan.fields.length + plan.carriers.length);
			const sorts = fields.map((field) => xmlChildren(field, "sort")[0]);
			expect(sorts.map((sort) => sort !== undefined)).toEqual([
				...plan.fields.map((field) => field.key !== undefined),
				...plan.carriers.map(() => true),
			]);
			expect(sorts.map((sort) => sort?.attributes.order)).toEqual([
				...plan.fields.map((field) =>
					field.rule === undefined ? undefined : String(field.rule.order),
				),
				...plan.carriers.map((carrier) => String(carrier.rule.order)),
			]);
			expect(sorts.map((sort) => sort?.attributes.blanks)).toEqual([
				...plan.fields.map((field) =>
					field.rule?.written === true ? field.rule.blanks : undefined,
				),
				...plan.carriers.map((carrier) => carrier.rule.blanks),
			]);
		},
	);

	it("puts the hidden case_id rule on the shown case_id field on both paths", () => {
		const short = hq.modules[0].case_details.short;
		expect(short.sort_elements.map((element) => element.field)).toEqual([
			"_cc_calculated_2",
		]);
		expect(short.columns[1].field).toBe("@case_id");
		expect(short.columns[2]).toMatchObject({
			field: "@case_id",
			format: "invisible",
			useXpathExpression: true,
		});
		const sorts = xmlChildren(shortDetail(suite, 0), "field").map(
			(field) => xmlChildren(field, "sort")[0]?.attributes.order,
		);
		expect(sorts).toEqual([undefined, "1", undefined]);
	});

	it("puts the rule authored on the second equal calculation on the first", () => {
		const short = hq.modules[1].case_details.short;
		expect(short.sort_elements[0]?.field).toBe("_cc_calculated_1");
		const sorts = xmlChildren(shortDetail(suite, 1), "field").map(
			(field) => xmlChildren(field, "sort")[0]?.attributes.order,
		);
		expect(sorts).toEqual(["1", undefined, "2"]);
	});

	it("gives the image map the rule and its key, and the hidden column over its property none", () => {
		const index = Object.keys(LISTS).indexOf("Shared code");
		const short = hq.modules[index].case_details.short;
		expect(short.sort_elements.map((element) => element.field)).toEqual([
			"code",
		]);
		const sorts = xmlChildren(shortDetail(suite, index), "field").map(
			(field) => xmlChildren(field, "sort")[0]?.attributes.order ?? null,
		);
		expect(sorts.slice(1)).toEqual(["1", null]);
		expect(
			xmlChildren(xmlChildren(shortDetail(suite, index), "field")[2], "sort"),
		).toEqual([]);
	});

	it("writes owner_id and status columns, shown and hidden, as attribute expressions", () => {
		const index = Object.keys(LISTS).indexOf("Attributes");
		const short = hq.modules[index].case_details.short;
		expect(
			short.columns.map((column) => [column.field, column.useXpathExpression]),
		).toEqual([
			["case_name", false],
			["@owner_id", true],
			["@status", true],
			["@owner_id", true],
			["@status", true],
		]);
		const paths = xmlChildren(shortDetail(suite, index), "field").map(
			(field) =>
				xmlChildren(
					xmlChildren(xmlChildren(field, "template")[0], "text")[0],
					"xpath",
				)[0]?.attributes.function,
		);
		expect(paths).toEqual([
			"case_name",
			"@owner_id",
			"@status",
			"@owner_id",
			"@status",
		]);
	});

	it("writes a hidden select column as its raw value under an empty header", () => {
		const short = hq.modules[2].case_details.short;
		expect(short.columns[0]).toMatchObject({
			field: "level",
			format: "invisible",
			useXpathExpression: false,
		});
		const [hidden] = xmlChildren(shortDetail(suite, 2), "field");
		const header = xmlChildren(hidden, "header")[0];
		expect(header?.attributes.width).toBe("0");
		expect(xmlChildren(xmlChildren(header, "text")[0], "locale")).toEqual([]);
		const template = xmlChildren(hidden, "template")[0];
		expect(template?.attributes.width).toBe("0");
		const xpath = xmlChildren(xmlChildren(template, "text")[0], "xpath")[0];
		expect(xpath?.attributes.function).toBe("level");
		expect(xmlChildren(xpath, "variable")).toEqual([]);
	});
});
