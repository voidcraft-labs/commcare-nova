// Device-parity semantics for navigation display conditions: the
// shared on-device emitter prints, the preview evaluator decides, and
// the recorded raw absent-node facts hold — an absent value
// string-unpacks to "" and numeric-coerces to NaN, with no presence
// guards.

import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain";
import {
	and,
	eq,
	gt,
	literal,
	matchAll,
	matchNone,
	prop,
	sessionContext,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	formDisplayVisibility,
	moduleDisplayVisibility,
} from "../displayConditionEvaluation";
import type { PreviewSearchSessionValues } from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import type { PreviewLookupStatus } from "../useLookupPreviewData";

const SESSION: PreviewSearchSessionValues = {
	context: { userid: "u1", username: "ada" },
	user: { role: "supervisor" },
};
const NO_LOOKUP: PreviewLookupStatus = { kind: "idle" };

const TABLE = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const COL_CODE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_REGION = "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId;

const DEFINITION: LookupTableDefinition = {
	id: TABLE,
	name: "Clinics",
	tag: "clinics",
	definitionRevision: "1" as LookupTableDefinition["definitionRevision"],
	columns: [
		{ id: COL_CODE, wireName: "code", label: "Code", dataType: "text" },
		{ id: COL_REGION, wireName: "region", label: "Region", dataType: "text" },
	],
};
const ROW: LookupFixtureRow = {
	id: "018f0000-0000-7000-8000-0000000000r1" as LookupFixtureRow["id"],
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
	it("shows on absent and deeply-always-true conditions", () => {
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
				session: { context: {}, user: {} },
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

	it("retains match-none as hidden (legacy tolerance)", () => {
		expect(
			moduleDisplayVisibility({
				condition: matchNone(),
				session: SESSION,
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("folds a table-lookup over loaded data and pends without it", () => {
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
});

describe("formDisplayVisibility", () => {
	const statusOpen = eq(prop("patient", "status"), literal("open"));

	it("resolves direct self properties from the selected row's projection", () => {
		expect(
			formDisplayVisibility({
				condition: statusOpen,
				session: SESSION,
				currentCaseType: "patient",
				caseProjection: new Map([["status", "open"]]),
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
		expect(
			formDisplayVisibility({
				condition: statusOpen,
				session: SESSION,
				currentCaseType: "patient",
				caseProjection: new Map([["status", "closed"]]),
				lookup: NO_LOOKUP,
			}),
		).toBe("hidden");
	});

	it("an absent property reads blank — raw equality against '' holds", () => {
		expect(
			formDisplayVisibility({
				condition: eq(prop("patient", "status"), literal("")),
				session: SESSION,
				currentCaseType: "patient",
				caseProjection: new Map(),
				lookup: NO_LOOKUP,
			}),
		).toBe("shown");
	});
});
