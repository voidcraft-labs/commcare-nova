// Preview navigation evaluation: the suite's own display-condition text,
// evaluated over the session, the device's cases and the lookup fixtures.
// Native Core compatibility is established separately by the wire corpus.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, withUserSequences } from "@/lib/__tests__/docHelpers";
import { lookupTypeIndexFromNaming } from "@/lib/commcare/lookup/naming";
import { emitFormDisplayConditionForSuite } from "@/lib/commcare/suite/displayConditions";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import { asUuid, lookupRowIdSchema, proseText } from "@/lib/domain";
import {
	and,
	eq,
	gt,
	literal,
	matchAll,
	matchNone,
	or,
	prop,
	sessionContext,
	sessionUserProperty,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	formDisplayVisibility as evaluateFormDisplayVisibility,
	moduleDisplayVisibility as evaluateModuleDisplayVisibility,
	type NavigationDeviceCases,
	navigationSelectedCase,
} from "../displayConditionEvaluation";
import {
	type PreviewSearchSessionValues,
	previewSessionValues,
} from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import type { PreviewLookupStatus } from "../useLookupPreviewData";

type FormVisibilityArgs = Omit<
	Parameters<typeof evaluateFormDisplayVisibility>[0],
	"types"
>;
const MODULE = testUuid("visibility-module");
const FORM = testUuid("visibility-form");
/** The worker property a role gate reads, declared as the doc declares it. */
const ROLE = asUuid("33333333-3333-4333-8333-333333333333");
function visibilityDoc(condition: Expression | undefined, form: boolean) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "status", data_type: "text", label: proseText("Status") },
					{ name: "region", data_type: "text", label: proseText("Region") },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				...(form ? {} : { displayCondition: condition }),
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						...(form ? { displayCondition: condition } : {}),
					},
				],
			},
		],
	});
	return {
		...doc,
		...withUserSequences({
			userProperties: { [ROLE]: { uuid: ROLE, slug: "role", label: "Role" } },
		}),
	};
}
function visibilityContext(args: FormVisibilityArgs, form: boolean) {
	const context = slotContext(
		visibilityDoc(args.condition, form),
		form
			? { entity: "form", uuid: FORM, slot: "form_display_condition" }
			: {
					entity: "module",
					uuid: MODULE,
					slot: "module_display_condition",
				},
		lookupTypeIndexFromNaming(
			args.lookup.kind === "data" ? args.lookup.data.naming : undefined,
		) ?? new Map(),
	);
	if (context === undefined)
		throw new Error("The visibility fixture has no owning slot.");
	return context;
}
function formDisplayVisibility(args: FormVisibilityArgs) {
	return evaluateFormDisplayVisibility({
		...args,
		types: visibilityContext(args, true),
	});
}
function moduleDisplayVisibility(
	args: Omit<Parameters<typeof evaluateModuleDisplayVisibility>[0], "types">,
) {
	return evaluateModuleDisplayVisibility({
		...args,
		types: visibilityContext(args, false),
	});
}

/** A worker's device holding one patient, `p1`, with these properties. */
function devicePatient(
	properties: Readonly<Record<string, string>>,
): NavigationDeviceCases {
	return {
		snapshot: {
			rows: [
				{
					case_id: "p1",
					app_id: "app-1",
					case_type: "patient",
					owner_id: "u1",
					status: "open",
					opened_on: new Date("2026-08-01T00:00:00.000Z"),
					modified_on: new Date("2026-08-02T00:00:00.000Z"),
					closed_on: null,
					case_name: "Ada",
					external_id: null,
					parent_case_id: null,
					properties: { ...properties },
				},
			],
			indices: [],
		},
		caseTypes: visibilityDoc(undefined, true).caseTypes ?? [],
	};
}

/** The case-first form menu reached with `p1`, under the datum its form
 * selects it as. */
function chosenPatient() {
	const selected = navigationSelectedCase(
		visibilityDoc(undefined, true),
		MODULE,
		FORM,
		"p1",
	);
	if (selected === undefined)
		throw new Error("The follow-up form selects no case.");
	return selected;
}

const SESSION: PreviewSearchSessionValues = {
	context: { userid: "u1", username: "ada" },
	user: { role: "supervisor" },
	userPropertySlugs: {},
};
const NO_LOOKUP: PreviewLookupStatus = { kind: "idle" };

const TABLE = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const COL_CODE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_REGION = "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId;

