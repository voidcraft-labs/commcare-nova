// lib/routing/__tests__/location-displayCondition.test.ts
//
// The two display-condition URLs. Both use the same `condition` noun and
// are told apart by whichever entity the first segment names, so the
// round trip and the recovery walk are what keep them honest.

import { describe, expect, it } from "vitest";
import type { Uuid } from "@/lib/doc/types";
import {
	isValidLocation,
	type LocationParseDoc,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "@/lib/routing/location";
import { locationSchema } from "@/lib/routing/types";

const MOD = "mod-1" as Uuid;
const FORM = "form-1" as Uuid;
const FIELD = "field-1" as Uuid;

const doc: LocationParseDoc = {
	modules: { [MOD]: { uuid: MOD, caseType: "mother" } },
	forms: { [FORM]: { uuid: FORM } },
	fields: { [FIELD]: { uuid: FIELD } },
	formOrder: { [MOD]: [FORM] },
	fieldOrder: { [FORM]: [FIELD] },
} as unknown as LocationParseDoc;

describe("display-condition locations", () => {
	it("round-trips a module condition", () => {
		const loc = { kind: "module-condition", moduleUuid: MOD } as const;
		expect(serializePath(loc)).toEqual([MOD, "condition"]);
		expect(parsePathToLocation([MOD, "condition"], doc)).toEqual(loc);
	});

	it("round-trips a form condition anchored on the form uuid", () => {
		const loc = {
			kind: "form-condition",
			moduleUuid: MOD,
			formUuid: FORM,
		} as const;
		expect(serializePath(loc)).toEqual([FORM, "condition"]);
		expect(parsePathToLocation([FORM, "condition"], doc)).toEqual(loc);
	});

	it("falls back home when the condition's owner is unknown", () => {
		expect(parsePathToLocation(["nope" as Uuid, "condition"], doc)).toEqual({
			kind: "home",
		});
	});

	it("falls back home for a form outside every module", () => {
		const orphaned = { ...doc, formOrder: {} } as LocationParseDoc;
		expect(parsePathToLocation([FORM, "condition"], orphaned)).toEqual({
			kind: "home",
		});
	});

	it("validates both against the doc", () => {
		expect(
			isValidLocation({ kind: "module-condition", moduleUuid: MOD }, doc),
		).toBe(true);
		expect(
			isValidLocation(
				{ kind: "module-condition", moduleUuid: "gone" as Uuid },
				doc,
			),
		).toBe(false);
		expect(
			isValidLocation(
				{ kind: "form-condition", moduleUuid: MOD, formUuid: FORM },
				doc,
			),
		).toBe(true);
		expect(
			isValidLocation(
				{ kind: "form-condition", moduleUuid: MOD, formUuid: "gone" as Uuid },
				doc,
			),
		).toBe(false);
	});

	it("recovers inward: a deleted form leaves the module, a deleted module leaves home", () => {
		expect(
			recoverLocation(
				{ kind: "form-condition", moduleUuid: MOD, formUuid: "gone" as Uuid },
				doc,
			),
		).toEqual({ kind: "module", moduleUuid: MOD });
		expect(
			recoverLocation(
				{ kind: "module-condition", moduleUuid: "gone" as Uuid },
				doc,
			),
		).toEqual({ kind: "home" });
	});

	it("keeps a module condition on a module with no case type", () => {
		const typeless = {
			...doc,
			modules: { [MOD]: { uuid: MOD } },
		} as unknown as LocationParseDoc;
		const loc = { kind: "module-condition", moduleUuid: MOD } as const;
		expect(recoverLocation(loc, typeless)).toBe(loc);
	});

	it("crosses the presence wire", () => {
		expect(
			locationSchema.parse({ kind: "module-condition", moduleUuid: MOD }),
		).toEqual({ kind: "module-condition", moduleUuid: MOD });
		expect(
			locationSchema.parse({
				kind: "form-condition",
				moduleUuid: MOD,
				formUuid: FORM,
			}),
		).toEqual({ kind: "form-condition", moduleUuid: MOD, formUuid: FORM });
	});
});
