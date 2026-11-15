import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Expression, Uuid } from "@/lib/domain";
import { readMenusOf } from "../../menus/__tests__/menuReading";
import { laterLoadReaders } from "../preloads";
import { type CaseReading, readCases, readFields } from "./caseReading";

/** Every entry a reading claimed something under. */
function entriesOf(reading: CaseReading): string[] {
	return [...reading.ctx.close().claims.records()].map((one) => one.entry);
}

const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const Q = testUuid("q");

function followup(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ name: "Visit", type: "followup", fields }],
			},
		],
	});
}

function readersOf(doc: BlueprintDoc, field: Uuid): string[] {
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	return laterLoadReaders(doc, formUuid, field).map(
		(uuid) => doc.fields[uuid]?.id ?? uuid,
	);
}

describe("laterLoadReaders", () => {
	it("finds a later default that reads the question", () => {
		const doc = followup([
			f({ kind: "text", id: "q", uuid: Q }),
			f({ kind: "text", id: "r", default_value: read(Q) }),
		]);
		expect(readersOf(doc, Q)).toEqual(["r"]);
	});

	it("follows a chain of calculations to a later default", () => {
		const calc = testUuid("calc");
		const doc = followup([
			f({ kind: "text", id: "q", uuid: Q }),
			f({ kind: "hidden", id: "calc", uuid: calc, calculate: read(Q) }),
			f({ kind: "text", id: "r", default_value: read(calc) }),
		]);
		expect(readersOf(doc, Q)).toEqual(["r"]);
	});

	it("finds a default that reads a question under a group whose relevance reads the preloaded one", () => {
		const inner = testUuid("inner");
		const doc = followup([
			f({ kind: "text", id: "q", uuid: Q }),
			f({
				kind: "group",
				id: "g",
				relevant: {
					kind: "eq",
					left: read(Q),
					right: { kind: "term", term: { kind: "literal", value: "y" } },
				},
				children: [f({ kind: "text", id: "inner", uuid: inner })],
			}),
			f({ kind: "text", id: "r", default_value: read(inner) }),
		]);
		expect(readersOf(doc, Q)).toEqual(["r"]);
	});

	it("leaves out a default before the question and one inside a repeat", () => {
		const doc = followup([
			f({ kind: "text", id: "before", default_value: read(Q) }),
			f({ kind: "text", id: "q", uuid: Q }),
			f({
				kind: "repeat",
				id: "rows",
				children: [
					f({ kind: "text", id: "row_value", default_value: read(Q) }),
				],
			}),
			f({
				kind: "text",
				id: "unrelated",
				default_value: { kind: "term", term: { kind: "literal", value: "x" } },
			}),
		]);
		expect(readersOf(doc, Q)).toEqual([]);
	});
});

/** A follow-up form whose stored `case_preload` maps `path` to `property`. */
async function preloaded(fields: FieldSpec[], preload: Record<string, string>) {
	return readCases(followup(fields), {
		edit: (app) => {
			const actions = app.modules[0]?.forms[0]?.actions as Record<
				string,
				unknown
			>;
			actions.case_preload = {
				doc_type: "PreloadAction",
				preload,
				condition: { type: "always", doc_type: "FormActionCondition" },
			};
		},
	});
}

