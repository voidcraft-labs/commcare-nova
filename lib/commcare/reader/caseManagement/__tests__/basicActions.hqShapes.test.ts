import { describe, expect, it } from "vitest";
import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { type AppJson, readCases, readFields } from "./caseReading";

const F = "forms-and-case-writes";

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
		const reading = await readCases(app([hiddenName]), {
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
		expect(reading.findings.length).toBeGreaterThan(0);
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
			).toEqual([{ identifier: "parent", throughCaseType: "patient" }]);
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
			).toEqual([{ identifier: "host", throughCaseType: "patient" }]);
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
