import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
	asUuid,
	canonicalMutationSchema,
	mutationSchema,
} from "@/lib/doc/types";

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const OPERATION = asUuid("33333333-3333-4333-8333-333333333333");
const OTHER_OPERATION = asUuid("44444444-4444-4444-8444-444444444444");
const FIELD = asUuid("33333333-3333-4333-8333-333333333333");
const OPTION_A = asUuid("44444444-4444-4444-8444-444444444444");
const OPTION_B = asUuid("55555555-5555-4555-8555-555555555555");
const TABLE = asUuid("66666666-6666-7666-8666-666666666666");
const VALUE_COLUMN = asUuid("77777777-7777-7777-8777-777777777777");
const LABEL_COLUMN = asUuid("88888888-8888-7888-8888-888888888888");

const rollingUnion = z.discriminatedUnion("kind", mutationSchema.options);
const canonicalUnion = z.discriminatedUnion(
	"kind",
	canonicalMutationSchema.options,
);

type MutationSchemaWithOptions =
	| typeof mutationSchema
	| typeof canonicalMutationSchema;

function mutationArm(
	schema: MutationSchemaWithOptions,
	kind: string,
): z.ZodType {
	const arm = schema.options.find(
		(option) =>
			option instanceof z.ZodObject &&
			option.shape.kind instanceof z.ZodLiteral &&
			option.shape.kind.value === kind,
	);
	if (arm === undefined) {
		throw new Error(`Fixture: mutation arm ${kind} was not found`);
	}
	return arm;
}

const validModule = {
	uuid: MODULE,
	id: "patients",
	name: "Patients",
} as const;

const validForm = {
	uuid: FORM,
	id: "intake",
	name: "Intake",
	type: "survey",
} as const;

const validTextField = {
	uuid: FIELD,
	id: "name",
	kind: "text",
	label: "Name",
} as const;

const validSelectField = {
	uuid: FIELD,
	id: "status",
	kind: "single_select",
	label: "Status",
	options: [
		{ uuid: OPTION_A, value: "active", label: "Active" },
		{ uuid: OPTION_B, value: "closed", label: "Closed" },
	],
} as const;

const optionsSource = {
	kind: "lookup-table",
	tableId: TABLE,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
} as const;

const unknownNestedPayloads = [
	[
		"addForm.form",
		{
			kind: "addForm",
			moduleUuid: MODULE,
			form: { ...validForm, unknownNestedKey: "must fail" },
		},
	],
	[
		"addModule.module",
		{
			kind: "addModule",
			module: { ...validModule, unknownNestedKey: "must fail" },
		},
	],
	[
		"updateModule.patch.caseListConfig",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					unknownNestedKey: "must fail",
				},
			},
		},
	],
	[
		"addField.field",
		{
			kind: "addField",
			parentUuid: FORM,
			field: { ...validTextField, unknownNestedKey: "must fail" },
		},
	],
] as const;

