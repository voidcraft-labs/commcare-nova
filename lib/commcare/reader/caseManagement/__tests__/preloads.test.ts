import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Expression, Uuid } from "@/lib/domain";
import { codesOf, readMenusOf } from "../../menus/__tests__/menuReading";
import {
	hqBuildRefusesProperty,
	laterLoadReaders,
	preloadReadOf,
} from "../preloads";
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

/**
 * A `parent/` preload, which HQ's build reads through the case's `parent`
 * index (`xform.py::XForm.add_case_preloads`), against the read of the
 * household Nova prints, which walks the index the app links a patient to its
 * household by (`caseTypeDepths.ts::caseTypeHopMap`). The failure this
 * catches: a preload read as a household read that walks another index, a
 * silent misread of the case HQ loads.
 */
describe("a case preload through `parent`, against the index the app links by", () => {
	const OTHER_CASE =
		"forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix";
	const NAME = testUuid("parent-preload-name");
	/** Households whose follow-up registers a patient linked to it as
	 *  `identifier`, and patients whose follow-up preloads the household's remark. */
	const households = (identifier: string) =>
		buildDoc(
			{
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "remark", label: "Remark" }],
					},
					{
						name: "patient",
						parent_type: "household",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Add patient",
								type: "followup",
								fields: [f({ kind: "text", id: "nm", uuid: NAME })],
							},
						],
					},
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "q", uuid: Q })],
							},
						],
					},
				],
			},
			(doc) => {
				const add = doc.formOrder[doc.moduleOrder[0] as Uuid]?.[0] as Uuid;
				doc.forms[add] = {
					...doc.forms[add],
					caseOperations: [
						{
							uuid: testUuid("parent-preload-create"),
							id: "patient",
							action: "create",
							caseType: "patient",
							target: { kind: "new" },
							name: read(NAME),
							links: [
								{
									identifier,
									targetType: "household",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						},
					],
				} as never;
			},
		);
	const withPreload = (doc: BlueprintDoc) =>
		readMenusOf(doc, (app) => {
			const actions = app.modules[1]?.forms[0]?.actions as Record<
				string,
				unknown
			>;
			actions.case_preload = {
				doc_type: "PreloadAction",
				preload: { "/data/q": "parent/remark" },
				condition: { type: "always", doc_type: "FormActionCondition" },
			};
		});
	const qDefault = (doc: BlueprintDoc | undefined) =>
		(
			Object.values(doc?.fields ?? {}).find((field) => field.id === "q") as
				| { readonly default_value?: unknown }
				| undefined
		)?.default_value;

	it("reads it as the household's read where the app links a patient by `parent`", async () => {
		const reading = await withPreload(households("parent"));
		expect(codesOf(reading)).toEqual([]);
		expect(qDefault(reading.doc)).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "household", property: "remark" },
		});
	});

	it("refuses it where the app links a patient by another index, which the household's read walks", async () => {
		const reading = await withPreload(households("home"));
		expect(codesOf(reading)).toContain(OTHER_CASE);
		expect(reading.outcome.defects).toEqual([]);
	});
});

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

		it("reads `name` as the worker case's name, as HQ's build maps it, and mints no worker property for it", async () => {
			const { reading, field } = await workerPreload("name");
			expect(reading.findings).toEqual([]);
			// The one worker property is the one the form's write of the worker's
			// record saves to, which the gate holds to a declared property.
			expect(
				Object.values(reading.doc?.userProperties ?? {}).map((one) => one.slug),
			).toEqual(["mood"]);
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

/**
 * A preloaded property ending in one newline. HQ's validator matches with
 * Python's `re.match` and a pattern ending in `$`, which also matches before a
 * newline that ends the text (`helpers/validators.py::validate_property`), so
 * HQ's build takes the name and writes it into the load's XPath as it is
 * (`xform.py::XForm.add_case_preloads`), where Core's lexer drops the newline:
 * CommCare reads the child element of the name without it. The failures this
 * catches: such an app refused as one HQ's build refuses, and a name HQ maps
 * without the newline (`name`, `owner_id`) read as the mapped value.
 */
describe("a preloaded property HQ's grammar takes for its one trailing newline", () => {
	const UNNAMED =
		"expressions-and-data/a-form-expression-outside-what-nova-types";
	const ILLEGAL =
		"forms-and-case-writes/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json";

	it("is HQ's grammar exactly: one newline at the very end, index steps included", () => {
		for (const property of ["dob\n", "parent/dob\n", "status\n"])
			expect(hqBuildRefusesProperty(property), property).toBe(false);
		for (const property of ["dob\n\n", "parent\n/dob", "\ndob", "status"])
			expect(hqBuildRefusesProperty(property), property).toBe(true);
		expect(preloadReadOf("parent/dob\n")).toEqual({
			indices: ["parent"],
			name: "dob",
		});
		expect(preloadReadOf("name")).toEqual({ indices: [], name: "case_name" });
	});

	// One document for every reading, so two readings differ only by the stored map.
	const visit = followup([f({ kind: "text", id: "q", uuid: Q })]);
	async function wholeReading(property: string) {
		return readMenusOf(visit, (app) => {
			const actions = app.modules[0]?.forms[0]?.actions as Record<
				string,
				unknown
			>;
			actions.case_preload = {
				doc_type: "PreloadAction",
				preload: { "/data/q": property },
				condition: { type: "always", doc_type: "FormActionCondition" },
			};
		});
	}

	function defaultOf(reading: Awaited<ReturnType<typeof wholeReading>>) {
		return (
			Object.values(reading.doc?.fields ?? {}).find((one) => one.id === "q") as
				| { readonly default_value?: unknown }
				| undefined
		)?.default_value;
	}

	it("reads the property CommCare reads, the document a preload of the name without it gives", async () => {
		for (const [stored, plain, property] of [
			["dob\n", "dob", "dob"],
			// HQ reserves `case_name`, and reads `case_name\n` from the case's own name element.
			["case_name\n", "name", "case_name"],
		] as const) {
			const reading = await wholeReading(stored);
			expect(reading.findings, stored).toEqual([]);
			expect(reading.outcome.defects, stored).toEqual([]);
			expect(defaultOf(reading), stored).toEqual({
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property },
			});
			const without = await wholeReading(plain);
			expect(without.findings, plain).toEqual([]);
			expect(reading.doc, stored).toEqual(without.doc);
		}
	});

	it("reads `date_opened` and `last_modified` with the newline as the case's own child elements, which Nova names", async () => {
		// HQ reserves both names, so no plain twin exists: CommCare reads the case's
		// `date_opened` and `last_modified` children (`CaseChildElement`), which Nova's
		// `form-case` read of each prints, and the checker admits as the question's default.
		for (const property of ["date_opened", "last_modified"]) {
			const stored = `${property}\n`;
			const reading = await wholeReading(stored);
			expect(reading.findings, property).toEqual([]);
			expect(reading.outcome.defects, property).toEqual([]);
			expect(reading.doc, property).toBeDefined();
			expect(defaultOf(reading), property).toEqual({
				kind: "term",
				term: { kind: "form-case", caseType: "patient", property },
			});
			// Nova's own document holding that default reads back to the same document.
			const own = produce(visit, (draft) => {
				const field = draft.fields[Q] as { default_value?: unknown };
				field.default_value = {
					kind: "term",
					term: { kind: "form-case", caseType: "patient", property },
				};
			});
			const ownReading = await readMenusOf(own);
			expect(ownReading.findings, property).toEqual([]);
			expect(ownReading.outcome.defects, property).toEqual([]);
			expect(reading.doc, property).toEqual(ownReading.doc);
			// The plain name is HQ's reserved word, which its build refuses.
			const plain = await wholeReading(property);
			expect(
				plain.findings.map((one) => one.code),
				property,
			).toContain(ILLEGAL);
		}
	});

	it("refuses a name whose element no property name of Nova's names, as Nova's limit", async () => {
		// HQ's build maps none of these with the newline, so CommCare reads the child element
		// `name`, `owner_id`, `status` or `type`, where Nova reads `case_name`, `@owner_id` and
		// `@status`, and holds no property `type`.
		for (const property of ["name\n", "owner_id\n", "status\n", "type\n"]) {
			const reading = await wholeReading(property);
			expect(reading.outcome.defects, property).toEqual([]);
			const codes = reading.findings.map((one) => one.code);
			expect(codes, property).not.toContain(ILLEGAL);
			const found = reading.findings.find((one) => one.code === UNNAMED);
			expect(found, property).toBeDefined();
			expect(found?.detail?.name).toBe(property);
			expect(found?.detail?.reason).toBe("name:case-property");
			expect(found && "standing" in found ? found.standing : undefined).toBe(
				"not-yet",
			);
		}
	});

	it("still refuses two newlines, which HQ's grammar does not take", async () => {
		const reading = await wholeReading("dob\n\n");
		expect(reading.findings.map((one) => one.code)).toContain(ILLEGAL);
	});

	it("reads a worker-record preload of such a name as the worker property of the name without it", async () => {
		const workerVisit = followup([
			f({
				kind: "text",
				id: "mood",
				caseWrite: { caseType: "commcare-user", property: "mood" },
			}),
			f({ kind: "text", id: "q", uuid: Q }),
		]);
		async function workerPreload(property: string) {
			return readMenusOf(workerVisit, (app) => {
				const actions = app.modules[0]?.forms[0]?.actions as Record<
					string,
					unknown
				>;
				actions.usercase_preload = {
					doc_type: "PreloadAction",
					preload: { "/data/q": property },
					condition: { type: "always", doc_type: "FormActionCondition" },
				};
			});
		}
		const reading = await workerPreload("mood\n");
		const plain = await workerPreload("mood");
		expect(reading.findings).toEqual([]);
		expect(reading.doc).toEqual(plain.doc);
		// `name\n` reads the worker case's element `name`, never its case name.
		const named = await workerPreload("name\n");
		expect(named.findings.map((one) => one.code)).toContain(
			"forms-and-case-writes/any-other-usercase-preload",
		);
	});
});
