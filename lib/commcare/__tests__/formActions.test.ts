/**
 * The form actions Nova writes for HQ's Case Management tab, the basic
 * projection of the form's wire plan: the own case's open or update and its
 * close, the worker's record, and each basic subcase, in the shape the
 * tab's own save writes, so a save leaves them as published. Catches a
 * write HQ's build would put on another case or under another condition,
 * and a preload written where HQ would overwrite a default. What HQ builds
 * from them is the proof lane's to show.
 */
import { describe, expect, it } from "vitest";
import { buildFormActions } from "@/lib/commcare/formActions";
import type { CaseOperation, Form } from "@/lib/domain";
import { concat, eq, literal, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	childCreate,
	type FixtureOptions,
	OP,
	OPT,
	own,
	placementFixture,
	read,
	U,
} from "./placementFixture";

const TARGET = { origin: "https://hq.example", domain: "demo" };

const choice = (field: string, value: string): Expression =>
	({
		kind: "term",
		term: { kind: "choice", field: U(field), options: [OPT(value)] },
	}) as Expression;
const selects = (field: string, value: string): Expression =>
	({
		kind: "multi-select-contains",
		property: read(field),
		values: [{ kind: "choice", field: U(field), options: [OPT(value)] }],
		quantifier: "any",
	}) as Expression;
const workerUpdate = (extra: Partial<CaseOperation> = {}) =>
	({
		uuid: OP("worker"),
		id: "worker",
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [{ property: "age", value: read("age") }],
		...extra,
	}) as CaseOperation;

function actions(
	formType: Form["type"],
	options: FixtureOptions,
	attachmentTarget: typeof TARGET | null = null,
) {
	const { doc, formUuid } = placementFixture(formType, options);
	return buildFormActions(doc, formUuid, attachmentTarget);
}

