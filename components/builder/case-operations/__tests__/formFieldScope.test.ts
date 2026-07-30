// components/builder/case-operations/__tests__/formFieldScope.test.ts
//
// The picker offers exactly the answers the commit gate accepts.
//
// `caseOperations.ts::validateOperationTerm` is the rule these mirror: a
// singular change cannot read a repeated answer (there would be one
// value per iteration and no way to say which), and a repeated change
// may read repeated answers only from the repeat it runs over. Getting
// this wrong does not corrupt anything — it makes the editor offer a
// reference the gate then refuses, which is exactly the
// offer-then-reject drift the valid-by-construction rule exists to
// prevent.

import { describe, expect, it } from "vitest";
import { formFieldEntriesFor } from "@/lib/doc/formFieldEntries";
import type { FormFieldEntry } from "@/lib/doc/hooks/useFormFieldEntries";
import { asUuid, type BlueprintDoc } from "@/lib/doc/types";
import type { CaseOperation } from "@/lib/domain";
import { formField, literal, term } from "@/lib/domain/predicate";
import {
	identityKeyFieldDecls,
	operationFormFieldDecls,
	operationReadsOutsideRepeat,
	referencedFieldUuids,
	repeatFieldDecls,
} from "../formFieldScope";

const ROOT_TEXT = asUuid("11111111-1111-4111-8111-111111111111");
const ROOT_HIDDEN = asUuid("22222222-2222-4222-8222-222222222222");
const ROOT_MULTI = asUuid("33333333-3333-4333-8333-333333333333");
const BEDS = asUuid("44444444-4444-4444-8444-444444444444");
const BED_COUNT = asUuid("55555555-5555-4555-8555-555555555555");
const WARDS = asUuid("66666666-6666-4666-8666-666666666666");
const WARD_NAME = asUuid("77777777-7777-4777-8777-777777777777");

const ENTRIES: readonly FormFieldEntry[] = [
	{
		uuid: ROOT_TEXT,
		id: "client_name",
		label: "Client name",
		kind: "text",
		dataType: "text",
		repeat: undefined,
		repeatAncestors: [],
	},
	{
		uuid: ROOT_HIDDEN,
		id: "computed_key",
		label: "computed_key",
		kind: "hidden",
		dataType: undefined,
		repeat: undefined,
		repeatAncestors: [],
	},
	{
		uuid: ROOT_MULTI,
		id: "symptoms",
		label: "Symptoms",
		kind: "multi_select",
		dataType: "multi_select",
		repeat: undefined,
		repeatAncestors: [],
	},
	{
		uuid: BEDS,
		id: "beds",
		label: "Beds",
		kind: "repeat",
		dataType: undefined,
		repeat: BEDS,
		repeatAncestors: [],
	},
	{
		uuid: BED_COUNT,
		id: "bed_count",
		label: "Bed count",
		kind: "int",
		dataType: "int",
		repeat: BEDS,
		repeatAncestors: [BEDS],
	},
	{
		uuid: WARDS,
		id: "wards",
		label: "Wards",
		kind: "repeat",
		dataType: undefined,
		repeat: WARDS,
		repeatAncestors: [],
	},
	{
		uuid: WARD_NAME,
		id: "ward_name",
		label: "Ward name",
		kind: "text",
		dataType: "text",
		repeat: WARDS,
		repeatAncestors: [WARDS],
	},
];

const uuids = (decls: readonly { uuid: string }[]) =>
	decls.map((decl) => decl.uuid);

describe("which answers an operation may read", () => {
	it("a singular change reads only answers outside every repeat", () => {
		expect(uuids(operationFormFieldDecls(ENTRIES, undefined))).toEqual([
			ROOT_TEXT,
			ROOT_HIDDEN,
			ROOT_MULTI,
		]);
	});

	it("a repeated change adds its OWN repeat's answers, not a sibling's", () => {
		expect(uuids(operationFormFieldDecls(ENTRIES, BEDS))).toEqual([
			ROOT_TEXT,
			ROOT_HIDDEN,
			ROOT_MULTI,
			BED_COUNT,
		]);
		expect(uuids(operationFormFieldDecls(ENTRIES, WARDS))).not.toContain(
			BED_COUNT,
		);
	});

	it("never offers a container as an answer", () => {
		const offered = uuids(operationFormFieldDecls(ENTRIES, BEDS));
		expect(offered).not.toContain(BEDS);
		expect(offered).not.toContain(WARDS);
	});

	it("keeps a hidden answer, which holds a value without declaring a type", () => {
		expect(uuids(operationFormFieldDecls(ENTRIES, undefined))).toContain(
			ROOT_HIDDEN,
		);
	});
});