describe("a case preload, read as the question's default", () => {
	it("reads a preload as the default that reads the case's property, in place of an authored one", async () => {
		const reading = await preloaded(
			[
				f({
					kind: "text",
					id: "q",
					uuid: Q,
					default_value: {
						kind: "term",
						term: { kind: "literal", value: "authored" },
					},
				}),
			],
			{ "/data/q": "dob" },
		);
		const form = reading.forms[0];
		const field =
			form?.xform === null || form === undefined
				? undefined
				: readFields(form.xform).find((one) => one.id === "q");
		expect(field?.field.default_value).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "dob" },
		});
		expect(field?.expressions.some((one) => one.slot === "default_value")).toBe(
			false,
		);
		expect(
			reading.findings.filter((one) => one.code.includes("case-preload")),
		).toEqual([]);
		expect(
			reading.ctx.facts.sameStateRewrites.map((one) => one.register),
		).toContain("case-settings-respelled");
	});

	it("reads the case's name for `name`", async () => {
		const reading = await preloaded([f({ kind: "text", id: "q", uuid: Q })], {
			"/data/q": "name",
		});
		const form = reading.forms[0];
		const field =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "q");
		expect(field?.field.default_value).toMatchObject({
			term: { property: "case_name" },
		});
	});

	it("reads a preload into a question inside a repeat as nothing: it fills no row", async () => {
		const reading = await preloaded(
			[
				f({
					kind: "repeat",
					id: "rows",
					children: [f({ kind: "text", id: "q", uuid: Q })],
				}),
			],
			{ "/data/rows/q": "dob" },
		);
		const form = reading.forms[0];
		const field =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "q");
		expect(field?.field.default_value).toBeUndefined();
		expect(
			reading.findings.filter((one) => one.code.includes("case-preload")),
		).toEqual([]);
		const claimed = entriesOf(reading);
		expect(claimed).toContain(
			"forms-and-case-writes/case-preload-into-a-question-inside-a-repeat",
		);
		expect(claimed).not.toContain(
			"forms-and-case-writes/case-preload-question-property-into-a-question-outside-any",
		);
	});

	it("claims a map that reads into a question outside a repeat and one inside under the held row", async () => {
		const reading = await preloaded(
			[
				f({ kind: "text", id: "q", uuid: Q }),
				f({
					kind: "repeat",
					id: "rows",
					children: [f({ kind: "text", id: "row_q" })],
				}),
			],
			{ "/data/q": "dob", "/data/rows/row_q": "dob" },
		);
		const claimed = entriesOf(reading);
		expect(claimed).toContain(
			"forms-and-case-writes/case-preload-question-property-into-a-question-outside-any",
		);
		expect(claimed).not.toContain(
			"forms-and-case-writes/case-preload-into-a-question-inside-a-repeat",
		);
	});

	it("reads a preload in a multi-select child menu as a question with no default, dropping its own", async () => {
		const reading = await readCases(
			buildDoc({
				caseTypes: [
					{ name: "household", properties: [] },
					{ name: "patient", parent_type: "household", properties: [] },
				],
				modules: [
					{
						uuid: "preload-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Register household",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "hh",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						name: "Patients",
						caseType: "patient",
						parentCaseModuleUuid: "preload-households",
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "q",
										uuid: Q,
										default_value: {
											kind: "term",
											term: { kind: "literal", value: "authored" },
										},
									}),
								],
							},
						],
					},
				],
			}),
			{
				parentSelections: true,
				edit: (app) => {
					const details = app.modules[1]?.case_details as {
						short: Record<string, unknown>;
					};
					details.short.multi_select = true;
					const actions = app.modules[1]?.forms[0]?.actions as Record<
						string,
						unknown
					>;
					actions.case_preload = {
						doc_type: "PreloadAction",
						preload: { "/data/q": "dob" },
						condition: { type: "always", doc_type: "FormActionCondition" },
					};
				},
			},
		);
		const form = reading.forms.find((one) => one.form.name === "Visit");
		const field =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "q");
		expect(field?.field.default_value).toBeUndefined();
		expect(field?.expressions.some((one) => one.slot === "default_value")).toBe(
			false,
		);
		expect(entriesOf(reading)).toContain(
			"forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-child",
		);
	});

	it("refuses a preload into a Hidden Value with a calculation, which holds one value source", async () => {
		const reading = await preloaded(
			[
				f({
					kind: "hidden",
					id: "q",
					uuid: Q,
					calculate: { kind: "term", term: { kind: "literal", value: "c" } },
				}),
			],
			{ "/data/q": "dob" },
		);
		expect(reading.findings.map((one) => one.code)).toContain(
			"forms-and-case-writes/case-preload-into-a-question-that-holds-no-default",
		);
	});

	it("refuses a worker-record preload into a Hidden Value with a calculation as a question that holds no default", async () => {
		const reading = await readCases(
			followup([
				f({
					kind: "text",
					id: "mood",
					caseWrite: { caseType: "commcare-user", property: "mood" },
				}),
				f({
					kind: "hidden",
					id: "h",
					calculate: { kind: "term", term: { kind: "literal", value: "c" } },
				}),
			]),
			{
				edit: (app) => {
					const actions = app.modules[0]?.forms[0]?.actions as Record<
						string,
						unknown
					>;
					actions.usercase_preload = {
						doc_type: "PreloadAction",
						preload: { "/data/h": "mood" },
						condition: { type: "always", doc_type: "FormActionCondition" },
					};
				},
			},
		);
		const codes = reading.findings.map((one) => one.code);
		expect(codes).toContain(
			"forms-and-case-writes/case-preload-into-a-question-that-holds-no-default",
		);
		expect(codes).not.toContain(
			"forms-and-case-writes/any-other-usercase-preload",
		);
	});

	describe("a preload a later load-time value reads", () => {
		const HELD_AT_THE_END =
			"forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held";
		async function wholeReading(fields: FieldSpec[]) {
			return readMenusOf(followup(fields), (app) => {
				const actions = app.modules[0]?.forms[0]?.actions as Record<
					string,
					unknown
				>;
				actions.case_preload = {
					doc_type: "PreloadAction",
					preload: { "/data/q": "dob" },
					condition: { type: "always", doc_type: "FormActionCondition" },
				};
			});
		}

		it("raises its entry at not-yet, never as something to change in CommCare HQ, through a calculation", async () => {
			const calc = testUuid("calc");
			const reading = await wholeReading([
				f({ kind: "text", id: "q", uuid: Q }),
				f({ kind: "hidden", id: "calc", uuid: calc, calculate: read(Q) }),
				f({ kind: "text", id: "r", default_value: read(calc) }),
			]);
			const found = reading.findings.filter(
				(one) => one.code === HELD_AT_THE_END,
			);
			expect(found).toHaveLength(1);
			expect(
				found[0] && "standing" in found[0] ? found[0].standing : undefined,
			).toBe("not-yet");
		});

		it("raises its entry through a group whose relevance reads the question", async () => {
			const inner = testUuid("inner");
			const reading = await wholeReading([
				f({ kind: "text", id: "q", uuid: Q }),
				f({
					kind: "group",
					id: "g",
					relevant: {
						kind: "eq",
						left: read(Q),
						right: { kind: "term", term: { kind: "literal", value: "y" } },
					},
					children: [f({ kind: "text", id: "inner", uuid: inner })],
				}),
				f({ kind: "text", id: "r", default_value: read(inner) }),
			]);
			expect(reading.findings.map((one) => one.code)).toContain(
				HELD_AT_THE_END,
			);
		});

		it("reads, with no finding, where no later default reads it", async () => {
			const reading = await wholeReading([
				f({ kind: "text", id: "q", uuid: Q }),
				f({
					kind: "text",
					id: "r",
					default_value: {
						kind: "term",
						term: { kind: "literal", value: "x" },
					},
				}),
			]);
			expect(reading.findings.map((one) => one.code)).not.toContain(
				HELD_AT_THE_END,
			);
		});
	});

	describe("a worker-record preload, read as HQ's build reads the worker's case", () => {
		const ANY_OTHER = "forms-and-case-writes/any-other-usercase-preload";
		async function workerPreload(property: string) {
			const reading = await readMenusOf(
				followup([
					f({
						kind: "text",
						id: "mood",
						caseWrite: { caseType: "commcare-user", property: "mood" },
					}),
					f({ kind: "text", id: "q", uuid: Q }),
				]),
				(app) => {
					const actions = app.modules[0]?.forms[0]?.actions as Record<
						string,
						unknown
					>;
					actions.usercase_preload = {
						doc_type: "PreloadAction",
						preload: { "/data/q": property },
						condition: { type: "always", doc_type: "FormActionCondition" },
					};
				},
			);
			const field = Object.values(reading.doc?.fields ?? {}).find(
				(one) => one.id === "q",
			) as { readonly default_value?: unknown } | undefined;
			return { reading, field };
		}

		it("reads a property of the worker's own as its worker property", async () => {
			const { reading, field } = await workerPreload("mood");
			expect(reading.findings).toEqual([]);
			const [property] = Object.values(reading.doc?.userProperties ?? {});
			expect(property?.slug).toBe("mood");
			expect(field?.default_value).toEqual({
				kind: "term",
				term: {
					kind: "session-user-property",
					userPropertyUuid: property?.uuid,
					source: "worker-record",
				},
			});
		});

		it("reads `name` as the worker case's name, as HQ's build maps it, and mints no worker property", async () => {
			const { reading, field } = await workerPreload("name");
			expect(reading.findings).toEqual([]);
			expect(
				Object.values(reading.doc?.userProperties ?? {}).map((one) => one.slug),
			).toEqual([]);
			expect(field?.default_value).toEqual({
				kind: "term",
				term: {
					kind: "session-user",
					field: "case_name",
					source: "worker-record",
				},
			});
		});

		it("refuses `owner_id`, which HQ reads as the case's attribute, and a reserved word HQ's build refuses", async () => {
			for (const property of ["owner_id", "date_opened", "case_name"]) {
				const { reading, field } = await workerPreload(property);
				expect(
					reading.findings.map((one) => one.code),
					property,
				).toContain(ANY_OTHER);
				expect(field?.default_value, property).toBeUndefined();
			}
		});

		it("refuses a path through an index, which HQ reads from an ancestor of the worker's case, and a name Nova's worker read cannot spell", async () => {
			// HQ's grammar takes both (`validate_property` allows parents, and Python's `\w` any letter).
			for (const property of ["parent/mood", "moodé"]) {
				const { reading, field } = await workerPreload(property);
				expect(
					reading.findings.map((one) => one.code),
					property,
				).toContain(ANY_OTHER);
				expect(field?.default_value, property).toBeUndefined();
			}
		});
	});

	it("refuses a property HQ's build refuses, which it would otherwise read as the case's attribute", async () => {
		// HQ's validator reads every preloaded property (`FormActions.all_property_names` →
		// `check_case_properties`) and refuses the form; `status` and `case_id` would otherwise
		// read as Nova's `@status` and `@case_id`, where HQ's build reads child elements.
		const REFUSED =
			"forms-and-case-writes/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json";
		for (const property of [
			"status",
			"case_id",
			"parent/date_opened",
			"date-opened",
			"dob+1",
		]) {
			const reading = await preloaded([f({ kind: "text", id: "q", uuid: Q })], {
				"/data/q": property,
			});
			const found = reading.findings.find((one) => one.code === REFUSED);
			expect(found, property).toBeDefined();
			expect(found?.detail?.name).toBe(property);
		}
		// `owner_id` is no reserved word of HQ's, which reads it as `@owner_id`.
		const owner = await preloaded([f({ kind: "text", id: "q", uuid: Q })], {
			"/data/q": "owner_id",
		});
		expect(owner.findings.map((one) => one.code)).not.toContain(REFUSED);
		const form = owner.forms[0];
		const field =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "q");
		expect(field?.field.default_value).toMatchObject({
			term: { kind: "form-case", property: "owner_id" },
		});
	});

	it("refuses a preload from a host or user path", async () => {
		const reading = await preloaded([f({ kind: "text", id: "q", uuid: Q })], {
			"/data/q": "host/dob",
		});
		const found = reading.findings.find(
			(one) =>
				one.code ===
				"forms-and-case-writes/case-preload-from-any-other-index-path-host-user-a-mixed-path",
		);
		expect(found).toBeDefined();
		expect(found && "standing" in found ? found.standing : undefined).toBe(
			"not-yet",
		);
	});
});

