/**
 * Every instance read a form's logic can make is admitted where its supply
 * exists, through the checker and the commit gate alike: the cases a search
 * found, the cases a several-case form works on, a question's wording, a
 * choice's label, a data table and the organization's places. Each has a
 * refused neighbour that differs in the one fact its admission reads.
 */
import { describe, expect, it } from "vitest";
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import {
	calculate,
	instanceReadsDoc,
	linkCondition,
	reads,
	readsContext,
	searchResults,
	setCalculate,
	setLinkCondition,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import {
	eq,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import type { LookupRevision } from "@/lib/lookup/types";
import { evaluateCommit } from "../gate";
import { runValidation } from "../runner";

const TABLE = lookupTableIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ab");
const CODE = lookupColumnIdSchema.parse("018f3e8a-7b2c-7def-8abc-1234567890ad");
const LOOKUPS = new Map([[TABLE, new Map([[CODE, "text" as const]])]]);
const FACILITIES: LookupValidationContext = {
	kind: "available",
	projectId: "project-instance-reads",
	projectRevision: "7" as LookupRevision,
	definitions: [
		{
			id: TABLE,
			name: "Facilities",
			tag: "facilities",
			definitionRevision: "6" as LookupRevision,
			columns: [
				{ id: CODE, wireName: "code", label: "Code", dataType: "text" },
			],
		},
	],
};

const count = (via: Expression): Expression => ({ kind: "count", via });
const placeName: Expression = {
	kind: "project",
	of: { kind: "locations", where: [] },
	value: { kind: "location-field", field: "name" },
};
const inRegion: Expression = {
	kind: "locations",
	where: [
		eq(term({ kind: "location-field", field: "type" }), {
			kind: "term",
			term: { kind: "location-level", levelUuid: reads.region },
		}),
	],
};

interface Read {
	readonly read: string;
	readonly hidden: (typeof reads)["found"];
	readonly expression: Expression;
	readonly organization?: true;
	readonly lookups?: true;
}
const READS: readonly Read[] = [
	{
		read: "the cases a search found",
		hidden: reads.found,
		expression: count(searchResults()),
	},
	{
		read: "the cases a several-case form works on",
		hidden: reads.closeProbe,
		expression: count({ kind: "selected-cases", module: reads.batch }),
	},
	{
		read: "a question's wording",
		hidden: reads.greeting,
		expression: {
			kind: "itext",
			unit: { field: reads.name, role: "field-label" },
		},
	},
	{
		read: "a written choice's label",
		hidden: reads.greeting,
		expression: {
			kind: "choice-name",
			field: reads.choice,
			value: term({ kind: "field", uuid: reads.choice }),
		},
	},
	{
		read: "a place's name",
		hidden: reads.greeting,
		expression: placeName,
		organization: true,
	},
	{
		read: "the places at a level",
		hidden: reads.found,
		expression: count(inRegion),
		organization: true,
	},
	{
		read: "a data table's rows",
		hidden: reads.found,
		expression: count({
			kind: "table-rows",
			tableId: TABLE,
			where: [eq(tableColumn(TABLE, CODE), literal("north"))],
		}),
		lookups: true,
	},
	{
		read: "a data table's first matching row",
		hidden: reads.greeting,
		expression: tableLookup(
			TABLE,
			CODE,
			eq(tableColumn(TABLE, CODE), literal("north")),
		),
		lookups: true,
	},
];

function withRead(read: Read): BlueprintDoc {
	const doc = instanceReadsDoc(
		read.organization === true ? { organization: true } : {},
	);
	setCalculate(doc, read.hidden, read.expression);
	return doc;
}

describe("instance reads in a question's logic", () => {
	it.each(READS)("admits $read and commits it", (read) => {
		const doc = withRead(read);
		const ctx = slotContext(
			doc,
			calculate(read.hidden),
			read.lookups === true ? LOOKUPS : new Map(),
		);
		if (ctx === undefined) throw new Error("The calculated slot is missing.");
		expect(checkExpression(read.expression, ctx).errors).toEqual([]);
		const lookupContext =
			read.lookups === true ? FACILITIES : LOOKUP_CONTEXT_UNAVAILABLE;
		expect(runValidation(doc, lookupContext)).toEqual([]);
		expect(evaluateCommit({ nextDoc: doc, lookupContext }).ok).toBe(true);
	});

	it.each(READS.filter((read) => read.hidden === reads.found))(
		"refuses $read in a case list filter, which no form evaluates",
		(read) => {
			const doc = withRead(read);
			const ctx = slotContext(
				doc,
				{ entity: "module", uuid: reads.find, slot: "case_list_filter" },
				LOOKUPS,
			);
			if (ctx === undefined) throw new Error("The filter slot is missing.");
			expect(
				checkExpression(eq(read.expression, literal(1)), ctx).errors,
			).toContainEqual(expect.objectContaining({ code: "arm-unavailable" }));
		},
	);
});

describe("a read of places needs the app's organization", () => {
	it("refuses a place read in an app with no organization levels, beside the same read once a level exists", () => {
		const refuse = (doc: BlueprintDoc) =>
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => ({
				code: finding.code,
				field: finding.location.field,
			}));
		const bare = instanceReadsDoc();
		setCalculate(bare, reads.greeting, placeName);
		expect(refuse(bare)).toEqual([
			{ code: "LOCATIONS_READ_NEEDS_ORGANIZATION", field: "calculate" },
		]);
		expect(
			evaluateCommit({
				nextDoc: bare,
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}).ok,
		).toBe(false);
		const organized = instanceReadsDoc({ organization: true });
		setCalculate(organized, reads.greeting, placeName);
		expect(refuse(organized)).toEqual([]);
	});

	it("refuses it in a link's condition too, which reads the same list after the form", () => {
		const condition = eq(count({ kind: "locations", where: [] }), literal(1));
		const doc = instanceReadsDoc();
		setLinkCondition(doc, condition);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => [
				finding.code,
				finding.location.field,
			]),
		).toEqual([["LOCATIONS_READ_NEEDS_ORGANIZATION", "form_link_condition"]]);
		const organized = instanceReadsDoc({ organization: true });
		setLinkCondition(organized, condition);
		expect(
			checkExpression(condition, readsContext(organized, linkCondition)).errors,
		).toEqual([]);
		expect(runValidation(organized, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("refuses places in a menu's display condition, which declares no places, with the next step", () => {
		const doc = instanceReadsDoc({ organization: true });
		doc.modules[reads.households].displayCondition = eq(
			count({ kind: "locations", where: [] }),
			literal(1),
		);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings).toMatchObject([
			{
				code: "MODULE_DISPLAY_CONDITION_TYPE_ERROR",
				details: { checkReason: "places-unavailable" },
			},
		]);
		expect(userFacingError(findings[0])).toBe(
			'The display condition for "Households" reads places, which only a form\'s questions and its links can read. You can read them there instead.',
		);
	});

	it("refuses a level a read names once that level is gone, as a dangling identity", () => {
		const doc = instanceReadsDoc({ organization: true });
		setCalculate(doc, reads.found, count(inRegion));
		doc.organizationLevels = {};
		doc.organizationLevelOrder = [];
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => [
				finding.code,
				finding.details?.identity,
			]),
		).toEqual([
			["INVALID_REF", "place"],
			["LOCATIONS_READ_NEEDS_ORGANIZATION", undefined],
		]);
	});
});
