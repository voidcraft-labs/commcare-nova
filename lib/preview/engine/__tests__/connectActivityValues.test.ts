import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { connectSectionForm } from "@/lib/__tests__/connectSectionForm";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { FormNodeTerm } from "@/lib/domain/expression/types";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { androidDevice } from "./fixtures/previewDevices";

it("reads activity content, identity and computed answers in the current worker form", () => {
	const delivery = testUuid("visit-delivery");
	const task = testUuid("visit-task");
	const form = testUuid("visit-form");
	const ref = (node: FormNodeTerm["node"]) => ({
		kind: "term" as const,
		term: { kind: "form-node" as const, node, spelling: "relative" as const },
	});
	const doc = buildDoc({
		connectRoles: ["deliver"],
		appSettings: {
			showSavedForms: false,
			showIncompleteForms: false,
			runsOnlyOn: "android",
		},
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "who" }),
							f({
								kind: "group",
								id: "visit",
								children: [
									f({
										kind: "connect_activity",
										uuid: delivery,
										id: "health_check",
										activity: {
											kind: "delivery",
											name: "Health visit",
											entityId: "#form/who",
										},
										relevant: "#form/who != ''",
									}),
									f({
										kind: "connect_activity",
										uuid: task,
										id: "contact",
										relevant: "#form/who = ''",
										activity: {
											kind: "assigned-task",
											name: "Contact",
											description: "Follow up",
										},
									}),
								],
							}),
							f({
								kind: "hidden",
								id: "person",
								calculate: ref({
									kind: "connect-delivery",
									activity: delivery,
									role: "entity-id",
								}),
							}),
							f({
								kind: "hidden",
								id: "unit",
								calculate: ref({
									kind: "connect-delivery",
									activity: delivery,
									role: "name",
								}),
							}),
							f({
								kind: "hidden",
								id: "task_id",
								calculate: ref({
									kind: "connect-task",
									activity: task,
									role: "id",
								}),
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedPreviewDoc(doc);
	const input = buildEngineInput(doc, form, null);
	if (!input) throw new Error("Expected the visit form");
	const engine = new FormEngine(input);
	expect(engine.getState("/data/task_id").value).toBe("contact");
	expect(engine.getState("/data/unit").value).toBe("");
	engine.setValue("/data/who", "Mira");
	expect(engine.getState("/data/person").value).toBe("Mira");
	expect(engine.getState("/data/unit").value).toBe("Health visit");
	const submitted = engine.computeSubmissionMutation({
		entryKey: "0fd69353-5355-4c2b-b46f-d44674d5e149",
	});
	expect(submitted.activities).toEqual([
		{
			kind: "delivery",
			fieldUuid: delivery,
			rows: [],
			entityId: "Mira",
			entityName: "",
			workAreaId: "",
		},
	]);
	engine.setValue("/data/who", "");
	expect(engine.getState("/data/person").value).toBe("");
	expect(engine.getState("/data/unit").value).toBe("");
	expect(
		engine.computeSubmissionMutation({
			entryKey: "63222bad-f2b8-4011-9917-64cf463ddc31",
		}).activities,
	).toEqual([{ kind: "assigned-task", fieldUuid: task, rows: [] }]);
});

it("runs the two worker pages and submits the four activities in their original order", () => {
	const doc = connectSectionForm("preview-pages");
	assertAdmittedPreviewDoc(doc);
	const form = doc.formOrder[doc.moduleOrder[0]][0];
	const input = buildEngineInput(doc, form, null);
	if (!input) throw new Error("Missing Learn form");
	const engine = new FormEngine(
		input,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device: androidDevice() },
	);
	expect(engine.formScreens().map(({ kind, path }) => [kind, path])).toEqual([
		["section", "/data/practice"],
		["section", "/data/follow_up"],
	]);
	engine.setValue("/data/practice/reflection", "Rehearse with a colleague");
	engine.setValue("/data/follow_up/next_step", "Return tomorrow");
	const result = engine.computeSubmissionMutation({
		entryKey: testUuid("preview-learn"),
	});
	expect(
		result.activities?.map((activity) => doc.fields[activity.fieldUuid].id),
	).toEqual(["lesson_one", "rehearsal", "review", "completion"]);
});

it.each([false, true])(
	"offers no blank worker screen for an activity with sections=%s",
	(sectioned) => {
		const form = testUuid("worker-visible-pages");
		const lesson = (id: string) =>
			f({
				id,
				kind: "connect_activity",
				activity: {
					kind: "learning-module",
					name: id,
					description: id,
					estimatedHours: 1,
				},
			});
		const doc = buildDoc({
			connectRoles: ["learn"],
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
			modules: [
				{
					name: "Training",
					forms: [
						{
							uuid: form,
							name: "Practice",
							type: "survey",
							fields: sectioned
								? [
										f({
											id: "recorded",
											kind: "section",
											children: [lesson("complete")],
										}),
										f({
											id: "questions",
											kind: "section",
											children: [f({ id: "notes", kind: "text" })],
										}),
									]
								: [lesson("complete"), f({ id: "notes", kind: "text" })],
						},
					],
				},
			],
		});
		assertAdmittedPreviewDoc(doc);
		const input = buildEngineInput(doc, form, null);
		if (!input) throw new Error("Missing worker form");
		const engine = new FormEngine(
			input,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device: androidDevice() },
		);
		expect(
			engine
				.formScreens()
				.filter((page) => page.hasVisibleQuestions)
				.map((page) => page.path),
		).toEqual([sectioned ? "/data/questions" : "/data/notes"]);
		expect(
			engine
				.computeSubmissionMutation({ entryKey: testUuid("activity-receipt") })
				.activities?.map((row) => doc.fields[row.fieldUuid].id),
		).toEqual(["complete"]);
	},
);
