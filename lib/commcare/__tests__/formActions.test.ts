/**
 * The form actions Nova writes for HQ's Case Management tab: the shape the
 * tab's own save writes, so a save leaves them as published. What HQ builds
 * from them is the proof lane's to show.
 */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildFormActions } from "@/lib/commcare/formActions";
import { type FormType, proseText } from "@/lib/domain";

function app(
	type: FormType,
	options: {
		caseType?: string;
		closeCondition?: { field: string; answer: string };
		fields?: ReturnType<typeof f>[];
	} = {},
) {
	const doc = buildDoc({
		appName: "Form actions",
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "external_id"].map((name) => ({
					name,
					label: proseText(name),
				})),
			},
		],
		modules: [
			{
				name: "Patients",
				...(options.caseType !== undefined && {
					caseType: options.caseType,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						name: "Record",
						type,
						fields: options.fields ?? [f({ kind: "text", id: "note" })],
						...(options.closeCondition !== undefined && {
							closeCondition: options.closeCondition,
						}),
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return buildFormActions(doc, formUuid, options.caseType);
}

const nameField = f({
	kind: "text",
	id: "name",
	caseWrite: { caseType: "patient", property: "case_name" },
});

it.each(["registration", "followup", "close"] as const)(
	"writes update_case always on a %s form that writes nothing else",
	(type) => {
		const actions = app(type, {
			caseType: "patient",
			...(type === "registration" && { fields: [nameField] }),
		});
		expect(actions.update_case.condition.type).toBe("always");
		expect(actions.update_case.update).toEqual({});
	},
);

it("writes update_case never on a survey and on a form of a menu with no case type", () => {
	expect(
		app("survey", { caseType: "patient" }).update_case.condition.type,
	).toBe("never");
	expect(app("followup").update_case.condition.type).toBe("never");
});

it("writes an external id as an update row naming the trimmed sibling", () => {
	const actions = app("registration", {
		caseType: "patient",
		fields: [
			nameField,
			f({
				kind: "text",
				id: "external",
				caseWrite: { caseType: "patient", property: "external_id" },
			}),
		],
	});
	expect(actions.open_case.external_id).toBeNull();
	expect(actions.open_case.name_update.question_path).toBe(
		"/data/nova_trimmed_name",
	);
	expect(actions.update_case.update).toEqual({
		external_id: {
			question_path: "/data/nova_trimmed_external",
			update_mode: "always",
		},
	});
});

it("writes close_case never for a condition the Case Management tab cannot state, and if for one it can", () => {
	const select = f({
		kind: "single_select",
		id: "outcome",
		optionsSource: {
			kind: "inline",
			options: ["done", "moved"].map((value) => ({
				value,
				label: proseText(value),
				uuid: testUuid(`form-actions-${value}`),
			})),
		},
	});
	expect(
		app("close", {
			caseType: "patient",
			fields: [f({ kind: "text", id: "outcome" })],
			closeCondition: { field: "outcome", answer: "done" },
		}).close_case.condition.type,
	).toBe("never");
	expect(
		app("close", {
			caseType: "patient",
			fields: [select],
			closeCondition: { field: "outcome", answer: "done" },
		}).close_case.condition,
	).toMatchObject({ type: "if", question: "/data/outcome", answer: "done" });
	expect(app("close", { caseType: "patient" }).close_case.condition.type).toBe(
		"always",
	);
});
