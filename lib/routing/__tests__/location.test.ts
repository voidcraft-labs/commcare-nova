import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { LocationParseDoc } from "@/lib/routing/location";
import {
	isValidLocation,
	parsePathToLocation,
	serializePath,
} from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
const qUuid = asUuid("33333333-3333-3333-3333-333333333333");

describe("serializePath", () => {
	it("returns empty array for home", () => {
		const loc: Location = { kind: "home" };
		expect(serializePath(loc)).toEqual([]);
	});

	it("returns [moduleUuid] for module screen", () => {
		const loc: Location = { kind: "module", moduleUuid: modUuid };
		expect(serializePath(loc)).toEqual([modUuid]);
	});

	it("returns [moduleUuid, 'results'] for Results authoring", () => {
		const loc: Location = { kind: "cases", moduleUuid: modUuid };
		expect(serializePath(loc)).toEqual([modUuid, "results"]);
	});

	it("returns [moduleUuid, 'cases', caseId] when caseId is present", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc123",
		};
		expect(serializePath(loc)).toEqual([modUuid, "cases", "abc123"]);
	});

	it("percent-encodes a URL-significant opaque caseId into one segment", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "nova-case-v1:9ac52723:external/1 %x+y",
		};
		const segments = serializePath(loc);
		expect(segments).toHaveLength(3);
		// One segment — the raw `/` must not split the path — and no
		// raw reserved characters survive encoding.
		expect(segments[2]).toBe(
			"nova-case-v1%3A9ac52723%3Aexternal%2F1%20%25x%2By",
		);
	});

	it("returns [moduleUuid, 'search'] for the case-search authoring kind", () => {
		// Internal discriminants stay stable while visible URLs use the
		// workspace's friendly Search / Results / Details nouns.
		const loc: Location = {
			kind: "search-config",
			moduleUuid: modUuid,
		};
		expect(serializePath(loc)).toEqual([modUuid, "search"]);
	});

	it("returns [moduleUuid, 'details'] for the case-details authoring kind", () => {
		const loc: Location = {
			kind: "detail-config",
			moduleUuid: modUuid,
		};
		expect(serializePath(loc)).toEqual([modUuid, "details"]);
	});

	it("returns [moduleUuid, 'data-review'] for the data review screen", () => {
		const loc: Location = {
			kind: "data-review",
			moduleUuid: modUuid,
		};
		expect(serializePath(loc)).toEqual([modUuid, "data-review"]);
	});

	it("returns [formUuid] for form without selection", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		};
		expect(serializePath(loc)).toEqual([formUuid]);
	});

	it("returns [selectedUuid] when a field is selected (flat — parser derives form)", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		};
		expect(serializePath(loc)).toEqual([qUuid]);
	});
});

/**
 * Minimal doc fixture for parsing tests. Provides enough structure for
 * `parsePathToLocation` to disambiguate UUIDs.
 */
function makeParseDoc(overrides?: Partial<LocationParseDoc>): LocationParseDoc {
	return {
		modules: {},
		forms: {},
		fields: {},
		formOrder: {},
		fieldOrder: {},
		...overrides,
	};
}

