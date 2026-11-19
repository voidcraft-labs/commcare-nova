import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Expression,
	NEW_APP_SETTINGS,
	plainColumn,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { clockKeepingJoin } from "@/lib/domain/expression/datePattern";
import { proseText } from "@/lib/domain/prose";
import type { Finding } from "@/lib/publish/hqFindings";
import { caseListOf } from "../../../../../proof/targeted/build";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { entriesAt } from "../../__tests__/readerInput";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import {
	codesOf,
	readMenusOf as readMenusOfUnheld,
} from "../../menus/__tests__/menuReading";
import {
	type AppJson,
	type CaseReading,
	readCases as readCasesOf,
	readFields,
} from "./caseReading";

const F = "forms-and-case-writes";

/** The case management findings of a reading, its own `unrecognized` left out. */
function caseCodes(findings: readonly Finding[]): string[] {
	return findings
		.map((one) => one.code)
		.filter((code) => code.startsWith(`${F}/`) || code.startsWith("questions/"))
		.sort();
}

/** Each `unrecognized` finding of a reading, by its surface key and its place
 *  (`<surface key> at <place kind>`, then a question's path). */
function unrecognizedOf(findings: readonly Finding[]): string[] {
	return findings
		.filter((one) => one.code === "unrecognized")
		.map((one) => {
			const path = (one.place as { path?: string }).path;
			return `${(one.detail as { name?: string }).name} at ${one.place.kind}${path === undefined ? "" : ` ${path}`}`;
		});
}

/**
 * Every source a stage reading here reads is also read whole, and the whole
 * account is the stage's: the same case management findings, no reader
 * defect, and no `unrecognized` finding beyond `unrecognized` (each as
 * `unrecognizedOf` names it). The plausible failure: a source the stage holds
 * whose whole reading gives a lone `unrecognized` at the form's actions,
 * which the settle's comparison raises where the stage never compares.
 */
function holdWhole(reading: CaseReading, unrecognized: string[] = []): void {
	const whole = reading.whole;
	if (whole === undefined)
		throw new Error("Every source here is read whole: none is told tables.");
	expect(whole.defects).toEqual([]);
	const findings = whole.kind === "account" ? whole.findings : [];
	expect(unrecognizedOf(findings)).toEqual(unrecognized);
	expect(caseCodes(findings)).toEqual(caseCodes(reading.findings));
}

/** A stage reading whose whole reading gives the account `holdWhole` asks. */
const readCasesHolding = (unrecognized: string[]) =>
	namingFromHqPages(async (...args: Parameters<typeof readCasesOf>) => {
		const reading = await readCasesOf(...args);
		holdWhole(reading, unrecognized);
		return reading;
	});

const readCases = readCasesHolding([]);

/** A whole reading, held to give no reader defect and no `unrecognized`
 *  finding: each source here is one whose every use the reader accounts. */
async function readMenusOf(
	...args: Parameters<typeof readMenusOfUnheld>
): ReturnType<typeof readMenusOfUnheld> {
	const reading = await readMenusOfUnheld(...args);
	expect(reading.outcome.defects).toEqual([]);
	expect(unrecognizedOf(reading.findings)).toEqual([]);
	return reading;
}

function app(
	forms: FormSpec[],
	extra: { name: string; caseType: string; forms: FormSpec[] }[] = [],
): BlueprintDoc {
	return buildDoc({
		modules: [{ name: "Patients", caseType: "patient", forms }, ...extra],
	});
}

const visit: FormSpec = {
	name: "Visit",
	type: "followup",
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
		f({ kind: "text", id: "other" }),
	],
};

