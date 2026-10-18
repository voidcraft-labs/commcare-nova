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