const DEFINITION: LookupTableDefinition = {
	id: TABLE,
	name: "Clinics",
	tag: "clinics",
	definitionRevision: parseLookupRevision("1"),
	columns: [
		{ id: COL_CODE, wireName: "code", label: "Code", dataType: "text" },
		{ id: COL_REGION, wireName: "region", label: "Region", dataType: "text" },
	],
};
const ROW: LookupFixtureRow = {
	id: lookupRowIdSchema.parse("018f0000-0000-7000-8000-0000000000a1"),
	values: { [COL_CODE]: "a1", [COL_REGION]: "north" },
};
const LOOKUP_DATA: PreviewLookupStatus = {
	kind: "data",
	data: previewLookupData({
		projectRevision: "1",
		definitions: [DEFINITION],
		rowsByTable: new Map([[TABLE, [ROW]]]),
	}),
};

describe("moduleDisplayVisibility", () => {
	it("waits for identity hydration before deciding a role gate", () => {
		const property = ROLE;
		const condition = eq(
			term(sessionUserProperty(property)),
			literal("visitor"),
		);
		for (const evaluate of [moduleDisplayVisibility, formDisplayVisibility]) {
			expect(
				evaluate({
					condition,
					session: previewSessionValues(null),
					lookup: NO_LOOKUP,
				}),
			).toBe("pending");
			expect(
				evaluate({
					condition,
					session: {
						...SESSION,
						user: {},
						userPropertySlugs: { [property]: "role" },
					},
					lookup: NO_LOOKUP,
				}),
			).toBe("hidden");
			expect(
				evaluate({
					condition,
					session: {
						...SESSION,
						user: { role: "visitor" },
						userPropertySlugs: { [property]: "role" },
					},
					lookup: NO_LOOKUP,
				}),
			).toBe("shown");
		}
	});
	it("shows on absent and always-true conditions", () => {
		expect(
			moduleDisplayVisibility({
				condition: undefined,
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
		expect(
			moduleDisplayVisibility({
				condition: and(matchAll(), matchAll()),
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
	});

	it("gates on session user data", () => {
		const condition = eq(
			term({ kind: "session-user", field: "role" }),
			literal("supervisor"),
		);
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
		expect(
			moduleDisplayVisibility({
				condition,
				session: { context: {}, user: {}, userPropertySlugs: {} },
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("an absent user value string-unpacks to '' (raw comparison, no guard)", () => {
		const blankEqualsAbsent = eq(
			term({ kind: "session-user", field: "missing_flag" }),
			literal(""),
		);
		expect(
			moduleDisplayVisibility({
				condition: blankEqualsAbsent,
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
	});

	it("numeric ordering over an absent value yields NaN and hides", () => {
		const condition = gt(
			term({ kind: "session-user", field: "missing_count" }),
			literal(0),
		);
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("evaluates never as false", () => {
		expect(
			moduleDisplayVisibility({
				condition: matchNone(),
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("hides an item off the menu before reading its condition", () => {
		const supervisor = eq(
			term({ kind: "session-user", field: "role" }),
			literal("supervisor"),
		);
		for (const evaluate of [moduleDisplayVisibility, formDisplayVisibility]) {
			expect(
				evaluate({
					condition: supervisor,
					hiddenFromMenu: true,
					session: { ...SESSION, identityPending: true },
					lookup: NO_LOOKUP,
				}),
			).toBe("hidden");
			expect(
				evaluate({
					condition: supervisor,
					hiddenFromMenu: false,
					session: SESSION,
					lookup: NO_LOOKUP,
				}),
			).toBe("shown");
		}
	});

	it("reads a table-lookup over the loaded fixture and pends without it", () => {
		const condition = eq(
			tableLookup(
				TABLE,
				COL_CODE,
				eq(
					term(tableColumn(TABLE, COL_REGION)),
					term(sessionContext("username")),
				),
			),
			literal("a1"),
		);
		// The worker's username doesn't match any region → no match → ""
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: LOOKUP_DATA,
			}),
		).toBe("hidden");
		const northSession: PreviewSearchSessionValues = {
			context: { username: "north" },
			user: {},
			userPropertySlugs: {},
		};
		expect(
			moduleDisplayVisibility({
				condition,
				session: northSession,
				lookup: LOOKUP_DATA,
			}),
		).toBe("shown");
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: { kind: "loading" },
			}),
		).toBe("pending");
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: { kind: "error" },
			}),
		).toBe("pending");
	});

	it("evaluates the stored condition as written, with no clause absorbed", () => {
		const lookupClause = eq(
			tableLookup(
				TABLE,
				COL_CODE,
				eq(
					term(tableColumn(TABLE, COL_REGION)),
					term(sessionContext("username")),
				),
			),
			literal("a1"),
		);
		// `x and never` is not folded to never: it still waits for `x`'s data.
		expect(
			moduleDisplayVisibility({
				condition: and(lookupClause, matchNone()),
				session: SESSION,
				lookup: { kind: "loading" },
			}),
		).toBe("pending");
		expect(
			moduleDisplayVisibility({
				condition: and(lookupClause, matchNone()),
				session: SESSION,
				lookup: LOOKUP_DATA,
			}),
		).toBe("hidden");
		expect(
			moduleDisplayVisibility({
				condition: or(lookupClause, matchAll()),
				session: SESSION,
				lookup: LOOKUP_DATA,
			}),
		).toBe("shown");
	});

	it("a loaded snapshot that doesn't COVER the condition's table pends too", () => {
		/* Stale-while-revalidate: the held snapshot predates a validly
		 * committed reference to a new table — never a crash, never a
		 * guess; the generation-keyed refetch decides it. */
		const otherTable = "018f0000-0000-7000-8000-00000000beef" as LookupTableId;
		const condition = eq(
			tableLookup(
				otherTable,
				COL_CODE,
				eq(term(tableColumn(otherTable, COL_REGION)), literal("north")),
			),
			literal("a1"),
		);
		expect(
			moduleDisplayVisibility({
				condition,
				session: SESSION,
				lookup: LOOKUP_DATA,
			}),
		).toBe("pending");
	});
});

describe("formDisplayVisibility", () => {
	const regionNorth = eq(prop("patient", "region"), literal("north"));

	it("selects the case under the datum the suite writes the form's command with", () => {
		expect(chosenPatient()).toEqual({ datumId: "case_id", caseId: "p1" });
	});

	it.each([
		["north", "shown"],
		["south", "hidden"],
	] as const)(
		"keeps the chosen case's %s region distinct from the fixture row",
		(region, visibility) => {
			const condition = eq(
				tableLookup(
					TABLE,
					COL_CODE,
					eq(tableColumn(TABLE, COL_REGION), prop("patient", "region")),
				),
				literal("a1"),
			);
			expect(
				formDisplayVisibility({
					condition,
					session: SESSION,
					selectedCase: chosenPatient(),
					deviceCases: devicePatient({ region }),
					lookup: LOOKUP_DATA,
				}),
			).toBe(visibility);
		},
	);

	it("reads the chosen case's properties from the device's cases", () => {
		expect(
			formDisplayVisibility({
				condition: regionNorth,
				session: SESSION,
				selectedCase: chosenPatient(),
				deviceCases: devicePatient({ region: "north" }),
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
		expect(
			formDisplayVisibility({
				condition: regionNorth,
				session: SESSION,
				selectedCase: chosenPatient(),
				deviceCases: devicePatient({ region: "south" }),
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("waits for the device's cases before reading the chosen case", () => {
		for (const deviceCases of [
			undefined,
			{ snapshot: null, caseTypes: [] },
		] as const) {
			expect(
				formDisplayVisibility({
					condition: regionNorth,
					session: SESSION,
					selectedCase: chosenPatient(),
					deviceCases,
					lookup: NO_LOOKUP,
				}),
			).toBe("pending");
		}
	});

	it("an absent property reads blank: raw equality against '' holds", () => {
		expect(
			formDisplayVisibility({
				condition: eq(prop("patient", "region"), literal("")),
				session: SESSION,
				selectedCase: chosenPatient(),
				deviceCases: devicePatient({}),
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
	});

	it("evaluates the suite's own command text", () => {
		const doc = visibilityDoc(regionNorth, true);
		const types = slotContext(
			doc,
			{ entity: "form", uuid: FORM, slot: "form_display_condition" },
			new Map(),
		);
		if (types === undefined) throw new Error("The fixture has no context.");
		const wire = emitFormDisplayConditionForSuite(
			{ displayCondition: regionNorth },
			types,
			undefined,
			"case_id",
		);
		if (wire === undefined) throw new Error("The condition wrote nothing.");
		// The suite's text, as compiled, reads the chosen case through
		// `session/data/case_id`; Preview evaluates the same tree.
		expect(serializeWire(wire, { target: "preview" }).text).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/region = 'north'",
		);
	});
});