describe("which answers can key an authored create", () => {
	it("takes scalar strings and hidden values, never a multi-select", () => {
		// A multi-select answer is an array in Nova; an identity is one value.
		expect(uuids(identityKeyFieldDecls(ENTRIES, undefined))).toEqual([
			ROOT_TEXT,
			ROOT_HIDDEN,
		]);
	});

	it("correlates with the create's own repeat, root answers excluded", () => {
		// The rule is stricter than a plain read: a repeated create's key must
		// come from the exact repeat, or two iterations would share an identity.
		expect(uuids(identityKeyFieldDecls(ENTRIES, WARDS))).toEqual([WARD_NAME]);
	});
});

describe("changing multiplicity", () => {
	const operation: CaseOperation = {
		uuid: asUuid("88888888-8888-4888-8888-888888888888"),
		id: "create_bed",
		action: "create",
		caseType: "bed",
		target: { kind: "new" },
		name: term(literal("Bed")),
		forEach: { repeat: BEDS },
		writes: [{ property: "count", value: term(formField(BED_COUNT)) }],
	};

	it("reports reads that the destination scope could not reach", () => {
		expect(operationReadsOutsideRepeat(ENTRIES, operation, undefined)).toBe(
			true,
		);
		expect(operationReadsOutsideRepeat(ENTRIES, operation, WARDS)).toBe(true);
		expect(operationReadsOutsideRepeat(ENTRIES, operation, BEDS)).toBe(false);
	});

	it("counts an identity key as a read, though it is not a field term", () => {
		const keyed: CaseOperation = {
			...operation,
			writes: undefined,
			target: { kind: "new", idFrom: BED_COUNT },
		};
		expect(referencedFieldUuids(keyed)).toEqual([BED_COUNT]);
		expect(operationReadsOutsideRepeat(ENTRIES, keyed, undefined)).toBe(true);
	});
});

describe("repeat choices", () => {
	it("lists every repeat in the form", () => {
		expect(uuids(repeatFieldDecls(ENTRIES))).toEqual([BEDS, WARDS]);
	});
});

describe("canonical picker order", () => {
	const FORM = asUuid("88888888-8888-4888-8888-888888888880");
	const ROOT_A = asUuid("88888888-8888-4888-8888-888888888881");
	const ROOT_B = asUuid("88888888-8888-4888-8888-888888888882");
	const REPEAT = asUuid("88888888-8888-4888-8888-888888888883");
	const CHILD_A = asUuid("88888888-8888-4888-8888-888888888884");
	const CHILD_B = asUuid("88888888-8888-4888-8888-888888888885");

	const fields: BlueprintDoc["fields"] = {
		[ROOT_A]: {
			uuid: ROOT_A,
			id: "root_a",
			label: "Root A",
			kind: "text",
		},
		[ROOT_B]: {
			uuid: ROOT_B,
			id: "root_b",
			label: "Root B",
			kind: "text",
		},
		[REPEAT]: {
			uuid: REPEAT,
			id: "visits",
			label: "Visits",
			kind: "repeat",
			repeat_mode: "user_controlled",
		},
		[CHILD_A]: {
			uuid: CHILD_A,
			id: "child_a",
			label: "Child A",
			kind: "text",
		},
		[CHILD_B]: {
			uuid: CHILD_B,
			id: "child_b",
			kind: "hidden",
		},
	};
	// The membership arrays ARE the order the author sees, at every level.
	const fieldOrder: BlueprintDoc["fieldOrder"] = {
		[FORM]: [ROOT_A, ROOT_B, REPEAT],
		[REPEAT]: [CHILD_B, CHILD_A],
	};

	it("orders answer, repeat, and identity-key choices at every hierarchy level", () => {
		const entries = formFieldEntriesFor(fields, fieldOrder, FORM);

		expect(uuids(entries)).toEqual([ROOT_A, ROOT_B, REPEAT, CHILD_B, CHILD_A]);
		expect(uuids(operationFormFieldDecls(entries, undefined))).toEqual([
			ROOT_A,
			ROOT_B,
		]);
		expect(uuids(operationFormFieldDecls(entries, REPEAT))).toEqual([
			ROOT_A,
			ROOT_B,
			CHILD_B,
			CHILD_A,
		]);
		expect(uuids(identityKeyFieldDecls(entries, REPEAT))).toEqual([
			CHILD_B,
			CHILD_A,
		]);
		expect(uuids(repeatFieldDecls(entries))).toEqual([REPEAT]);
	});
});