const registration: FormSpec = {
	name: "Register",
	type: "registration",
	fields: [
		f({
			kind: "text",
			id: "name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
	],
};

/** A follow-up that also saves an answer to the worker's own record (`usercase_update`). */
const workerVisit: FormSpec = {
	name: "Visit",
	type: "followup",
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
		f({
			kind: "text",
			id: "mood",
			caseWrite: { caseType: "commcare-user", property: "mood" },
		}),
	],
};

/** Sets the mode of every row of the worker's record update, as HQ's Case Management page stores it. */
function setUsercaseMode(json: AppJson, mode: string): void {
	const usercase = actionsOf(json).usercase_update as Record<string, unknown>;
	const update = usercase.update as Record<string, Record<string, unknown>>;
	if (Object.keys(update).length === 0)
		throw new Error("The form saves to the worker's record.");
	for (const row of Object.values(update)) row.update_mode = mode;
}

function actionsOf(
	app: AppJson,
	module = 0,
	form = 0,
): Record<string, Record<string, unknown>> {
	return app.modules[module]?.forms[form]?.actions as Record<
		string,
		Record<string, unknown>
	>;
}

/** HQ's Case Management names a created case's question itself, with no trimmed sibling. */
function nameQuestionDirectly(app: AppJson): void {
	const open = actionsOf(app).open_case as Record<string, unknown>;
	open.name_update = { question_path: "/data/name", update_mode: "always" };
}

function codes(reading: { findings: readonly { code: string }[] }): string[] {
	return reading.findings
		.map((one) => one.code)
		.filter(
			(code) => code.startsWith(`${F}/`) || code.startsWith("questions/"),
		);
}

/** Every entry a reading claimed something under. */
function entries(reading: Awaited<ReturnType<typeof readCases>>): string[] {
	return [...reading.ctx.close().claims.records()].map((one) => one.entry);
}

function ownWrites(reading: Awaited<ReturnType<typeof readCases>>) {
	return (
		reading.forms[0]?.form.caseOperations?.find((one) => one.action === "own")
			?.writes ?? []
	);
}

describe("CommCare HQ's spellings of a basic form's case actions", () => {
	it("reads `update_case.condition: if` as always, and records the respelling", async () => {
		const reading = await readCases(app([visit]), {
			edit: (json) => {
				actionsOf(json).update_case.condition = {
					type: "if",
					question: "/data/other",
					answer: "x",
					operator: "=",
					doc_type: "FormActionCondition",
				};
			},
		});
		expect(ownWrites(reading).map((one) => one.property)).toEqual(["notes"]);
		expect(codes(reading)).toEqual([]);
		expect(reading.ctx.facts.sameStateRewrites).toContainEqual(
			expect.objectContaining({ register: "case-settings-respelled" }),
		);
	});

	// HQ's Case Management page saves every condition that is not `if` with its
	// operator null (`forms/case_config_ui.js::cleanCondition`) and `case_preload`
	// as `always` whatever it loads, where a form HQ creates, and Nova, hold `=`
	// and `never`. No build reads either (`xform.py::XForm.action_relevance`,
	// `PreloadAction.is_active`), and the first publish writes Nova's spelling.
	it("records the conditions HQ's Case Management page saves as respelled, and none on Nova's own", async () => {
		const pageCondition = (type: string) => ({
			type,
			question: null,
			answer: null,
			operator: null,
			doc_type: "FormActionCondition",
		});
		const respelled = (reading: CaseReading) =>
			reading.ctx.facts.sameStateRewrites
				.filter(
					(one) =>
						one.path.endsWith("/operator") ||
						one.path.endsWith("/case_preload/condition"),
				)
				.map((one) => [one.path, one.register]);
		const saved = await readCases(app([registration]), {
			edit: (json) => {
				const actions = actionsOf(json);
				actions.open_case.condition = pageCondition("always");
				actions.update_case.condition = pageCondition("always");
				actions.close_case.condition = pageCondition("never");
				actions.case_preload = {
					doc_type: "PreloadAction",
					preload: {},
					condition: pageCondition("always"),
				};
			},
		});
		expect(codes(saved)).toEqual([]);
		const at = "/modules/0/forms/0/actions";
		expect(respelled(saved).sort()).toEqual(
			[
				[`${at}/case_preload/condition`, "case-settings-respelled"],
				[`${at}/close_case/condition/operator`, "case-settings-respelled"],
				[`${at}/open_case/condition/operator`, "case-settings-respelled"],
				[`${at}/update_case/condition/operator`, "case-settings-respelled"],
			].sort(),
		);
		const own = await readCases(app([registration]));
		expect(respelled(own)).toEqual([]);
	});

	// HQ's build copies a value an update names straight into a case block leaf
	// it binds with no type, so a Hidden Value bound `xsd:dateTime` saves its
	// day alone there (Core's `Recalculate.wrapData`), while Nova saves a date
	// and time through its `nova_datetime_` sibling, which keeps the moment.
	it("refuses a Hidden Value bound `xsd:dateTime` that an update names straight, and reads it through Nova's sibling", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "seen_at",
							label: proseText("Seen"),
							data_type: "datetime",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "seen",
									calculate: "now()",
									caseWrite: { caseType: "patient", property: "seen_at" },
								}),
							],
						},
					],
				},
			],
		});
		const STRAIGHT = `${F}/a-datetime-question-saved-straight-to-a-case`;
		const throughSibling = await readCases(doc);
		expect(codes(throughSibling)).toEqual([]);
		const straight = await readCases(doc, {
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					Record<string, unknown>
				>;
				expect(update.seen_at?.question_path).toBe("/data/nova_datetime_seen");
				(update.seen_at as Record<string, unknown>).question_path =
					"/data/seen";
			},
		});
		expect(codes(straight)).toContain(STRAIGHT);
	});

	it("reads `open_case.external_id` as the external id write", async () => {
		const reading = await readCases(app([registration]), {
			edit: (json) => {
				nameQuestionDirectly(json);
				(actionsOf(json).open_case as Record<string, unknown>).external_id =
					"/data/notes";
			},
		});
		expect(ownWrites(reading).map((one) => one.property)).toContain(
			"external_id",
		);
	});

	it("with the source project space's flag on, reads `edit` on a follow-up's property as onlyIfChanged", async () => {
		const reading = await readCases(app([visit]), {
			saveOnlyEditedApplied: true,
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					Record<string, unknown>
				>;
				(update.notes as Record<string, unknown>).update_mode = "edit";
			},
		});
		expect(ownWrites(reading)[0]).toMatchObject({
			property: "notes",
			onlyIfChanged: true,
		});
		expect(codes(reading)).toEqual([]);
	});

	it("with the flag on, refuses `edit` on a registration's update and on the name key", async () => {
		const onUpdate = await readCases(app([registration]), {
			saveOnlyEditedApplied: true,
			edit: (json) => {
				nameQuestionDirectly(json);
				const update = actionsOf(json).update_case.update as Record<
					string,
					Record<string, unknown>
				>;
				(update.notes as Record<string, unknown>).update_mode = "edit";
			},
		});
		expect(codes(onUpdate)).toContain(
			`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		);
		const onName = await readCases(app([visit]), {
			saveOnlyEditedApplied: true,
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					unknown
				>;
				update.name = { question_path: "/data/other", update_mode: "edit" };
			},
		});
		expect(codes(onName)).toContain(
			`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		);
	});

	it("with the flag off, reads `edit` as saved every time everywhere and raises nothing", async () => {
		const followup = await readCases(app([visit]), {
			saveOnlyEditedApplied: false,
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					Record<string, unknown>
				>;
				(update.notes as Record<string, unknown>).update_mode = "edit";
			},
		});
		expect(ownWrites(followup)[0]?.onlyIfChanged).toBeUndefined();
		expect(followup.ctx.facts.sameStateRewrites).toContainEqual(
			expect.objectContaining({ register: "case-settings-respelled" }),
		);
		const onRegistration = await readCases(app([registration]), {
			saveOnlyEditedApplied: false,
			edit: (json) => {
				nameQuestionDirectly(json);
				const update = actionsOf(json).update_case.update as Record<
					string,
					Record<string, unknown>
				>;
				(update.notes as Record<string, unknown>).update_mode = "edit";
			},
		});
		expect(codes(onRegistration)).toEqual([]);
		expect(entries(onRegistration)).toContain(
			`${F}/update-mode-edit-in-a-project-space-that-saves-every-time`,
		);
	});

	it("reads back a created case's question with no required of its own, and claims HQ's", async () => {
		const reading = await readCases(app([registration]), {
			edit: nameQuestionDirectly,
		});
		const form = reading.forms[0];
		const name =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "name");
		expect(name?.field.required).toBeUndefined();
		const records = [...reading.ctx.close().claims.records()].map(
			(one) => one.entry,
		);
		expect(records).toContain(
			"questions/bind-required-on-the-question-that-names-a-created-case",
		);
	});

	it("keeps a required on a Hidden Value that names a created case: HQ's build stamps none there", async () => {
		const hiddenName: FormSpec = {
			name: "Register",
			type: "registration",
			fields: [
				f({
					kind: "hidden",
					id: "name",
					calculate: { kind: "term", term: { kind: "literal", value: "x" } },
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
			],
		};
		// The bind's `required` is left where it stands, for the rules of the
		// question's own logic: here, with nothing else reading it, unclaimed,
		// in the whole reading as in the stage's.
		const reading = await readCasesHolding([
			"xform:bind@required at question name",
		])(app([hiddenName]), {
			edit: nameQuestionDirectly,
			editSource: (xml) =>
				xml.replace(
					'nodeset="/data/name"',
					'nodeset="/data/name" required="true()"',
				),
		});
		const records = [...reading.ctx.close().claims.records()].map(
			(one) => one.entry,
		);
		expect(records).not.toContain(
			"questions/bind-required-on-the-question-that-names-a-created-case",
		);
		const form = reading.forms[0];
		const name =
			form?.xform == null
				? undefined
				: readFields(form.xform).find((one) => one.id === "name");
		expect(name?.kind).toBe("hidden");
		// The bind's `required` is left where it stands, for the rules of the
		// question's own logic: here, with nothing else reading it, unclaimed.
		expect(
			reading.findings.filter(
				(one) =>
					one.code === "unrecognized" &&
					(one.place as { path?: string }).path === "name" &&
					(one.detail as { name?: string }).name === "xform:bind@required",
			),
		).toHaveLength(1);
	});

	it("with the flag on, refuses `edit` on the worker's record", async () => {
		const worker = await readCases(app([workerVisit]), {
			saveOnlyEditedApplied: true,
			edit: (json) => setUsercaseMode(json, "edit"),
		});
		expect(codes(worker)).toContain(
			`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
		);
	});

	it("with the flag off, claims `edit` on the name key, the worker's record and a child case's property inert", async () => {
		const inert = `${F}/update-mode-edit-in-a-project-space-that-saves-every-time`;
		const readings = [
			await readCases(app([visit]), {
				saveOnlyEditedApplied: false,
				edit: (json) => {
					const update = actionsOf(json).update_case.update as Record<
						string,
						unknown
					>;
					update.name = { question_path: "/data/other", update_mode: "edit" };
				},
			}),
			await readCases(app([workerVisit]), {
				saveOnlyEditedApplied: false,
				edit: (json) => setUsercaseMode(json, "edit"),
			}),
			await readCases(app([visit]), {
				saveOnlyEditedApplied: false,
				edit: (json) => {
					actionsOf(json).subcases = [
						{
							doc_type: "OpenSubCaseAction",
							case_type: "patient",
							name_update: { question_path: "/data/other" },
							case_properties: {
								x: { question_path: "/data/notes", update_mode: "edit" },
							},
							condition: { type: "always" },
							close_condition: { type: "never" },
							relationship: "child",
						},
					] as never;
				},
			}),
		];
		for (const reading of readings) {
			expect(codes(reading)).toEqual([]);
			const records = [...reading.ctx.close().claims.records()].map(
				(one) => one.entry,
			);
			expect(records).toContain(inert);
		}
	});

	it("reads `name_update.update_mode: edit` on `open_case` as nothing", async () => {
		const reading = await readCases(app([registration]), {
			saveOnlyEditedApplied: true,
			edit: (json) => {
				(actionsOf(json).open_case as Record<string, unknown>).name_update = {
					question_path: "/data/name",
					update_mode: "edit",
				};
			},
		});
		expect(codes(reading)).toEqual([]);
	});

	it("reads a key an action read past whole does not declare as a key of an action it visits", async () => {
		// The follow-up's open action is inactive, taken whole with the form's type; its update's
		// condition is taken whole with the update. HQ keeps a key either does not declare.
		const reading = await readCasesHolding([
			"FormActionCondition.planted_key at form",
		])(app([visit]), {
			edit: (json) => {
				const actions = actionsOf(json);
				actions.open_case.planted_key = "x";
				actions.open_case.name_update_multi = [];
				(actions.update_case.condition as Record<string, unknown>).planted_key =
					"x";
			},
		});
		const undeclared = reading.findings.filter(
			(one) => one.code === `${F}/any-other-undeclared-key`,
		);
		expect(undeclared.map((one) => one.detail?.name)).toEqual(["planted_key"]);
		expect(entries(reading)).toContain(`${F}/update-multi-name-update-multi`);
		// The whole reading's one `unrecognized` is the condition's key (`readCasesHolding`).
		expect(unrecognizedOf(reading.findings)).toContain(
			"FormActionCondition.planted_key at form",
		);
	});

	it("refuses a key `location_id`", async () => {
		const reading = await readCases(app([visit]), {
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					unknown
				>;
				update.location_id = { question_path: "/data/other" };
			},
		});
		expect(codes(reading)).toContain(`${F}/update-keys-location-id-hq-user-id`);
		// The refusal names the map's own key, whose value is the map, so it is
		// recorded at the map, where the map's held claim stands too, and where the
		// lane's manifest check reads the key's use; and at each key above it the
		// entry names, which its class is a fact about too (`Accounting.findingAt`'s
		// `#recordAround`).
		const refusal = [...reading.ctx.close().claims.records()].filter(
			(one) => one.entry === `${F}/update-keys-location-id-hq-user-id`,
		);
		const at = (where: string, key: string) => ({
			artifact: "app.json",
			where: `/modules/0/forms/0/${where}`,
			key,
			entry: `${F}/update-keys-location-id-hq-user-id`,
			standing: "not-yet",
		});
		expect(refusal).toEqual([
			at("actions", "schema:Form.actions"),
			at("actions/update_case", "schema:FormActions.update_case"),
			at("actions/update_case/update", "schema:UpdateCaseAction.update"),
		]);
	});

	describe("a write through an index", () => {
		const household = {
			name: "Households",
			caseType: "household",
			forms: [
				{
					name: "Add member",
					type: "followup",
					fields: [f({ kind: "text", id: "member" })],
				} as FormSpec,
			],
		};
		/** The household's follow-up opens a patient as its child, so a patient's `parent` is a household. */
		function withChild(json: AppJson): void {
			actionsOf(json, 1).subcases = [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "patient",
					name_update: { question_path: "/data/member" },
					case_properties: {},
					condition: { type: "always" },
					close_condition: { type: "never" },
					relationship: "child",
				},
			] as never;
		}

		it("reads `parent/p` as a write through the parent the app's child link fixes", async () => {
			const reading = await readCases(app([visit], [household]), {
				edit: (json) => {
					withChild(json);
					const update = actionsOf(json).update_case.update as Record<
						string,
						unknown
					>;
					update["parent/size"] = { question_path: "/data/other" };
				},
			});
			expect(
				ownWrites(reading).find((one) => one.property === "size")?.via,
			).toEqual([{ identifier: "parent", throughCaseType: "household" }]);
		});

		it("claims a key through the case above under that key's own row", async () => {
			const reading = await readCases(app([visit], [household]), {
				edit: (json) => {
					withChild(json);
					const update = actionsOf(json).update_case.update as Record<
						string,
						unknown
					>;
					update["parent/size"] = { question_path: "/data/other" };
				},
			});
			expect(codes(reading)).toEqual([]);
			const closed = reading.ctx.close();
			const update = "/modules/0/forms/0/actions/update_case/update";
			// The row names the map's own key, so it stands at the map, beside the map's own claim;
			// the entry's question path is the update's.
			expect(entriesAt(closed, update)).toContain(
				`${F}/update-key-whose-index-segments-are-each-parent-or-host-parent-p`,
			);
			expect(entriesAt(closed, `${update}/parent~1size/question_path`)).toEqual(
				[`${F}/update-case-update-property-question`],
			);
			expect(entriesAt(closed, `${update}/notes/question_path`)).toEqual([
				`${F}/update-case-update-property-question`,
			]);
		});

		it("reads `host/p` as a write through the host a stored index of that name fixes", async () => {
			const reading = await readCases(app([visit], [household]), {
				edit: (json) => {
					withChild(json);
					const [subcase] = actionsOf(json, 1).subcases as unknown as Record<
						string,
						unknown
					>[];
					if (subcase !== undefined) subcase.reference_id = "host";
					const update = actionsOf(json).update_case.update as Record<
						string,
						unknown
					>;
					update["host/size"] = { question_path: "/data/other" };
				},
			});
			expect(
				ownWrites(reading).find((one) => one.property === "size")?.via,
			).toEqual([{ identifier: "host", throughCaseType: "household" }]);
			// The household's child case stores a `reference_id` Nova refuses at its own form; the
			// visit's write through it raises nothing.
			const visitFindings = reading.findings.filter(
				(one) =>
					one.code.startsWith(`${F}/`) &&
					(one.place as { menu?: number }).menu === 0,
			);
			expect(visitFindings.map((one) => one.code)).toEqual([]);
		});

		it("refuses a write through an index no link fixes", async () => {
			const reading = await readCases(app([visit]), {
				edit: (json) => {
					const update = actionsOf(json).update_case.update as Record<
						string,
						unknown
					>;
					update["host/size"] = { question_path: "/data/other" };
				},
			});
			expect(codes(reading)).toContain(
				`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
			);
		});

		it("refuses the name and the owner of the case above, which HQ's build writes as that case's own", async () => {
			// HQ's build writes `parent/name` as the parent's `case_name` and
			// `parent/owner_id` as its owner (`XFormCaseBlock.add_case_updates`), and
			// `case-reserved-words.json` holds neither; Nova renames and gives an
			// owner only to an operation's own case.
			for (const property of ["name", "owner_id"]) {
				const reading = await readCases(app([visit], [household]), {
					edit: (json) => {
						withChild(json);
						const update = actionsOf(json).update_case.update as Record<
							string,
							unknown
						>;
						update[`parent/${property}`] = { question_path: "/data/other" };
					},
				});
				const found = reading.findings.filter(
					(one) =>
						one.code ===
						`${F}/update-key-name-or-owner-id-through-an-index-segment`,
				);
				expect(found, property).toHaveLength(1);
				expect(found[0]?.detail?.name, property).toBe(`parent/${property}`);
				expect(
					ownWrites(reading).some((one) => one.via !== undefined),
					property,
				).toBe(false);
				expect(codes(reading), property).not.toContain(
					`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
				);
			}
		});
	});

	describe("a child case", () => {
		function child(extra: Record<string, unknown>) {
			return (json: AppJson) => {
				actionsOf(json).subcases = [
					{
						doc_type: "OpenSubCaseAction",
						case_type: "patient",
						name_update: { question_path: "/data/other" },
						case_properties: {},
						condition: { type: "always" },
						close_condition: { type: "never" },
						relationship: "child",
						...extra,
					},
				] as never;
			};
		}

		it("reads `reference_id: parent` as the link `parent`, and records the respelling", async () => {
			const reading = await readCases(app([visit]), {
				edit: child({ reference_id: "parent" }),
			});
			const create = reading.forms[0]?.form.caseOperations?.find(
				(one) => one.action === "create",
			);
			expect(create?.links?.[0]).toMatchObject({
				identifier: "parent",
				relationship: "child",
			});
			expect(create?.placement).toEqual({
				kind: "basic",
				slot: "subcase",
				index: 0,
			});
			expect(codes(reading)).toEqual([]);
		});

		it("reads a close beside the create, sharing its place", async () => {
			const reading = await readCases(app([visit]), {
				edit: child({ close_condition: { type: "always" } }),
			});
			const operations = reading.forms[0]?.form.caseOperations ?? [];
			const create = operations.find((one) => one.action === "create");
			const close = operations.find((one) => one.action === "close");
			expect(close?.target).toEqual({ kind: "op", opUuid: create?.uuid });
			expect(close?.placement).toBeUndefined();
		});

		it("reads a follow-up's child case in a menu that loads a data registry's case as inert, with its update and close", async () => {
			const reading = await readCases(app([visit]), {
				edit: (json) => {
					child({ close_condition: { type: "never" } })(json);
					actionsOf(json).close_case = {
						doc_type: "FormAction",
						condition: { type: "always", doc_type: "FormActionCondition" },
					};
					const module = json.modules[0] as Record<string, unknown>;
					module.search_config = {
						...(module.search_config as Record<string, unknown>),
						properties: [{ name: "q", label: { en: "Q" } }],
						data_registry: "registry",
						data_registry_workflow: "load_case",
					};
				},
			});
			const claimed = entries(reading);
			expect(claimed).toContain(
				`${F}/update-case-close-case-on-a-requires-case-form-that-does-not`,
			);
			expect(claimed).toContain(
				`${F}/subcases-on-such-a-form-in-an-app-that-does-not-share-cases-or`,
			);
			expect(
				reading.forms[0]?.form.caseOperations?.some(
					(one) => one.action === "create" || one.action === "close",
				) ?? false,
			).toBe(false);
		});

		it("refuses an extension, a property key holding `/`, and `edit` with the flag on", async () => {
			const extension = await readCases(app([visit]), {
				edit: child({ relationship: "extension" }),
			});
			expect(codes(extension)).toContain(
				`${F}/subcases-relationship-extension`,
			);
			const slash = await readCases(app([visit]), {
				edit: child({
					case_properties: { "parent/x": { question_path: "/data/notes" } },
				}),
			});
			expect(codes(slash)).toContain(
				`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
			);
			// HQ's reserved words hold the hyphenated `date-opened` and `external-id` too, which
			// Nova's name grammar takes apart from its own spelling: HQ's build refuses either.
			for (const key of ["date-opened", "external-id"]) {
				const reserved = await readCases(app([visit]), {
					edit: child({
						case_properties: { [key]: { question_path: "/data/notes" } },
					}),
				});
				expect(codes(reserved), key).toContain(
					`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
				);
			}
			const edit = await readCases(app([visit]), {
				saveOnlyEditedApplied: true,
				edit: child({
					case_properties: {
						x: { question_path: "/data/notes", update_mode: "edit" },
					},
				}),
			});
			expect(codes(edit)).toContain(
				`${F}/update-mode-edit-off-a-follow-up-form-s-own-update`,
			);
		});
	});
});

