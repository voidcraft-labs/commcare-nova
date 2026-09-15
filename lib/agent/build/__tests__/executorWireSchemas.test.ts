/** Offline grammar checks: authored input and server-owned construction slots.
 * Actual private writes and replay are exercised against Postgres. */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { buildExecutorTools } from "../executorLoop";

const fields = [{ kind: "text", id: "name", label: "Name", required: true }];
function admits(name: string, input: unknown) {
	const definition = buildExecutorTools()[name];
	const validate = new Ajv({ strict: false }).compile(definition.inputSchema);
	return { valid: validate(input), errors: validate.errors };
}

describe("executor authoring grammar", () => {
	it("accepts content without asking the model to reproduce accepted module and form facts", () => {
		for (const [name, input] of [
			[
				"createModule",
				{ name: "Patients", forms: [{ name: "Register", fields }] },
			],
			["createForm", { moduleUuid: "Patients", name: "Visit", fields }],
			[
				"editField",
				{
					fieldUuid: "age",
					updates: {
						label: "Age in years",
						relevant: "#form/enrolled = 'yes'",
					},
				},
			],
		] as const)
			expect(admits(name, input)).toEqual({ valid: true, errors: null });
	});
	it("rejects storage prose, model handles, and facts the server owns", () => {
		for (const input of [
			{ name: "Patients", moduleUuid: { handle: "@patients" } },
			{ name: "Patients", case_type: "invented" },
			{
				name: "Patients",
				forms: [{ name: "Register", type: "survey", fields }],
			},
			{
				name: "Patients",
				forms: [
					{
						name: "Register",
						fields: [{ ...fields[0], label: { parts: ["Name"] } }],
					},
				],
			},
		])
			expect(admits("createModule", input).valid).toBe(false);
	});
	it("keeps shared references readable without inventing a private lookup language", () => {
		const result = admits("addFields", {
			formUuid: "Visit",
			fields: [
				{
					kind: "single_select",
					id: "clinic",
					label: "Clinic",
					optionsSource: {
						kind: "lookup",
						tableId: "Clinics",
						valueColumnId: "code",
						labelColumnId: "name",
					},
				},
			],
		});
		expect(result).toEqual({ valid: true, errors: null });
	});
	it("accepts a focused catalog repair without exposing storage expressions", () => {
		expect(
			admits("getCaseProperty", { caseType: "plot", property: "beds" }),
		).toEqual({ valid: true, errors: null });
		expect(
			admits("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { validation: ". >= 1 and . <= 50", validation_msg: null },
			}),
		).toEqual({ valid: true, errors: null });
		expect(
			admits("updateCaseProperty", {
				caseType: "plot",
				property: "beds",
				updates: { data_type: "decimal" },
			}).valid,
		).toBe(false);
	});
});