describe("parsePathToLocation", () => {
	it("returns home for empty segments", () => {
		expect(parsePathToLocation([], makeParseDoc())).toEqual({ kind: "home" });
	});

	it("returns home for unrecognized single segment", () => {
		expect(parsePathToLocation(["bogus"], makeParseDoc())).toEqual({
			kind: "home",
		});
	});

	it("parses module screen from single segment", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid, name: "M" } as never },
		});
		expect(parsePathToLocation([modUuid], doc)).toEqual({
			kind: "module",
			moduleUuid: modUuid,
		});
	});

	it("parses form screen from single segment (form UUID)", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid, name: "F" } as never },
			formOrder: { [modUuid]: [formUuid] },
		});
		expect(parsePathToLocation([formUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		});
	});

	it("parses form+selection from single segment (field UUID)", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			fields: { [qUuid]: { uuid: qUuid } as never },
			formOrder: { [modUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [qUuid] },
		});
		expect(parsePathToLocation([qUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("parses the canonical Results authoring path", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "results"], doc)).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
		});
	});

	it("accepts the legacy /cases authoring alias", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "cases"], doc)).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
		});
	});

	it("parses case detail", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "cases", "abc"], doc)).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc",
		});
	});

	it("round-trips a URL-significant opaque caseId through serialize + parse", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "nova-case-v1:9ac52723:external/1 %x+y",
		};
		expect(parsePathToLocation(serializePath(loc), doc)).toEqual(loc);
	});

	it("takes an undecodable caseId segment verbatim instead of throwing", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		// A raw `%` not part of a valid escape — a hand-typed or
		// pre-encoding URL — must degrade to a (missing) identity,
		// never a crash.
		expect(parsePathToLocation([modUuid, "cases", "100%legit"], doc)).toEqual({
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "100%legit",
		});
	});

	it("falls back to home when Results module is missing", () => {
		expect(parsePathToLocation([modUuid, "results"], makeParseDoc())).toEqual({
			kind: "home",
		});
	});

	it("parses the canonical Search authoring path", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "search"], doc)).toEqual({
			kind: "search-config",
			moduleUuid: modUuid,
		});
	});

	it("accepts the legacy /search-config authoring alias", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "search-config"], doc)).toEqual({
			kind: "search-config",
			moduleUuid: modUuid,
		});
	});

	it("parses the data review path", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "data-review"], doc)).toEqual({
			kind: "data-review",
			moduleUuid: modUuid,
		});
	});

	it("falls back to home when the data review module is missing", () => {
		expect(
			parsePathToLocation([modUuid, "data-review"], makeParseDoc({})),
		).toEqual({
			kind: "home",
		});
	});

	it("falls back to home when Search module is missing", () => {
		// Mirrors the Results arm's missing-module recovery: the trailing
		// `search` segment is meaningless without a valid
		// module reference, so the parser collapses to home rather
		// than serving an unresolvable URL.
		expect(parsePathToLocation([modUuid, "search"], makeParseDoc())).toEqual({
			kind: "home",
		});
	});

	it("parses the canonical Details authoring path", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "details"], doc)).toEqual({
			kind: "detail-config",
			moduleUuid: modUuid,
		});
	});

	it("accepts the legacy /detail-config authoring alias", () => {
		const doc = makeParseDoc({
			modules: { [modUuid]: { uuid: modUuid } as never },
		});
		expect(parsePathToLocation([modUuid, "detail-config"], doc)).toEqual({
			kind: "detail-config",
			moduleUuid: modUuid,
		});
	});

	it("falls back to home when Details module is missing", () => {
		expect(parsePathToLocation([modUuid, "details"], makeParseDoc())).toEqual({
			kind: "home",
		});
	});

	it("parses form with selection from two segments", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			fields: { [qUuid]: { uuid: qUuid } as never },
			formOrder: { [modUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [qUuid] },
		});
		expect(parsePathToLocation([formUuid, qUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("falls back to form without selection when second segment is not a field", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			formOrder: { [modUuid]: [formUuid] },
		});
		expect(parsePathToLocation([formUuid, "bogus"], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		});
	});

	it("resolves nested field (inside a group) to its parent form", () => {
		const groupUuid = asUuid("44444444-4444-4444-4444-444444444444");
		const nestedQUuid = asUuid("55555555-5555-5555-5555-555555555555");
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			fields: {
				[groupUuid]: { uuid: groupUuid, type: "group" } as never,
				[nestedQUuid]: { uuid: nestedQUuid } as never,
			},
			formOrder: { [modUuid]: [formUuid] },
			fieldOrder: {
				[formUuid]: [groupUuid],
				[groupUuid]: [nestedQUuid],
			},
		});
		expect(parsePathToLocation([nestedQUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: nestedQUuid,
		});
	});
});