describe("each use of a basic action claimed under its own row", () => {
	it("refuses a key `FormActions` does not declare", async () => {
		const reading = await readCases(app([visit]), {
			edit: (json) => {
				(actionsOf(json) as Record<string, unknown>).hand_written = {
					x: 1,
				};
			},
		});
		expect(codes(reading)).toContain(`${F}/any-other-undeclared-key`);
	});

	it("claims the `name`, `owner_id`, `category` and `state` keys under their own rows", async () => {
		const reading = await readCases(app([visit]), {
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					unknown
				>;
				update.name = { question_path: "/data/other" };
				update.owner_id = { question_path: "/data/other" };
				update.category = { question_path: "/data/other" };
			},
		});
		const claimed = entries(reading);
		expect(claimed).toContain(`${F}/update-key-name`);
		expect(claimed).toContain(`${F}/update-key-owner-id`);
		expect(claimed).toContain(
			`${F}/update-keys-location-id-hq-user-id-category-state`,
		);
		expect(claimed).toContain(`${F}/update-case-update-property-question`);
	});

	it("claims a key in Nova's grammar that no row above names under its own class, at the update map", async () => {
		const reading = await readCases(app([visit]));
		const ascii = [...reading.ctx.close().claims.records()].filter(
			(one) =>
				one.entry ===
				`${F}/update-key-whose-characters-after-the-ascii-first-are-all-core-s`,
		);
		expect(
			ascii.map(({ where, key, standing }) => ({ where, key, standing })),
		).toEqual([
			{
				where: "/modules/0/forms/0/actions/update_case/update",
				key: "schema:UpdateCaseAction.update",
				standing: "held",
			},
		]);
		// `name` and `owner_id` stand under their own rows, never under the key's class.
		const named = await readCases(app([visit]), {
			edit: (json) => {
				const update = actionsOf(json).update_case.update as Record<
					string,
					unknown
				>;
				update.name = { question_path: "/data/other" };
			},
		});
		expect(
			[...named.ctx.close().claims.records()].filter(
				(one) =>
					one.entry ===
					`${F}/update-key-whose-characters-after-the-ascii-first-are-all-core-s`,
			),
		).toHaveLength(1);
	});

	it("counts a writer with no preload at `case_preload`'s default, and none on a form that writes nothing", async () => {
		const writer = `${F}/a-writer-question-with-no-case-preload-update-only`;
		// HQ's own default, which its Case Management page saves where no question loads the case.
		const writes = await readCases(app([visit]), {
			edit: (json) => {
				delete (actionsOf(json) as Record<string, unknown>).case_preload;
			},
		});
		expect(
			[...writes.ctx.close().claims.records()]
				.filter((one) => one.entry === writer)
				.map(({ where, key }) => ({ where, key })),
		).toEqual([
			{ where: "/modules/0/forms/0/actions/case_preload", key: null },
		]);
		const none = await readCases(
			app([
				{
					name: "Look",
					type: "followup",
					fields: [f({ kind: "text", id: "seen" })],
				},
			]),
		);
		expect(entries(none)).not.toContain(writer);
	});

	it("claims a write through a date-and-time question's sibling under that row", async () => {
		const reading = await readCases(
			app([
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({
							kind: "datetime",
							id: "seen_at",
							caseWrite: { caseType: "patient", property: "seen_at" },
						}),
					],
				},
			]),
		);
		expect(codes(reading)).toEqual([]);
		expect(entries(reading)).toContain(
			`${F}/update-from-a-date-and-time-question-through-a-hidden-sibling`,
		);
	});

	it("claims a capture's link under that row", async () => {
		const VISIT = testUuid("hq-shapes-visit");
		const PICTURE = testUuid("hq-shapes-picture");
		const doc = buildDoc(
			{
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "hq-shapes-visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "image", id: "picture", uuid: PICTURE })],
							},
						],
					},
				],
			},
			(built) => {
				built.forms[VISIT] = {
					...built.forms[VISIT],
					caseOperations: [
						{
							uuid: testUuid("hq-shapes-own"),
							id: "patient",
							action: "own",
							writes: [
								{
									property: "picture_link",
									value: term({ kind: "capture-link", field: PICTURE }),
								},
							],
						} as CaseOperation,
					],
				} as never;
			},
		);
		const reading = await readCases(doc, {
			expand: {
				attachmentTarget: {
					origin: "https://india.commcarehq.org",
					domain: "clinic",
				},
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(entries(reading)).toContain(
			`${F}/capture-link-write-a-hidden-value-whose-calculate-builds-hq-s`,
		);
	});

	it("records the respelling of `update_case.condition: never` on a registration", async () => {
		const reading = await readCases(app([registration]), {
			edit: (json) => {
				nameQuestionDirectly(json);
				actionsOf(json).update_case = {
					doc_type: "UpdateCaseAction",
					update: {},
					condition: { type: "never", doc_type: "FormActionCondition" },
				};
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(reading.ctx.facts.sameStateRewrites).toContainEqual(
			expect.objectContaining({
				entry: `${F}/update-case-condition-never-on-a-registration-form`,
				register: "case-settings-respelled",
			}),
		);
	});
});

describe("a basic form's actions accepted by re-emission, leaving out what the build never reads", () => {
	/** The `unrecognized` findings a whole reading raises at a form's case actions. */
	function actionDifferences(reading: Awaited<ReturnType<typeof readMenusOf>>) {
		return codesOf(reading).filter(
			(code) =>
				code.startsWith("unrecognized:schema:FormActions.") ||
				code === "unrecognized:schema:Form.actions",
		);
	}

	it("holds a survey whose close is active in a menu with a case type: HQ builds no case block", async () => {
		const survey: FormSpec = {
			name: "Survey",
			type: "survey",
			fields: [f({ kind: "text", id: "q" })],
		};
		const reading = await readMenusOf(app([visit, survey]), (json) => {
			const actions = json.modules[0]?.forms[1]?.actions as Record<
				string,
				unknown
			>;
			actions.close_case = {
				doc_type: "FormAction",
				condition: { type: "always", doc_type: "FormActionCondition" },
			};
		});
		expect(actionDifferences(reading)).toEqual([]);
		expect(
			reading.outcome.claims.counts[
				`${F}/form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a`
			],
		).toBeGreaterThan(0);
	});

	it("reads a follow-up whose close is active in a menu that selects several cases as a follow-up: HQ's build closes nothing there", async () => {
		const several = buildDoc({
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf(
						[plainColumn(testUuid("several-close-name"), "case_name", "Name")],
						{ selection: { kind: "multiple", maximum: 10 } },
					),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "done" })],
						},
					],
				},
			],
		});
		for (const condition of [
			{ type: "always", doc_type: "FormActionCondition" },
			{
				type: "if",
				question: "/data/done",
				answer: "yes",
				operator: "=",
				doc_type: "FormActionCondition",
			},
		]) {
			const reading = await readMenusOf(several, (json) => {
				const actions = json.modules[0]?.forms[0]?.actions as Record<
					string,
					unknown
				>;
				actions.close_case = { doc_type: "FormAction", condition };
			});
			expect(codesOf(reading)).toEqual([]);
			const form = Object.values(reading.doc?.forms ?? {})[0];
			expect(form?.type).toBe("followup");
			expect(form?.closeCondition).toBeUndefined();
			expect(form?.ownClosePlacement).toBeUndefined();
			expect(
				reading.outcome.claims.counts[
					`${F}/update-case-close-case-on-a-requires-case-form-that-does-not`
				],
			).toBeGreaterThan(0);
		}
	});

	it("holds an open action active on a form that requires a case: HQ's build never reads it", async () => {
		const reading = await readMenusOf(app([visit]), (json) => {
			const actions = json.modules[0]?.forms[0]?.actions as Record<
				string,
				unknown
			>;
			actions.open_case = {
				doc_type: "OpenCaseAction",
				name_update: { question_path: "/data/other" },
				external_id: null,
				condition: { type: "always", doc_type: "FormActionCondition" },
			};
		});
		expect(actionDifferences(reading)).toEqual([]);
		expect(
			reading.outcome.claims.counts[
				`${F}/open-case-active-on-a-requires-case-form`
			],
		).toBeGreaterThan(0);
	});

	it("claims a write through the date-and-time join under its row, once the join is bound", async () => {
		const DATE = testUuid("join-date");
		const TIME = testUuid("join-time");
		const read = (uuid: string): Expression => term(formField(uuid as never));
		const joined: FormSpec = {
			name: "Visit",
			type: "followup",
			fields: [
				f({ kind: "date", id: "seen_on", uuid: DATE }),
				f({ kind: "time", id: "seen_time", uuid: TIME }),
				f({
					kind: "hidden",
					id: "seen_at",
					calculate: clockKeepingJoin(read(DATE), read(TIME)),
					caseWrite: { caseType: "patient", property: "seen_at" },
				}),
			],
		};
		const reading = await readMenusOf(app([joined]));
		expect(actionDifferences(reading)).toEqual([]);
		expect(
			reading.outcome.claims.counts[
				`${F}/update-through-the-date-and-time-join-of-a-date-and-a-time`
			],
		).toBeGreaterThan(0);
		// A Hidden Value that calculates anything else writes under the question path's own row.
		const other = await readMenusOf(
			app([
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({ kind: "date", id: "seen_on", uuid: DATE }),
						f({
							kind: "hidden",
							id: "seen_at",
							calculate: {
								kind: "date-coerce",
								value: {
									kind: "format-date",
									pattern: "%Y-%m-%dT%H:%M:%S.%3%Z",
									date: read(DATE),
								},
							},
							caseWrite: { caseType: "patient", property: "seen_at" },
						}),
					],
				},
			]),
		);
		expect(
			other.outcome.claims.counts[
				`${F}/update-through-the-date-and-time-join-of-a-date-and-a-time`
			],
		).toBeUndefined();
	});
});

