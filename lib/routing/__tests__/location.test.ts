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

	it("returns [moduleUuid, 'cases'] for case list", () => {
		const loc: Location = { kind: "cases", moduleUuid: modUuid };
		expect(serializePath(loc)).toEqual([modUuid, "cases"]);
	});

	it("returns [moduleUuid, 'cases', caseId] when caseId is present", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: modUuid,
			caseId: "abc123",
		};
		expect(serializePath(loc)).toEqual([modUuid, "cases", "abc123"]);
	});

	it("returns [formUuid] for form without selection", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
		};
		expect(serializePath(loc)).toEqual([formUuid]);
	});

	it("returns [selectedUuid] when a question is selected (flat — parser derives form)", () => {
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
		questions: {},
		formOrder: {},
		questionOrder: {},
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

	it("parses form+selection from single segment (question UUID)", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			questions: { [qUuid]: { uuid: qUuid } as never },
			formOrder: { [modUuid]: [formUuid] },
			questionOrder: { [formUuid]: [qUuid] },
		});
		expect(parsePathToLocation([qUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("parses case list", () => {
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

	it("falls back to home when case screen module is missing", () => {
		expect(parsePathToLocation([modUuid, "cases"], makeParseDoc())).toEqual({
			kind: "home",
		});
	});

	it("parses form with selection from two segments", () => {
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			questions: { [qUuid]: { uuid: qUuid } as never },
			formOrder: { [modUuid]: [formUuid] },
			questionOrder: { [formUuid]: [qUuid] },
		});
		expect(parsePathToLocation([formUuid, qUuid], doc)).toEqual({
			kind: "form",
			moduleUuid: modUuid,
			formUuid,
			selectedUuid: qUuid,
		});
	});

	it("falls back to form without selection when second segment is not a question", () => {
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

	it("resolves nested question (inside a group) to its parent form", () => {
		const groupUuid = asUuid("44444444-4444-4444-4444-444444444444");
		const nestedQUuid = asUuid("55555555-5555-5555-5555-555555555555");
		const doc = makeParseDoc({
			forms: { [formUuid]: { uuid: formUuid } as never },
			questions: {
				[groupUuid]: { uuid: groupUuid, type: "group" } as never,
				[nestedQUuid]: { uuid: nestedQUuid } as never,
			},
			formOrder: { [modUuid]: [formUuid] },
			questionOrder: {
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
	questions: {},
	moduleOrder: [],
	formOrder: {},
	questionOrder: {},
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

	it("rejects form when selectedUuid points to a missing question", () => {
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

	it("accepts form when selectedUuid points to an existing question", () => {
		const doc = docWith({
			modules: { [modUuid]: { uuid: modUuid } as never },
			forms: { [formUuid]: { uuid: formUuid } as never },
			questions: { [qUuid]: { uuid: qUuid } as never },
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