describe("the own case", () => {
	it("opens a registration's case from the name's trimmed sibling, under its open condition", () => {
		const result = actions("registration", {
			operations: () => [
				own({
					name: read("name"),
					writes: [{ property: "age", value: read("age") }],
				}),
			],
			form: { openCondition: eq(read("status"), choice("status", "yes")) },
		});
		expect(result.open_case.condition).toEqual({
			type: "if",
			question: "/data/status",
			answer: "yes",
			operator: "=",
			doc_type: "FormActionCondition",
		});
		expect(result.open_case.name_update.question_path).toBe(
			"/data/nova_trimmed_name",
		);
		expect(result.open_case.external_id).toBeNull();
		expect(result.update_case.condition.type).toBe("always");
		expect(result.update_case.update).toEqual({
			age: { question_path: "/data/age", update_mode: "always" },
		});
	});

	it("opens a registration's case every time when no open condition is set", () => {
		const result = actions("registration", {
			operations: () => [own({ name: read("name") })],
		});
		expect(result.open_case.condition.type).toBe("always");
	});

	it("updates a loaded case: a rename under `name`, an owner, a write saved only if changed, and one to the case above", () => {
		const result = actions("followup", {
			operations: () => [
				own({
					name: read("name"),
					owner: read("flag"),
					writes: [
						{ property: "age", value: read("age"), onlyIfChanged: true },
						{
							property: "status",
							value: read("status"),
							via: [{ identifier: "parent" }],
						},
					],
				}),
			],
		});
		expect(result.open_case.condition.type).toBe("never");
		expect(result.update_case.condition.type).toBe("always");
		expect(result.update_case.update).toEqual({
			name: { question_path: "/data/nova_trimmed_name", update_mode: "always" },
			owner_id: { question_path: "/data/flag", update_mode: "always" },
			age: { question_path: "/data/age", update_mode: "edit" },
			"parent/status": { question_path: "/data/status", update_mode: "always" },
		});
	});

	it.each(["registration", "followup", "close"] as const)(
		"writes update_case always on a %s form that writes nothing else",
		(formType) => {
			const result = actions(formType, {
				operations: () => [
					own(formType === "registration" ? { name: read("name") } : {}),
				],
			});
			expect(result.update_case.condition.type).toBe("always");
			expect(result.update_case.update).toEqual({});
		},
	);

	it("writes nothing for a registration whose own arm takes Save to Case", () => {
		// A computed name keeps the own arm off Case Management, so the form
		// opens no case and requires none: HQ's build refuses an active update
		// there (`xform.py::XForm._create_casexml`).
		const result = actions("registration", {
			operations: () => [
				own({
					name: concat(read("name"), term(literal(" "))),
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		expect(result.open_case.condition.type).toBe("never");
		expect(result.update_case.condition.type).toBe("never");
		expect(result.update_case.update).toEqual({});
		expect(result.close_case.condition.type).toBe("never");
	});

	it("writes nothing for a survey", () => {
		const result = actions("survey", {});
		expect(result.open_case.condition.type).toBe("never");
		expect(result.update_case.condition.type).toBe("never");
		expect(result.close_case.condition.type).toBe("never");
	});
});

describe("the own close", () => {
	const closing = (closeCondition: Expression | undefined) =>
		actions("close", {
			operations: () => [own()],
			...(closeCondition !== undefined && { form: { closeCondition } }),
		}).close_case.condition;

	it("closes every time when the close form states no condition", () => {
		expect(closing(undefined)).toEqual(
			expect.objectContaining({ type: "always" }),
		);
	});

	it("prints each stateable shape as HQ's page saves it", () => {
		expect(closing(eq(read("status"), choice("status", "yes")))).toEqual({
			type: "if",
			question: "/data/status",
			answer: "yes",
			operator: "=",
			doc_type: "FormActionCondition",
		});
		expect(closing(selects("tags", "red"))).toEqual({
			type: "if",
			question: "/data/tags",
			answer: "red",
			operator: "selected",
			doc_type: "FormActionCondition",
		});
		expect(closing(read("flag"))).toEqual({
			type: "if",
			question: "/data/flag",
			answer: null,
			operator: "boolean_true",
			doc_type: "FormActionCondition",
		});
	});

	it("writes never where the close takes a Save to Case block of its own", () => {
		expect(closing(eq(read("name"), term(literal("x"))))).toEqual(
			expect.objectContaining({ type: "never" }),
		);
	});

	it("closes a registration's new case only where a close condition is set", () => {
		expect(
			actions("registration", {
				operations: () => [own({ name: read("name") })],
			}).close_case.condition.type,
		).toBe("never");
		expect(
			actions("registration", {
				operations: () => [own({ name: read("name") })],
				form: { closeCondition: read("flag") },
			}).close_case.condition,
		).toEqual(expect.objectContaining({ type: "if", question: "/data/flag" }));
	});
});

describe("subcases", () => {
	it("writes each basic subcase at its index, with its condition and a sharing close", () => {
		const result = actions("followup", {
			operations: (formType) => [
				own(),
				childCreate("kid", formType, {
					condition: read("flag"),
					owner: read("flag"),
				}),
				childCreate("row", formType, { repeat: "kids" }),
				{
					uuid: OP("kid-close"),
					id: "kid_close",
					action: "close",
					caseType: "kid",
					target: { kind: "op", opUuid: OP("kid") },
					condition: eq(read("status"), choice("status", "no")),
				} as CaseOperation,
			],
		});
		expect(result.subcases).toEqual([
			{
				doc_type: "OpenSubCaseAction",
				case_type: "kid",
				name_update: {
					question_path: "/data/nova_trimmed_name",
					update_mode: "always",
				},
				reference_id: "",
				case_properties: {
					owner_id: { question_path: "/data/flag", update_mode: "always" },
				},
				repeat_context: "",
				relationship: "child",
				condition: {
					type: "if",
					question: "/data/flag",
					answer: null,
					operator: "boolean_true",
					doc_type: "FormActionCondition",
				},
				close_condition: {
					type: "if",
					question: "/data/status",
					answer: "no",
					operator: "=",
					doc_type: "FormActionCondition",
				},
			},
			expect.objectContaining({
				case_type: "kid",
				repeat_context: "/data/kids",
				name_update: {
					question_path: "/data/kids/nova_trimmed_kid_name",
					update_mode: "always",
				},
				condition: expect.objectContaining({ type: "always" }),
				close_condition: expect.objectContaining({ type: "never" }),
			}),
		]);
	});
});

describe("the worker's record", () => {
	it("writes usercase_update from the worker-record update, on a survey too", () => {
		const result = actions("survey", { operations: () => [workerUpdate()] });
		expect(result.usercase_update).toEqual(
			expect.objectContaining({
				condition: expect.objectContaining({ type: "always" }),
				update: { age: { question_path: "/data/age", update_mode: "always" } },
			}),
		);
	});
});

describe("capture links", () => {
	const linkWrite = () => [
		own({
			writes: [
				{
					property: "photo_url",
					value: {
						kind: "term",
						term: { kind: "capture-link", field: U("photo") },
					} as Expression,
				},
			],
		}),
	];

	it("names the capture's link sibling, never the upload question", () => {
		expect(
			actions("followup", { operations: linkWrite }, TARGET).update_case.update,
		).toEqual({
			photo_url: {
				question_path: "/data/nova_url_photo",
				update_mode: "always",
			},
		});
	});

	it("withholds the link where there is no target to build it against", () => {
		expect(
			actions("followup", { operations: linkWrite }).update_case.update,
		).toEqual({});
	});
});

it("never writes case_preload, for any form type", () => {
	for (const formType of ["registration", "followup", "close"] as const) {
		const result = actions(formType, {
			operations: () => [
				own({
					...(formType === "registration" && { name: read("name") }),
					writes: [{ property: "age", value: read("age") }],
				}),
			],
		});
		expect(result.case_preload.condition.type).toBe("never");
		expect(result.case_preload.preload).toEqual({});
	}
});