describe("one cause, one finding, at a basic form's case actions", () => {
	/** Every finding a whole reading raises at the first form's case actions. */
	function atActions(reading: Awaited<ReturnType<typeof readMenusOf>>) {
		return codesOf(reading).filter(
			(code) =>
				code.startsWith(`${F}/`) ||
				code.startsWith("unrecognized:schema:FormActions.") ||
				code.startsWith("unrecognized:schema:ConditionalCaseUpdate.") ||
				code === "unrecognized:schema:Form.actions",
		);
	}

	it("refuses a key `location_id` once, with no difference raised at the form's actions", async () => {
		const reading = await readMenusOf(app([visit]), (json) => {
			const update = actionsOf(json as AppJson).update_case.update as Record<
				string,
				unknown
			>;
			update.location_id = { question_path: "/data/other" };
		});
		expect(atActions(reading)).toEqual([
			`${F}/update-keys-location-id-hq-user-id`,
		]);
	});

	it("refuses a key with one trailing newline once, which HQ's grammar takes and its build cannot write", async () => {
		// `validate_property`'s `re.match` with a closing `$` takes the newline, and HQ's build
		// then makes the key the update's element (`xform.py::make_case_elem`), which lxml
		// refuses as no tag name.
		const reading = await readMenusOf(app([visit]), (json) => {
			const update = actionsOf(json as AppJson).update_case.update as Record<
				string,
				unknown
			>;
			update["notes\n"] = { question_path: "/data/other" };
		});
		expect(atActions(reading)).toEqual([
			`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
		]);
	});

	it("refuses a child case's key outside Nova's grammar under the row HQ's build gives it, once", async () => {
		// A child's keys pass the same grammar (`check_case_properties`' subcase names, a
		// `re.match` with a closing `$`), and HQ's build writes each as the child block's
		// element (`xform.py::make_case_elem`).
		for (const [key, entry] of [
			[
				"notes\n",
				`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
			],
			[
				"n½",
				`${F}/update-key-holding-a-character-validate-property-accepts-that-is`,
			],
			["n名字", `${F}/update-key-holding-a-non-ascii-core-name-character`],
		] as const) {
			const reading = await readMenusOf(app([visit]), (json) => {
				actionsOf(json as AppJson).subcases = [
					{
						doc_type: "OpenSubCaseAction",
						case_type: "patient",
						name_update: { question_path: "/data/other" },
						case_properties: { [key]: { question_path: "/data/notes" } },
						condition: { type: "always" },
						close_condition: { type: "never" },
					},
				] as never;
			});
			expect(atActions(reading), key).toEqual([entry]);
			expect(reading.outcome.defects, key).toEqual([]);
		}
	});

	it("refuses a key whose index step is outside HQ's grammar as a key HQ's build refuses, once", async () => {
		// `check_case_properties` holds the whole key to the grammar, index steps included:
		// no other index path, which Nova might come to read.
		const reading = await readMenusOf(app([visit]), (json) => {
			const update = actionsOf(json as AppJson).update_case.update as Record<
				string,
				unknown
			>;
			update["pa+rent/size"] = { question_path: "/data/other" };
		});
		expect(atActions(reading)).toEqual([
			`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		]);
	});

	it("refuses a write through an index no link fixes once", async () => {
		const reading = await readMenusOf(app([visit]), (json) => {
			const update = actionsOf(json as AppJson).update_case.update as Record<
				string,
				unknown
			>;
			update["host/size"] = { question_path: "/data/other" };
		});
		expect(atActions(reading)).toEqual([
			`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
		]);
	});

	it("refuses a child case's extension and its key holding `/` each once", async () => {
		const reading = await readMenusOf(app([visit]), (json) => {
			actionsOf(json as AppJson).subcases = [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "patient",
					name_update: { question_path: "/data/other" },
					case_properties: { "parent/x": { question_path: "/data/notes" } },
					condition: { type: "always" },
					close_condition: { type: "never" },
					relationship: "extension",
				},
			] as never;
		});
		expect([...atActions(reading)].sort()).toEqual(
			[
				`${F}/subcases-relationship-extension`,
				`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
			].sort(),
		);
	});

	it("refuses a conditional registration whose question the form no longer has", async () => {
		const reading = await readMenusOf(app([registration]), (json) => {
			(
				actionsOf(json as AppJson).open_case as Record<string, unknown>
			).condition = {
				type: "if",
				question: "/data/gone",
				answer: "yes",
				operator: "=",
				doc_type: "FormActionCondition",
			};
		});
		expect(atActions(reading)).toEqual([
			`${F}/update-path-naming-no-question-in-the-form-in-an-active-action`,
		]);
	});

	it("refuses a child case that never opens once, whatever its name and external id read", async () => {
		// HQ's build writes every `subcases[]` entry, a `never` one with a create
		// whose relevance is `false()` (`xform.py::XForm._create_casexml`), and
		// removing the child on HQ's Case Management page removes all of it. The
		// failure this catches: the check Nova's emitter conjoins onto the
		// question the child's external id reads (`caseScalarTextGuard.ts`) left
		// beside the one finding as an `unrecognized` constraint, since the
		// document leaves the refused child out.
		const KID = testUuid("never-kid");
		const CODE = testUuid("never-code");
		const NOTE = testUuid("never-note");
		const VISIT = testUuid("never-visit");
		const doc = buildDoc(
			{
				caseTypes: [
					{ name: "patient", properties: [] },
					{
						name: "visit",
						parent_type: "patient",
						properties: [{ name: "note", label: "Note" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "never-visit",
								name: "Visit",
								type: "followup",
								fields: [
									f({ kind: "text", id: "kid", uuid: KID }),
									f({ kind: "text", id: "code", uuid: CODE }),
									f({ kind: "text", id: "note", uuid: NOTE }),
								],
							},
						],
					},
					{ name: "Visits", caseType: "visit", forms: [] },
				],
			},
			(draft) => {
				draft.forms[VISIT] = {
					...draft.forms[VISIT],
					caseOperations: [
						{ uuid: testUuid("never-own"), id: "patient", action: "own" },
						{
							uuid: testUuid("never-create"),
							id: "visit",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(formField(KID)),
							writes: [
								{ property: "external_id", value: term(formField(CODE)) },
								{ property: "note", value: term(formField(NOTE)) },
							],
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						},
					] as CaseOperation[],
				} as never;
			},
		);
		// Nova's own export of the child reads back with no finding.
		expect(codesOf(await readMenusOf(doc))).toEqual([]);
		const subcase = (json: AppJson) => {
			const [only] = actionsOf(json).subcases as unknown as Record<
				string,
				unknown
			>[];
			if (only === undefined) throw new Error("The form opens one child.");
			const properties = only.case_properties as Record<string, unknown>;
			if (!("external_id" in properties))
				throw new Error("The export writes the child's external id.");
			only.condition = { type: "never", doc_type: "FormActionCondition" };
			return only;
		};
		const edits: Record<string, (json: AppJson) => void> = {
			never: (json) => {
				subcase(json);
			},
			"never, an extension of a host": (json) => {
				const only = subcase(json);
				only.relationship = "extension";
				only.reference_id = "host";
			},
			"never, its name read from the question itself": (json) => {
				const only = subcase(json);
				only.name_update = {
					question_path: "/data/kid",
					update_mode: "always",
				};
			},
		};
		for (const [label, edit] of Object.entries(edits)) {
			const reading = await readMenusOf(doc, (json) => edit(json as AppJson));
			expect(
				reading.findings.map((one) => [one.code, one.place.kind]),
				label,
			).toEqual([[`${F}/subcases-condition-never`, "form"]]);
		}
	});

	it("refuses a child case's close on a question the form no longer has", async () => {
		const reading = await readMenusOf(app([visit]), (json) => {
			actionsOf(json as AppJson).subcases = [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "patient",
					name_update: { question_path: "/data/other" },
					case_properties: {},
					condition: { type: "always" },
					close_condition: {
						type: "if",
						question: "/data/gone",
						answer: null,
						operator: "boolean_true",
					},
					relationship: "child",
				},
			] as never;
		});
		expect(atActions(reading)).toEqual([
			`${F}/update-path-naming-no-question-in-the-form-in-an-active-action`,
		]);
	});
});

describe("a save to the case above, read back from Nova's own emission", () => {
	const VISIT = testUuid("via-visit");
	const SIZE = testUuid("via-size");

	/** Members chosen under their household, whose visit saves the household's size. */
	function membersOfHouseholds(step: {
		identifier: "parent";
		throughCaseType?: string;
	}): BlueprintDoc {
		const built = buildDoc(
			{
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "size", label: "Size", data_type: "int" }],
					},
					{ name: "member", parent_type: "household", properties: [] },
				],
				modules: [
					{
						uuid: "via-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "via-households",
						forms: [
							{
								uuid: "via-visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "int", id: "size", uuid: SIZE })],
							},
						],
					},
				],
			},
			(doc) => {
				doc.forms[VISIT] = {
					...doc.forms[VISIT],
					caseOperations: [
						{
							uuid: testUuid("via-own"),
							id: "member",
							action: "own",
							writes: [
								{
									property: "size",
									value: term(formField(SIZE)),
									via: [step],
								},
							],
						} as CaseOperation,
					],
				} as never;
			},
		);
		return built;
	}

	function viaOf(doc: BlueprintDoc | undefined): unknown {
		const visitForm = Object.values(doc?.forms ?? {}).find(
			(form) => form.name === "Visit",
		);
		return visitForm?.caseOperations?.find((one) => one.action === "own")
			?.writes?.[0]?.via;
	}

	it("reads the step typed with the household it reaches, and raises nothing", async () => {
		for (const step of [
			{ identifier: "parent" as const },
			{ identifier: "parent" as const, throughCaseType: "household" },
		]) {
			const doc = membersOfHouseholds(step);
			const reading = await readMenusOf(doc);
			expect(codesOf(reading)).toEqual([]);
			expect(viaOf(reading.doc)).toEqual([
				{ identifier: "parent", throughCaseType: "household" },
			]);
			// The canonical row returns the same member of the pair from the authored document.
			const canon = READER_CANONICAL_CHOICES.find(
				(one) => one.id === "write-via-steps-are-typed",
			);
			expect(viaOf(canon?.apply(doc))).toEqual(viaOf(reading.doc));
		}
	});
});

describe("a key HQ's server stores apart from a case's properties, wherever a basic form writes it", () => {
	// HQ's build writes every action's keys from a question that is not an upload as
	// elements of its case block's `<update>` (`xform.py::XFormCaseBlock.add_case_updates`,
	// for the own case, a case above it, the worker's record and a child case), and HQ's
	// server stores `location_id` as the case's location and copies `hq_user_id` to its
	// external id wherever a block holds them (`update_strategy.py::_apply_update_action`).
	// Nova holds neither as a write (`FORBIDDEN_CASE_WRITE_PROPERTIES`), so a reading that
	// took one as a property would hold a document that writes something else.
	const DIVERTED = `${F}/update-keys-location-id-hq-user-id`;

	/** Every finding a whole reading raises at a form's case actions. */
	function atActions(reading: Awaited<ReturnType<typeof readMenusOf>>) {
		return codesOf(reading).filter(
			(code) =>
				code.startsWith(`${F}/`) ||
				code.startsWith("unrecognized:schema:FormActions.") ||
				code.startsWith("unrecognized:schema:OpenSubCaseAction.") ||
				code.startsWith("unrecognized:schema:ConditionalCaseUpdate.") ||
				code === "unrecognized:schema:Form.actions",
		);
	}

	/** The stored map of Nova's own export holding `from`, its key renamed `to`. */
	function renameKey(
		map: Record<string, unknown> | undefined,
		from: string,
		to: string,
	): void {
		if (map === undefined || !(from in map))
			throw new Error(`The export writes the key ${from}.`);
		map[to] = map[from];
		delete map[from];
	}

	const SIZE = testUuid("diverted-size");
	const KID_NAME = testUuid("diverted-kid-name");

	/** An image question every site's form holds and writes nothing from. */
	const photo = () => f({ kind: "image", id: "photo" });
	const withPhoto = (form: FormSpec): FormSpec => ({
		...form,
		fields: [...(form.fields ?? []), photo()],
	});

	/** Members chosen under their household, whose visit saves the household's size. */
	function aboveDoc(): BlueprintDoc {
		const VISIT = testUuid("diverted-visit");
		return buildDoc(
			{
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "size", label: "Size", data_type: "int" }],
					},
					{ name: "member", parent_type: "household", properties: [] },
				],
				modules: [
					{
						uuid: "diverted-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "diverted-households",
						forms: [
							{
								uuid: "diverted-visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "int", id: "size", uuid: SIZE }), photo()],
							},
						],
					},
				],
			},
			(doc) => {
				doc.forms[VISIT] = {
					...doc.forms[VISIT],
					caseOperations: [
						{
							uuid: testUuid("diverted-own"),
							id: "member",
							action: "own",
							writes: [
								{
									property: "size",
									value: term(formField(SIZE)),
									via: [{ identifier: "parent", throughCaseType: "household" }],
								},
							],
						} as CaseOperation,
					],
				} as never;
			},
		);
	}

	/** A follow-up that opens a child case writing `size`. */
	function childDoc(): BlueprintDoc {
		const VISIT = testUuid("diverted-child-visit");
		return buildDoc(
			{
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "diverted-child-visit",
								name: "Visit",
								type: "followup",
								fields: [
									f({ kind: "text", id: "kid", uuid: KID_NAME }),
									f({ kind: "int", id: "size", uuid: SIZE }),
									photo(),
								],
							},
						],
					},
				],
			},
			(doc) => {
				doc.forms[VISIT] = {
					...doc.forms[VISIT],
					caseOperations: [
						{
							uuid: testUuid("diverted-child-own"),
							id: "patient",
							action: "own",
						},
						{
							uuid: testUuid("diverted-create"),
							id: "patient_1",
							action: "create",
							caseType: "patient",
							target: { kind: "new" },
							name: term(formField(KID_NAME)),
							writes: [{ property: "size", value: term(formField(SIZE)) }],
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						},
					] as CaseOperation[],
				} as never;
			},
		);
	}

	const SITES: readonly {
		readonly where: string;
		readonly doc: () => BlueprintDoc;
		/** The key Nova's export writes, and the key the edit names in its place. */
		readonly from: string;
		readonly to: (key: string) => string;
		readonly map: (json: AppJson) => Record<string, unknown> | undefined;
	}[] = [
		{
			where: "the form's own case",
			doc: () => app([withPhoto(visit)]),
			from: "notes",
			to: (key) => key,
			map: (json) =>
				actionsOf(json).update_case?.update as Record<string, unknown>,
		},
		{
			where: "the case above it",
			doc: aboveDoc,
			from: "parent/size",
			to: (key) => `parent/${key}`,
			map: (json) =>
				actionsOf(json, 1).update_case?.update as Record<string, unknown>,
		},
		{
			where: "the worker's record",
			doc: () => app([withPhoto(workerVisit)]),
			from: "mood",
			to: (key) => key,
			map: (json) =>
				actionsOf(json).usercase_update?.update as Record<string, unknown>,
		},
		{
			where: "a child case",
			doc: childDoc,
			from: "size",
			to: (key) => key,
			map: (json) => {
				const [subcase] = actionsOf(json).subcases as unknown as Record<
					string,
					unknown
				>[];
				return subcase?.case_properties as Record<string, unknown>;
			},
		},
	];

	for (const site of SITES)
		it(`refuses \`location_id\` and \`hq_user_id\` written to ${site.where} once, where Nova's own write there reads with none`, async () => {
			// The pair: Nova's own export of the write reads with no finding at its actions.
			const plain = await readMenusOf(site.doc(), (json) => {
				site.map(json as AppJson);
			});
			expect(atActions(plain)).toEqual([]);
			expect(plain.outcome.defects).toEqual([]);
			for (const key of ["location_id", "hq_user_id"]) {
				const stored = site.to(key);
				const reading = await readMenusOf(site.doc(), (json) =>
					renameKey(site.map(json as AppJson), site.from, stored),
				);
				expect(atActions(reading), key).toEqual([DIVERTED]);
				expect(reading.outcome.defects, key).toEqual([]);
				const found = reading.findings.filter((one) => one.code === DIVERTED);
				expect(found[0]?.detail?.name, key).toBe(stored);
				expect(reading.doc, key).toBeUndefined();
			}
		});

	// HQ's build writes a key whose question is an `<upload>` into the block's
	// `<attachment>`, not its `<update>` (`XFormCaseBlock.add_case_updates` over
	// `is_attachment`), so HQ's server neither stores it as the case's location nor
	// copies it to the external id: such a write is the upload question's row alone.
	const UPLOAD = `${F}/update-from-an-upload-question-attachment-mode`;
	for (const site of SITES)
		it(`reads \`location_id\` and \`hq_user_id\` from an upload question written to ${site.where} as the upload question's write, as any key from one reads`, async () => {
			/** The stored map with the export's key renamed `to` and read from the image question. */
			const fromPhoto = (to: string) => (json: unknown) => {
				const map = site.map(json as AppJson);
				if (to !== site.from) renameKey(map, site.from, to);
				(map?.[to] as Record<string, unknown>).question_path = "/data/photo";
			};
			// The pair: the export's own key read from the image question.
			const plain = await readMenusOf(site.doc(), fromPhoto(site.from));
			expect(atActions(plain)).toEqual([UPLOAD]);
			expect(plain.outcome.defects).toEqual([]);
			for (const key of ["location_id", "hq_user_id"]) {
				const stored = site.to(key);
				const reading = await readMenusOf(site.doc(), fromPhoto(stored));
				expect(atActions(reading), key).toEqual([UPLOAD]);
				expect(reading.outcome.defects, key).toEqual([]);
				expect(
					reading.findings.find((one) => one.code === UPLOAD)?.detail?.name,
					key,
				).toBe(key);
				expect(reading.doc, key).toBeUndefined();
			}
		});
});
