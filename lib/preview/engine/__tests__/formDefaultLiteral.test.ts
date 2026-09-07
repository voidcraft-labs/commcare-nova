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

describe("text defaults retain the literal false string", () => {
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
});