describe("mutation envelope strictness", () => {
	it("preserves each direct union's exact input and output types", () => {
		expectTypeOf<z.input<typeof mutationSchema>>().toEqualTypeOf<
			z.input<typeof rollingUnion>
		>();
		expectTypeOf<z.output<typeof mutationSchema>>().toEqualTypeOf<
			z.output<typeof rollingUnion>
		>();
		expectTypeOf<z.input<typeof canonicalMutationSchema>>().toEqualTypeOf<
			z.input<typeof canonicalUnion>
		>();
		expectTypeOf<z.output<typeof canonicalMutationSchema>>().toEqualTypeOf<
			z.output<typeof canonicalUnion>
		>();
	});

	it("pins the Zod 4 intersection behavior the envelope must not use", () => {
		const direct = z.object({
			nested: z.object({ known: z.string() }).strict(),
		});
		const payload = { nested: { known: "kept", unknown: "unsafe" } };

		expect(direct.safeParse(payload).success).toBe(false);
		expect(direct.and(z.unknown()).parse(payload)).toEqual(payload);
		expect(
			direct.and(z.unknown().transform(() => ({}))).parse(payload),
		).toEqual({ nested: { known: "kept" } });
	});

	it.each(unknownNestedPayloads)(
		"rejects unknown nested content in %s at every inspection and envelope surface",
		(_name, payload) => {
			const kind = payload.kind;
			const surfaces: readonly [string, z.ZodType][] = [
				["rolling direct arm", mutationArm(mutationSchema, kind)],
				["rolling discriminated union", rollingUnion],
				["rolling envelope", mutationSchema],
				["canonical direct arm", mutationArm(canonicalMutationSchema, kind)],
				["canonical discriminated union", canonicalUnion],
				["canonical envelope", canonicalMutationSchema],
			];

			for (const [surface, schema] of surfaces) {
				expect(schema.safeParse(payload).success, surface).toBe(false);
			}
		},
	);

	it("rejects optionsSource smuggled inside content the union would otherwise strip", () => {
		const payload = {
			kind: "setAppName",
			name: "Patients",
			futureExtension: {
				optionsSource,
			},
		};
		expect(rollingUnion.parse(payload)).toEqual({
			kind: "setAppName",
			name: "Patients",
		});

		for (const schema of [mutationSchema, canonicalMutationSchema]) {
			const parsed = schema.safeParse(payload);
			expect(parsed.success).toBe(false);
			if (parsed.success) continue;
			expect(parsed.error.issues).toContainEqual(
				expect.objectContaining({
					code: "custom",
					path: ["futureExtension", "optionsSource"],
				}),
			);
		}
	});

	it.each([
		{
			kind: "addField",
			parentUuid: FORM,
			field: validSelectField,
			optionsSource,
		},
		{
			kind: "updateField",
			uuid: FIELD,
			targetKind: "single_select",
			patch: {},
			optionsSource,
		},
		{
			kind: "updateField",
			uuid: FIELD,
			targetKind: "single_select",
			patch: {},
			optionsSource: null,
		},
	] as const)(
		"round-trips legitimate top-level $kind optionsSource intent",
		(payload) => {
			for (const schema of [mutationSchema, canonicalMutationSchema]) {
				const wire = JSON.parse(JSON.stringify(payload));
				expect(schema.parse(wire)).toEqual(payload);
			}
		},
	);

	it.each([
		{ kind: "addModule", module: validModule },
		{ kind: "addForm", moduleUuid: MODULE, form: validForm },
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: { caseListConfig: { columns: [], searchInputs: [] } },
		},
		{ kind: "addField", parentUuid: FORM, field: validTextField },
	] as const)(
		"keeps ordinary valid $kind mutations byte-equivalent",
		(payload) => {
			const bytes = JSON.stringify(payload);
			for (const [envelope, directUnion] of [
				[mutationSchema, rollingUnion],
				[canonicalMutationSchema, canonicalUnion],
			] as const) {
				expect(JSON.stringify(envelope.parse(JSON.parse(bytes)))).toBe(
					JSON.stringify(directUnion.parse(JSON.parse(bytes))),
				);
			}
		},
	);

	it.each([{ uuid: MODULE }, { kind: "unknownMutation", uuid: MODULE }])(
		"rejects missing and unknown root discriminators",
		(payload) => {
			for (const schema of [
				rollingUnion,
				mutationSchema,
				canonicalUnion,
				canonicalMutationSchema,
			]) {
				expect(schema.safeParse(payload).success).toBe(false);
			}
		},
	);

	/* The structural omission in `caseOperationPatchSchemaFor` is what makes
	 * identity replacement impossible; this pins the SENTENCE that refusal
	 * carries. A caller who believes an update can move an operation's
	 * identity has to be able to act on the message, and "Unrecognized key"
	 * does not tell them what they got wrong. */
	it("tells a case-operation update why it may not set the operation uuid", () => {
		const payload = {
			kind: "updateForm",
			uuid: FORM,
			patch: {},
			caseOperationPatch: {
				operation: "update",
				uuid: OPERATION,
				patch: { uuid: OTHER_OPERATION, id: "renamed" },
			},
		};

		for (const schema of [mutationSchema, canonicalMutationSchema]) {
			const result = schema.safeParse(payload);
			expect(result.success).toBe(false);
			if (result.success) continue;
			const issue = result.error.issues.find(
				(candidate) =>
					candidate.path.join(".") === "caseOperationPatch.patch.uuid",
			);
			expect(issue?.message).toContain("identity is fixed when it is created");
			expect(issue?.message).toContain("leave that slot out");
		}
	});

	it("does not reintroduce raw unknown content into parsed output", () => {
		const payload = {
			kind: "setAppName",
			name: "Patients",
			futureExtension: { enabled: true },
		};
		const expected = { kind: "setAppName", name: "Patients" };

		for (const schema of [
			rollingUnion,
			mutationSchema,
			canonicalUnion,
			canonicalMutationSchema,
		]) {
			expect(schema.parse(payload)).toEqual(expected);
		}
	});
});
