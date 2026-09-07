import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	proseText,
} from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	ancestorPath,
	and,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	gt,
	ifExpr,
	literal,
	match,
	matchAll,
	missing,
	not,
	prop,
	relationStep,
	sessionUser,
	subcasePath,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { buildLookupFixtures } from "../lookup/fixtures";
import { lookupWireNaming } from "../lookup/naming";
import { runValidation } from "../validator/runner";
import { searchEmissionFixture } from "./searchEmissionFixture";

const tableId = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000101",
);
const names = [
	"code",
	"date_text",
	"time_text",
	"score_text",
	"quantity",
] as const;
const columns = names.map((name, index) => ({
	id: lookupColumnIdSchema.parse(
		`018f0000-0000-7000-8000-00000000010${index + 2}`,
	),
	wireName: name,
	label: name,
	dataType: "text" as const,
}));
const revision = parseLookupRevision("1");
const definition: LookupTableDefinition = {
	id: tableId,
	name: "Search values",
	tag: "search_values",
	definitionRevision: revision,
	columns,
};
export const functionLookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "function-evidence",
	projectRevision: revision,
	definitions: [definition],
};
export const functionLookupNaming = lookupWireNaming([definition]);
export const functionLookupFixtures = buildLookupFixtures(
	functionLookupNaming,
	new Map([
		[
			tableId,
			[
				{
					id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-000000000111"),
					values: Object.fromEntries(
						columns.map((column, i) => [
							column.id,
							["baseline", "2024-02-28", "2024-02-28T10:30:00Z", "19.5", "2"][
								i
							],
						]),
					),
				},
			],
		],
	]),
);

export function csqlFunctionFixture() {
	const doc = searchEmissionFixture("remote");
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config || !doc.caseTypes?.[0])
		throw new Error("Fixture has a typed case list");
	doc.caseTypes[0].properties.push(
		{ name: "visit_date", label: proseText("Visit date"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "score", label: proseText("Score"), data_type: "decimal" },
	);
	const value = (name: (typeof names)[number]) => {
		const column = columns.find((c) => c.wireName === name);
		if (!column) throw new Error(name);
		return tableLookup(
			tableId,
			column.id,
			eq(tableColumn(tableId, columns[0].id), literal("baseline")),
		);
	};
	config.searchInputs = [];
	config.filter = and(
		eq(prop("patient", "visit_date"), dateCoerce(value("date_text"))),
		eq(prop("patient", "last_seen"), datetimeCoerce(value("time_text"))),
		eq(prop("patient", "score"), double(value("score_text"))),
		eq(
			prop("patient", "visit_date"),
			dateAdd(
				dateCoerce(value("date_text")),
				"days",
				double(value("quantity")),
			),
		),
		eq(
			prop("patient", "score"),
			double(
				ifExpr(
					eq(sessionUser("role"), literal("clinician")),
					concat(value("score_text"), term(literal(""))),
					term(literal("0")),
				),
			),
		),
	);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, functionLookupContext);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}

export function csqlArgumentFixture() {
	const doc = searchEmissionFixture("remote");
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config || !doc.caseTypes?.[0])
		throw new Error("Fixture has a typed case list");
	doc.caseTypes[0].parent_type = "family";
	doc.caseTypes[0].properties.push({
		name: "visit_date",
		label: proseText("Visit date"),
		data_type: "date",
	});
	doc.caseTypes.push(
		{ name: "family", parent_type: "village", properties: [] },
		{ name: "village", properties: [] },
		{ name: "child", parent_type: "patient", properties: [] },
	);
	config.filter = and(
		exists(ancestorPath(relationStep("parent"))),
		missing(ancestorPath(relationStep("parent")), not(matchAll())),
		exists(subcasePath("parent"), matchAll()),
		gt(count(subcasePath("parent"), matchAll()), literal(1)),
		exists(
			ancestorPath(relationStep("parent"), relationStep("parent", "village")),
		),
	);
	config.searchInputs = [
		advancedSearchInputDef(
			testUuid("argument-match"),
			"date_query",
			"Date",
			"date",
			match(
				prop("patient", "visit_date"),
				dateCoerce(term(literal("2024-02-28"))),
				"fuzzy-date",
			),
		),
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, functionLookupContext);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}