const emptyDoc: BlueprintDoc = {
	appId: "test-app",
	appName: "Test",
	connectType: null,
	caseTypes: null,
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
	fieldParent: {},
};

function docWith(overrides: Partial<BlueprintDoc>): BlueprintDoc {
	return { ...emptyDoc, ...overrides };
}

describe("isValidLocation", () => {
	it("accepts home against any doc", () => {
		expect(isValidLocation({ kind: "home" }, emptyDoc)).toBe(true);
	});

	it("rejects module location when module uuid is unknown", () => {
		expect(
			isValidLocation({ kind: "module", moduleUuid: modUuid }, emptyDoc),
		).toBe(false);
	});

	it("accepts module location when module uuid exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: {
					uuid: modUuid,
					name: "Test Module",
				} as never,
			},
		});
		expect(isValidLocation({ kind: "module", moduleUuid: modUuid }, doc)).toBe(
			true,
		);
	});

	it("accepts cases when module exists; ignores caseId content", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid, name: "m" } as never,
			},
		});
		expect(
			isValidLocation(
				{ kind: "cases", moduleUuid: modUuid, caseId: "anything" },
				doc,
			),
		).toBe(true);
	});

	it("rejects search-config when module uuid is unknown", () => {
		expect(
			isValidLocation({ kind: "search-config", moduleUuid: modUuid }, emptyDoc),
		).toBe(false);
	});

	it("accepts search-config when module exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid, name: "m" } as never,
			},
		});
		expect(
			isValidLocation({ kind: "search-config", moduleUuid: modUuid }, doc),
		).toBe(true);
	});

	it("rejects data-review when module uuid is unknown", () => {
		expect(
			isValidLocation({ kind: "data-review", moduleUuid: modUuid }, emptyDoc),
		).toBe(false);
	});

	it("accepts data-review when module exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid, name: "m" } as never,
			},
		});
		expect(
			isValidLocation({ kind: "data-review", moduleUuid: modUuid }, doc),
		).toBe(true);
	});

	it("rejects detail-config when module uuid is unknown", () => {
		expect(
			isValidLocation({ kind: "detail-config", moduleUuid: modUuid }, emptyDoc),
		).toBe(false);
	});

	it("accepts detail-config when module exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid, name: "m" } as never,
			},
		});
		expect(
			isValidLocation({ kind: "detail-config", moduleUuid: modUuid }, doc),
		).toBe(true);
	});

	it("rejects form when module is missing even if form exists", () => {
		const doc = docWith({
			forms: {
				[formUuid]: { uuid: formUuid } as never,
			},
		});
		expect(
			isValidLocation({ kind: "form", moduleUuid: modUuid, formUuid }, doc),
		).toBe(false);
	});

	it("rejects form when form is missing even if module exists", () => {
		const doc = docWith({
			modules: {
				[modUuid]: { uuid: modUuid } as never,
			},
		});
		expect(
			isValidLocation({ kind: "form", moduleUuid: modUuid, formUuid }, doc),
		).toBe(false);
	});

	it("accepts form when both exist", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
		});
		expect(
			isValidLocation({ kind: "form", moduleUuid: modUuid, formUuid }, doc),
		).toBe(true);
	});

	it("rejects form when selectedUuid points to a missing field", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
		});
		expect(
			isValidLocation(
				{
					kind: "form",
					moduleUuid: modUuid,
					formUuid,
					selectedUuid: qUuid,
				},
				doc,
			),
		).toBe(false);
	});

	it("accepts form when selectedUuid points to an existing field", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
			fields: { [qUuid]: { uuid: qUuid } as never },
		});
		expect(
			isValidLocation(
				{
					kind: "form",
					moduleUuid: modUuid,
					formUuid,
					selectedUuid: qUuid,
				},
				doc,
			),
		).toBe(true);
	});
});
