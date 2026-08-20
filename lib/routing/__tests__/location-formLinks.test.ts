// lib/routing/__tests__/location-formLinks.test.ts
//
// The after-submit links URL carries a selection for the same reason the
// operations URL does: a link has to be sendable, and the rail body is
// keyed by it. So the round trip, and what happens to a selection whose
// link is gone, are what matter here.

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
const LINK = testUuid("link");
const FIELD = testUuid("field");
const GONE = testUuid("gone");

function doc(linkUuids: readonly Uuid[] = [LINK]): LocationParseDoc {
	return {
		modules: { [MOD]: { uuid: MOD, caseType: "visit" } },
		forms: {
			[FORM]: {
				uuid: FORM,
				...(linkUuids.length > 0 && {
					formLinks: linkUuids.map((uuid) => ({ uuid })),
				}),
			},
		},
		fields: { [FIELD]: { uuid: FIELD } },
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
	} as unknown as LocationParseDoc;
}

describe("form-links locations", () => {
	it("round-trips the list", () => {
		const loc = {
			kind: "form-links",
			moduleUuid: MOD,
			formUuid: FORM,
		} as const;
		expect(serializePath(loc)).toEqual([FORM, "links"]);
		expect(parsePathToLocation([FORM, "links"], doc())).toEqual(loc);
	});

	it("round-trips a selected link", () => {
		const loc = {
			kind: "form-links",
			moduleUuid: MOD,
			formUuid: FORM,
			linkUuid: LINK,
		} as const;
		expect(serializePath(loc)).toEqual([FORM, "links", LINK]);
		expect(parsePathToLocation([FORM, "links", LINK], doc())).toEqual(loc);
	});

	it("does not confuse the links noun with a selected field", () => {
		// `[formUuid, fieldUuid]` is the field-selection shape; the parser
		// must take the links branch first and never read "links" as a uuid.
		expect(parsePathToLocation([FORM, FIELD], doc())).toMatchObject({
			kind: "form",
			selectedUuid: FIELD,
		});
	});

	it("keeps the links and operations nouns apart", () => {
		expect(parsePathToLocation([FORM, "operations"], doc())).toMatchObject({
			kind: "form-operations",
		});
		expect(parsePathToLocation([FORM, "links"], doc())).toMatchObject({
			kind: "form-links",
		});
	});

	it("falls back home for an unknown or orphaned form", () => {
		expect(parsePathToLocation([GONE, "links"], doc())).toEqual({
			kind: "home",
		});
		const orphaned = { ...doc(), formOrder: {} } as LocationParseDoc;
		expect(parsePathToLocation([FORM, "links"], orphaned)).toEqual({
			kind: "home",
		});
	});

	it("validates on the module and form only", () => {
		// The selection is not a top-level entity, so `isValidLocation` does
		// not adjudicate it — `recoverLocation` drops a stale one instead.
		expect(
			isValidLocation(
				{ kind: "form-links", moduleUuid: MOD, formUuid: FORM, linkUuid: GONE },
				doc(),
			),
		).toBe(true);
		expect(
			isValidLocation(
				{ kind: "form-links", moduleUuid: MOD, formUuid: GONE },
				doc(),
			),
		).toBe(false);
	});

	it("drops a removed link's selection but keeps the screen", () => {
		// A peer removing the link an author had open should leave them on
		// the list, not bounce them to the form.
		expect(
			recoverLocation(
				{ kind: "form-links", moduleUuid: MOD, formUuid: FORM, linkUuid: GONE },
				doc(),
			),
		).toEqual({ kind: "form-links", moduleUuid: MOD, formUuid: FORM });
	});

	it("keeps a live selection untouched", () => {
		const loc = {
			kind: "form-links",
			moduleUuid: MOD,
			formUuid: FORM,
			linkUuid: LINK,
		} as const;
		expect(recoverLocation(loc, doc())).toBe(loc);
	});

	it("degrades to the module when the form is gone", () => {
		expect(
			recoverLocation(
				{ kind: "form-links", moduleUuid: MOD, formUuid: GONE },
				doc(),
			),
		).toEqual({ kind: "module", moduleUuid: MOD });
	});

	it("tolerates a form that has no links yet", () => {
		// `formLinks` is absent (not `[]`) on a form with no links; the list
		// still opens, and a stale selection still degrades to it.
		const empty = doc([]);
		expect(parsePathToLocation([FORM, "links"], empty)).toEqual({
			kind: "form-links",
			moduleUuid: MOD,
			formUuid: FORM,
		});
		expect(
			recoverLocation(
				{ kind: "form-links", moduleUuid: MOD, formUuid: FORM, linkUuid: LINK },
				empty,
			),
		).toEqual({ kind: "form-links", moduleUuid: MOD, formUuid: FORM });
	});

	it("crosses the presence wire", () => {
		expect(
			locationSchema.parse({
				kind: "form-links",
				moduleUuid: MOD,
				formUuid: FORM,
				linkUuid: LINK,
			}),
		).toEqual({
			kind: "form-links",
			moduleUuid: MOD,
			formUuid: FORM,
			linkUuid: LINK,
		});
		expect(
			locationSchema.parse({
				kind: "form-links",
				moduleUuid: MOD,
				formUuid: FORM,
			}),
		).toEqual({ kind: "form-links", moduleUuid: MOD, formUuid: FORM });
	});
});
