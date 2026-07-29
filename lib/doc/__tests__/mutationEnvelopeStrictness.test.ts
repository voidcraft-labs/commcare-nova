import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationSchema } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";

const MODULE = testUuid("module");
const FORM = testUuid("form");
const FIELD = testUuid("field");
const OPERATION = testUuid("operation");
const OTHER_OPERATION = testUuid("other-operation");
const OPTION_A = testUuid("option-a");
const OPTION_B = testUuid("option-b");
const TABLE = "019b0000-0000-7000-8000-000000000001";
const VALUE_COLUMN = "019b0000-0000-7000-8000-000000000002";
const LABEL_COLUMN = "019b0000-0000-7000-8000-000000000003";

const directUnion = z.discriminatedUnion("kind", mutationSchema.options);

function mutationArm(kind: string): z.ZodType {
	const arm = mutationSchema.options.find(
		(option) =>
			option instanceof z.ZodObject &&
			option.shape.kind instanceof z.ZodLiteral &&
			option.shape.kind.value === kind,
	);
	if (arm === undefined) throw new Error(`missing mutation arm ${kind}`);
	return arm;
}

const validTextField = {
	uuid: FIELD,
	id: "name",
	kind: "text",
	label: proseText("Name"),
} as const;

const inlineSource = {
	kind: "inline",
	options: [
		{ uuid: OPTION_A, value: "active", label: proseText("Active") },
		{ uuid: OPTION_B, value: "closed", label: proseText("Closed") },
	],
} as const;

const lookupSource = {
	kind: "lookup",
	tableId: TABLE,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
} as const;

describe("final mutation envelope", () => {
	it("preserves the direct union input and output types", () => {
		expectTypeOf<z.input<typeof mutationSchema>>().toEqualTypeOf<
			z.input<typeof directUnion>
		>();
		expectTypeOf<z.output<typeof mutationSchema>>().toEqualTypeOf<
			z.output<typeof directUnion>
		>();
	});

	it.each([
		{
			kind: "addModule",
			module: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				unknownNestedKey: "reject",
			},
		},
		{
			kind: "addField",
			parentUuid: FORM,
			field: { ...validTextField, unknownNestedKey: "reject" },
		},
	] as const)("rejects unknown nested content in $kind", (payload) => {
		expect(mutationArm(payload.kind).safeParse(payload).success).toBe(false);
		expect(mutationSchema.safeParse(payload).success).toBe(false);
	});

	it("stores select source only in the field or update patch", () => {
		const add = {
			kind: "addField",
			parentUuid: FORM,
			field: {
				uuid: FIELD,
				id: "status",
				kind: "single_select",
				label: proseText("Status"),
				optionsSource: inlineSource,
			},
		} as const;
		const update = {
			kind: "updateField",
			uuid: FIELD,
			targetKind: "single_select",
			patch: { optionsSource: lookupSource },
		} as const;
		expect(mutationSchema.parse(add)).toEqual(add);
		expect(mutationSchema.parse(update)).toEqual(update);
		expect(
			mutationSchema.safeParse({ ...update, optionsSource: lookupSource })
				.success,
		).toBe(false);
	});

	it("requires the final updateField patch instead of accepting a pre-horizon no-op", () => {
		expect(
			mutationSchema.safeParse({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
			}).success,
		).toBe(false);
	});

	it("rejects a duplicate whole-operation body beside a granular patch", () => {
		const result = mutationSchema.safeParse({
			kind: "updateForm",
			uuid: FORM,
			patch: {},
			caseOperationChange: {
				operation: "add",
				value: {
					uuid: OPERATION,
					id: "create_visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
				},
			},
			caseOperationPatch: {
				operation: "move",
				uuid: OPERATION,
				after: null,
			},
		});
		expect(result.success).toBe(false);
	});

	it("explains why a granular operation update may not replace identity", () => {
		const result = mutationSchema.safeParse({
			kind: "updateForm",
			uuid: FORM,
			patch: {},
			caseOperationPatch: {
				operation: "update",
				uuid: OPERATION,
				patch: { uuid: OTHER_OPERATION, id: "renamed" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issue = result.error.issues.find(
			(candidate) =>
				candidate.path.join(".") === "caseOperationPatch.patch.uuid",
		);
		expect(issue?.message).toContain("identity is fixed when it is created");
	});

	it("accepts final unlink and member-order payloads without fallbacks", () => {
		const unlink = {
			kind: "updateForm",
			uuid: FORM,
			patch: {},
			caseOperationPatch: {
				operation: "update-link",
				uuid: OPERATION,
				identifier: "parent",
				patch: { target: null },
			},
		} as const;
		const reorder = {
			kind: "updateForm",
			uuid: FORM,
			patch: {},
			caseOperationPatch: {
				operation: "reorder-writes",
				uuid: OPERATION,
				properties: ["status", "visited_on"],
			},
		} as const;
		expect(mutationSchema.parse(unlink)).toEqual(unlink);
		expect(mutationSchema.parse(reorder)).toEqual(reorder);
	});
});
