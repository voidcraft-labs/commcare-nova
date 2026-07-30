// lib/routing/__tests__/location-caseOperations.test.ts
//
// The operations URL is the one form-owned configuration screen that
// carries a selection, because a form can hold twenty operations and
// "look at this one" has to be sendable. So the round trip, and what
// happens to a selection whose operation is gone, are what matter here.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Uuid } from "@/lib/doc/types";
import {
	isValidLocation,
	type LocationParseDoc,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "@/lib/routing/location";
import { locationSchema } from "@/lib/routing/types";

const MOD = testUuid("module");
const FORM = testUuid("form");
const OP = testUuid("operation");
const FIELD = testUuid("field");
const GONE = testUuid("gone");

function doc(operationUuids: readonly Uuid[] = [OP]): LocationParseDoc {
	return {
		modules: { [MOD]: { uuid: MOD, caseType: "visit" } },
		forms: {
			[FORM]: {
				uuid: FORM,
				caseOperations: operationUuids.map((uuid) => ({ uuid })),
			},
		},
		fields: { [FIELD]: { uuid: FIELD } },
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
	} as unknown as LocationParseDoc;
}

describe("case-operations locations", () => {
	it("round-trips the list", () => {
		const loc = {
			kind: "form-operations",
			moduleUuid: MOD,
			formUuid: FORM,
		} as const;
		expect(serializePath(loc)).toEqual([FORM, "operations"]);
		expect(parsePathToLocation([FORM, "operations"], doc())).toEqual(loc);
	});

	it("round-trips a selected operation", () => {
		const loc = {
			kind: "form-operations",
			moduleUuid: MOD,
			formUuid: FORM,
			operationUuid: OP,
		} as const;
		expect(serializePath(loc)).toEqual([FORM, "operations", OP]);
		expect(parsePathToLocation([FORM, "operations", OP], doc())).toEqual(loc);
	});

	it("does not confuse the operations noun with a selected field", () => {
		// `[formUuid, fieldUuid]` is the field-selection shape; the parser
		// must take the operations branch first and never read "operations"
		// as a uuid.
		expect(parsePathToLocation([FORM, FIELD], doc())).toMatchObject({
			kind: "form",
			selectedUuid: FIELD,
		});
	});

	it("falls back home for an unknown or orphaned form", () => {
		expect(parsePathToLocation([GONE, "operations"], doc())).toEqual({
			kind: "home",
		});
		const orphaned = { ...doc(), formOrder: {} } as LocationParseDoc;
		expect(parsePathToLocation([FORM, "operations"], orphaned)).toEqual({
			kind: "home",
		});
	});

	it("validates on the module and form only", () => {
		// The selection is not a top-level entity, so `isValidLocation` does
		// not adjudicate it — `recoverLocation` drops a stale one instead.
		expect(
			isValidLocation(
				{
					kind: "form-operations",
					moduleUuid: MOD,
					formUuid: FORM,
					operationUuid: GONE,
				},
				doc(),
			),
		).toBe(true);
		expect(
			isValidLocation(
				{ kind: "form-operations", moduleUuid: MOD, formUuid: GONE },
				doc(),
			),
		).toBe(false);
	});

	it("drops a removed operation's selection but keeps the screen", () => {
		// Losing a selection must not lose the surface — a peer removing the
		// operation an author had open should leave them on the list.
		expect(
			recoverLocation(
				{
					kind: "form-operations",
					moduleUuid: MOD,
					formUuid: FORM,
					operationUuid: GONE,
				},
				doc(),
			),
		).toEqual({ kind: "form-operations", moduleUuid: MOD, formUuid: FORM });
	});

	it("keeps a live selection untouched", () => {
		const loc = {
			kind: "form-operations",
			moduleUuid: MOD,
			formUuid: FORM,
			operationUuid: OP,
		} as const;
		expect(recoverLocation(loc, doc())).toBe(loc);
	});

	it("degrades to the module when the form is gone", () => {
		expect(
			recoverLocation(
				{ kind: "form-operations", moduleUuid: MOD, formUuid: GONE },
				doc(),
			),
		).toEqual({ kind: "module", moduleUuid: MOD });
	});

	it("tolerates a form that has no operations yet", () => {
		const empty = doc([]);
		expect(parsePathToLocation([FORM, "operations"], empty)).toEqual({
			kind: "form-operations",
			moduleUuid: MOD,
			formUuid: FORM,
		});
	});

	it("crosses the presence wire", () => {
		expect(
			locationSchema.parse({
				kind: "form-operations",
				moduleUuid: MOD,
				formUuid: FORM,
				operationUuid: OP,
			}),
		).toEqual({
			kind: "form-operations",
			moduleUuid: MOD,
			formUuid: FORM,
			operationUuid: OP,
		});
		expect(
			locationSchema.parse({
				kind: "form-operations",
				moduleUuid: MOD,
				formUuid: FORM,
			}),
		).toEqual({ kind: "form-operations", moduleUuid: MOD, formUuid: FORM });
	});
});
