import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";

const FORM = testUuid("literal-default-form");
const FIELD = testUuid("literal-default-field");

describe("literal form defaults", () => {
	it.each([
		["false()", ""],
		["#form/switch = 'yes'", "3"],
		["true()", "3"],
	])(
		"captures the starting answer before recalculation under %s",
		async (relevant, captured) => {
			const doc = buildDoc({
				modules: [
					{
						name: "Visits",
						forms: [
							{
								uuid: FORM,
								name: "Visit",
								type: "survey",
								fields: [
									f({ kind: "text", id: "switch", label: "Show details" }),
									f({
										kind: "group",
										id: "details",
										label: "Details",
										relevant,
										children: [
											f({
												kind: "hidden",
												id: "seed",
												default_value: "'3'",
												calculate: "'5'",
											}),
										],
									}),
									f({
										uuid: FIELD,
										kind: "text",
										id: "captured",
										label: "Starting answer",
										default_value: "#form/details/seed",
									}),
								],
							},
						],
					},
				],
			});
			assertAdmittedPreviewDoc(doc);
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			const ctrl = new EngineController();
			try {
				ctrl.setDocStore(store);
				await ctrl.activateFormAsync(FORM);
				expect(ctrl.store.getState()[FIELD]?.value).toBe(captured);
			} finally {
				ctrl.dispose();
				await ctrl.awaitSettled();
			}
		},
	);
	it.each([false, true])(
		"applies the authored text without interpreting it as absence (worker=%s)",
		async (worker) => {
			const doc = buildDoc({
				appName: "Defaults",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								uuid: FORM,
								name: "Record",
								type: "survey",
								fields: [
									f({
										uuid: FIELD,
										kind: "text",
										id: "answer",
										label: "Answer",
										default_value: "'false'",
									}),
								],
							},
						],
					},
				],
			});
			assertAdmittedPreviewDoc(doc);
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			const ctrl = new EngineController(
				worker
					? new XPathRuntime({
							workerFactory: createInProcessXPathWorkerFactory(),
						})
					: undefined,
			);
			try {
				ctrl.setDocStore(store);
				await ctrl.activateFormAsync(FORM);
				expect(ctrl.store.getState()[FIELD]?.value).toBe("false");
			} finally {
				ctrl.dispose();
				await ctrl.awaitSettled();
			}
		},
	);
	it.each([false, true])(
		"stores numeric select defaults using their native answer text (worker=%s)",
		async (worker) => {
			const defaults = (["single_select", "multi_select"] as const).flatMap(
				(kind) =>
					[
						{ id: "fraction", source: "0.0001", answer: "1.0E-4" },
						{ id: "near_integer", source: "1.0000000005", answer: "1" },
					].map((value) => ({
						...value,
						kind,
						id: `${kind}_${value.id}`,
						uuid: testUuid(`numeric-default-${kind}-${value.id}`),
					})),
			);
			const doc = buildDoc({
				appName: "Numeric defaults",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								uuid: FORM,
								name: "Record",
								type: "survey",
								fields: defaults.map(({ id, uuid, kind, source, answer }) =>
									f({
										id,
										uuid,
										kind,
										default_value: source,
										options: [
											{ value: answer, label: "Native answer" },
											{ value: "other", label: "Other" },
										],
									}),
								),
							},
						],
					},
				],
			});
			assertAdmittedPreviewDoc(doc);
			const store = createBlueprintDocStore();
			store.getState().load(doc);
			const ctrl = new EngineController(
				worker
					? new XPathRuntime({
							workerFactory: createInProcessXPathWorkerFactory(),
						})
					: undefined,
			);
			try {
				ctrl.setDocStore(store);
				expect(await ctrl.activateFormAsync(FORM)).toBe(true);
				for (const { uuid, answer } of defaults) {
					expect(ctrl.store.getState()[uuid]?.value).toBe(answer);
				}
			} finally {
				ctrl.dispose();
				await ctrl.awaitSettled();
			}
		},
	);
});

it("uses the chosen hidden answer type at each opening assignment", async () => {
	const form = testUuid("hidden-answer-types-form");
	const held = [
		"whole",
		"large",
		"fraction",
		"yes",
		"letters",
		"start",
	] as const;
	const fields = [
		{ id: "whole", answerType: "int", calculate: "2.75" },
		{ id: "large", answerType: "long", calculate: "3000000000.75" },
		{ id: "fraction", answerType: "decimal", calculate: "2.75" },
		{ id: "yes", answerType: "boolean", calculate: "'false'" },
		{ id: "letters", answerType: "int", calculate: "'0003'" },
		{ id: "start", answerType: "int", default_value: "'0003'" },
	].map((one) => f({ ...one, kind: "hidden", uuid: testUuid(one.id) }));
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [...fields, f({ id: "note", kind: "text", label: "Note" })],
					},
				],
			},
		],
	});
	assertAdmittedPreviewDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	const ctrl = new EngineController();
	try {
		ctrl.setDocStore(store);
		await ctrl.activateFormAsync(form);
		expect(
			held.map((name) => ctrl.store.getState()[testUuid(name)]?.value),
		).toEqual(["2", "3000000000", "2.75", "1", "0003", "3"]);
	} finally {
		ctrl.dispose();
		await ctrl.awaitSettled();
	}
});

it.each([false, true])(
	"explains a calculated list of choices that starts empty (worker=%s)",
	async (worker) => {
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "choices",
									label: "Choices",
									default_value: "' one two'",
								}),
								f({
									kind: "hidden",
									id: "chosen",
									answerType: "multi_select",
									calculate: "#form/choices",
								}),
							],
						},
					],
				},
			],
		});
		assertAdmittedPreviewDoc(doc);
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		const ctrl = new EngineController(
			worker
				? new XPathRuntime({
						workerFactory: createInProcessXPathWorkerFactory(),
					})
				: undefined,
		);
		try {
			ctrl.setDocStore(store);
			await ctrl.activateFormAsync(FORM);
			expect(ctrl.entryStore.getState().refusal).toMatchObject({
				kind: "data",
				reason: {
					kind: "hidden-calculation",
					question: "chosen",
					problem: "empty-choice",
				},
			});
			expect(ctrl.entryStore.getState().fault).toBeUndefined();
		} finally {
			ctrl.dispose();
			await ctrl.awaitSettled();
		}
	},
);