describe("a case preload on a form that requires no case", () => {
	async function onSurvey(preload: Record<string, string>) {
		return readCases(
			buildDoc({
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								name: "Feedback",
								type: "survey",
								fields: [f({ kind: "text", id: "q", uuid: Q })],
							},
						],
					},
				],
			}),
			{
				edit: (app) => {
					const actions = app.modules[0]?.forms[0]?.actions as Record<
						string,
						unknown
					>;
					actions.case_preload = {
						doc_type: "PreloadAction",
						preload,
						condition: { type: "always", doc_type: "FormActionCondition" },
					};
				},
			},
		);
	}
	const REFUSED =
		"forms-and-case-writes/case-preload-on-a-requires-none-form-naming-a-reserved-or";
	const INERT =
		"forms-and-case-writes/case-preload-active-on-a-requires-none-form-naming-valid";

	it("drops a map whose properties HQ's grammar holds, its index steps included", async () => {
		for (const property of ["parent/dob", "owner_id"]) {
			const reading = await onSurvey({ "/data/q": property });
			expect(reading.findings.map((one) => one.code)).not.toContain(REFUSED);
			expect(entriesOf(reading)).toContain(INERT);
		}
	});

	it("refuses a property outside HQ's grammar and one whose last step is a reserved word", async () => {
		for (const property of ["dob+1", "parent/2nd", "parent/case_id"]) {
			const reading = await onSurvey({ "/data/q": property });
			expect(reading.findings.map((one) => one.code)).toContain(REFUSED);
		}
	});
});
