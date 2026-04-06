/**
 * Tests for the form builder agent's tool integration with MutableBlueprint.
 *
 * These are unit tests that exercise the tool executors directly (no LLM calls).
 * They verify that the form builder's addQuestion, setCloseCaseCondition, and
 * case derivation via case_property_on correctly modify the MutableBlueprint shell.
 */
import { describe, expect, it } from "vitest";
import type { AppBlueprint } from "../../schemas/blueprint";
import { deriveCaseConfig } from "../../schemas/blueprint";
import {
	addQuestion as bpAddQuestion,
	updateForm as bpUpdateForm,
} from "../blueprintHelpers";
import { qpath } from "../questionPath";

/** Create a minimal shell blueprint for form builder testing. */
function makeShell(
	type: "registration" | "followup" | "survey" = "registration",
): AppBlueprint {
	return {
		app_name: "Test App",
		modules: [
			{
				name: "Test Module",
				case_type: type !== "survey" ? "patient" : undefined,
				forms: [{ name: "Test Form", type, questions: [] }],
			},
		],
		case_types:
			type !== "survey"
				? [
						{
							name: "patient",
							properties: [{ name: "case_name", label: "Full Name" }],
						},
					]
				: null,
	};
}

describe("Form Builder Agent Integration", () => {
	describe("addQuestion", () => {
		it("adds a simple text question", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Patient Name",
				case_property_on: "patient",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.questions).toHaveLength(1);
			expect(form.questions[0].id).toBe("case_name");
			expect(form.questions[0].type).toBe("text");
			expect(form.questions[0].case_property_on).toBe("patient");
			// Only explicitly set fields are present
			expect(form.questions[0].hint).toBeUndefined();
			expect(form.questions[0].required).toBeUndefined();
			expect(form.questions[0].options).toBeUndefined();
		});

		it("adds questions in sequence", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, { id: "q1", type: "text", label: "Q1" });
			bpAddQuestion(bp, 0, 0, { id: "q2", type: "int", label: "Q2" });
			bpAddQuestion(bp, 0, 0, { id: "q3", type: "date", label: "Q3" });

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
		});

		it("adds a single_select question with options", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "gender",
				type: "single_select",
				label: "Gender",
				options: [
					{ value: "male", label: "Male" },
					{ value: "female", label: "Female" },
				],
				case_property_on: "patient",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const q = form.questions[0];
			expect(q.options).toHaveLength(2);
			expect(q.options?.[0].value).toBe("male");
		});

		it("adds a hidden calculated question", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, { id: "age", type: "int", label: "Age" });
			bpAddQuestion(bp, 0, 0, {
				id: "age_group",
				type: "hidden",
				calculate: "if(/data/age < 18, 'child', 'adult')",
				case_property_on: "patient",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const q = form.questions.find((q) => q.id === "age_group");
			if (!q) throw new Error("expected age_group question");
			expect(q.type).toBe("hidden");
			expect(q.calculate).toBe("if(/data/age < 18, 'child', 'adult')");
			expect(q.label).toBeUndefined(); // hidden questions have no label
		});

		it("nests questions inside a group", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "demographics",
				type: "group",
				label: "Demographics",
			});
			bpAddQuestion(
				bp,
				0,
				0,
				{ id: "first_name", type: "text", label: "First Name" },
				{ parentPath: qpath("demographics") },
			);
			bpAddQuestion(
				bp,
				0,
				0,
				{ id: "last_name", type: "text", label: "Last Name" },
				{ parentPath: qpath("demographics") },
			);

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.questions).toHaveLength(1);
			expect(form.questions[0].id).toBe("demographics");
			expect(form.questions[0].children).toHaveLength(2);
			expect(form.questions[0].children?.[0].id).toBe("first_name");
			expect(form.questions[0].children?.[1].id).toBe("last_name");
		});

		it("nests questions inside a repeat", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "household_members",
				type: "repeat",
				label: "Household Members",
			});
			bpAddQuestion(
				bp,
				0,
				0,
				{ id: "member_name", type: "text", label: "Member Name" },
				{ parentPath: qpath("household_members") },
			);
			bpAddQuestion(
				bp,
				0,
				0,
				{ id: "member_age", type: "int", label: "Age" },
				{ parentPath: qpath("household_members") },
			);

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const repeat = form.questions[0];
			expect(repeat.type).toBe("repeat");
			expect(repeat.children).toHaveLength(2);
		});

		it("inserts after a specific question", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, { id: "q1", type: "text", label: "Q1" });
			bpAddQuestion(bp, 0, 0, { id: "q3", type: "text", label: "Q3" });
			bpAddQuestion(
				bp,
				0,
				0,
				{ id: "q2", type: "text", label: "Q2" },
				{ afterPath: qpath("q1") },
			);

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
		});

		it("adds a question with relevant condition", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "has_symptoms",
				type: "single_select",
				label: "Has Symptoms?",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			});
			bpAddQuestion(bp, 0, 0, {
				id: "symptom_details",
				type: "text",
				label: "Describe symptoms",
				relevant: "/data/has_symptoms = 'yes'",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const q = form.questions.find((q) => q.id === "symptom_details");
			if (!q) throw new Error("expected symptom_details question");
			expect(q.relevant).toBe("/data/has_symptoms = 'yes'");
		});
	});

	describe("setCloseCaseCondition", () => {
		it("sets unconditional close_case", () => {
			const bp = makeShell("followup");
			bpUpdateForm(bp, 0, 0, { close_case: {} });

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.close_case).toEqual({});
		});

		it("sets conditional close_case", () => {
			const bp = makeShell("followup");
			bpAddQuestion(bp, 0, 0, {
				id: "discharge",
				type: "single_select",
				label: "Discharge?",
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
			});
			bpUpdateForm(bp, 0, 0, {
				close_case: { question: "discharge", answer: "yes" },
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.close_case).toEqual({ question: "discharge", answer: "yes" });
		});
	});

	describe("child case derivation via case_property_on", () => {
		it("derives a child case from case_property_on annotations", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Referral Name",
				case_property_on: "referral",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "referral_reason",
				type: "text",
				label: "Referral Reason",
				case_property_on: "referral",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const config = deriveCaseConfig(form.questions, form.type, "patient", [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Full Name" }],
				},
				{
					name: "referral",
					properties: [{ name: "case_name", label: "Referral Name" }],
				},
			]);

			expect(config.child_cases).toHaveLength(1);
			expect(config.child_cases?.[0].case_type).toBe("referral");
			expect(config.child_cases?.[0].case_name_field).toBe("case_name");
		});

		it("derives multiple child cases from different case_property_on values", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Name A",
				case_property_on: "child_a",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Name B",
				case_property_on: "child_b",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const config = deriveCaseConfig(form.questions, form.type, "patient", [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Full Name" }],
				},
				{
					name: "child_a",
					properties: [{ name: "case_name", label: "Name A" }],
				},
				{
					name: "child_b",
					properties: [{ name: "case_name", label: "Name B" }],
				},
			]);

			expect(config.child_cases).toHaveLength(2);
		});

		it("separates primary and child case properties", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Patient Name",
				case_property_on: "patient",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Referral Name",
				case_property_on: "referral",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "referral_reason",
				type: "text",
				label: "Reason",
				case_property_on: "referral",
			});

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			const config = deriveCaseConfig(form.questions, form.type, "patient", [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Full Name" }],
				},
				{
					name: "referral",
					properties: [{ name: "case_name", label: "Referral Name" }],
				},
			]);

			// Primary case
			expect(config.case_name_field).toBe("case_name");
			// Child case
			expect(config.child_cases).toHaveLength(1);
			expect(config.child_cases?.[0].case_type).toBe("referral");
			expect(config.child_cases?.[0].case_properties).toEqual([
				{ case_property: "referral_reason", question_id: "referral_reason" },
			]);
		});
	});

	describe("complete form shape", () => {
		it("produces a valid BlueprintForm-shaped result", () => {
			const bp = makeShell();
			bpAddQuestion(bp, 0, 0, {
				id: "case_name",
				type: "text",
				label: "Patient Name",
				required: "true()",
				case_property_on: "patient",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "age",
				type: "int",
				label: "Age",
				validation: ". > 0 and . < 150",
				validation_msg: "Age must be between 1 and 149",
				case_property_on: "patient",
			});
			bpAddQuestion(bp, 0, 0, {
				id: "vitals",
				type: "group",
				label: "Vital Signs",
			});
			bpAddQuestion(
				bp,
				0,
				0,
				{
					id: "temperature",
					type: "decimal",
					label: "Temperature (°C)",
					case_property_on: "patient",
				},
				{ parentPath: qpath("vitals") },
			);

			const form = bp.modules[0]?.forms[0];
			if (!form) throw new Error("expected form");
			expect(form.name).toBe("Test Form");
			expect(form.type).toBe("registration");
			expect(form.questions).toHaveLength(3); // case_name, age, vitals (with child)
			expect(form.questions[2].children).toHaveLength(1);

			// Verify required fields are always present, optional fields only when set
			for (const q of form.questions) {
				expect(q).toHaveProperty("id");
				expect(q).toHaveProperty("type");
				// label is set on all these questions
				expect(q).toHaveProperty("label");
			}
		});
	});
});
