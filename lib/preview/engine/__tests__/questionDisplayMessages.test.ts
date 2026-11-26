/** Real form sessions and concrete repeat rows supply the subscription boundary.
 * A selected address's labelled choice stores its own value, and an Android
 * session has no Web Apps subscriptions. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";
import { FormEngine } from "../formEngine";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice } from "./fixtures/previewDevices";

const FORM = testUuid("display-message-form");
function visitInput(receiverField = "filename") {
	const choices = (id: string) => ({
		kind: "inline",
		options: ["North", "South"].map((label) => ({
			uuid: testUuid(id + label),
			value: `${label.toLowerCase()}_id`,
			label: proseText(label),
		})),
	});
	return engineFixtureInput(
		[
			{
				kind: "text",
				id: "root_city",
				label: "Root city",
				receiveFrom: { channel: "stop", field: "city" },
			},
			{
				kind: "repeat",
				id: "stops",
				label: "Stops",
				children: [
					{
						kind: "text",
						id: "address",
						label: "Address",
						addressLookup: true,
						sendTopics: ["stop"],
					},
					{
						kind: "text",
						id: "city",
						label: "City",
						receiveFrom: { channel: "stop", field: "city" },
					},
					{
						kind: "single_select",
						id: "region",
						label: "Region",
						optionsSource: choices("region"),
						choiceLayout: { kind: "search" },
						receiveFrom: { channel: "stop", field: "province||region" },
					},
					{
						kind: "single_select",
						id: "plain_region",
						label: "Plain region",
						optionsSource: choices("plain"),
						receiveFrom: { channel: "stop", field: "region" },
					},
					{
						kind: "file",
						id: "document",
						label: "Document",
						sendTopics: ["document"],
					},
					{
						kind: "text",
						id: "filename",
						label: "Name of file",
						receiveFrom: { channel: "document", field: receiverField },
					},
				],
			},
		],
		{ formUuid: FORM, formType: "survey" },
	);
}

describe("a worker question receiving a form update", () => {
	it("fills an address's own repeat row through the controller and clears absent answers without writing to a second session", async () => {
		const input = visitInput();
		const store = createBlueprintDocStore();
		store.getState().load(input.doc);
		store.getState().startTracking();
		const controllers = [1, 2].map(() => {
			const runtime = new XPathRuntime({
				workerFactory: createInProcessXPathWorkerFactory(),
			});
			const controller = new EngineController(runtime);
			controller.setDocStore(store);
			return controller;
		});
		const [first, second] = controllers;
		try {
			await Promise.all(
				controllers.map((controller) => controller.activateFormAsync(FORM)),
			);
			await first.setValueAtAsync("/data/stops[0]/plain_region", "north_id");
			await first.applyDisplayMessage("/data/stops[0]/address", {
				city: "Mtoni",
				province: "Missing",
				region: "South",
			});
			const row = "/data/stops[0]/";
			expect(first.store.getState()[`${row}city`]?.value).toBe("Mtoni");
			expect(first.store.getState()[`${row}region`]?.value).toBe("south_id");
			expect(first.store.getState()[`${row}plain_region`]?.value).toBe("");
			expect(second.store.getState()[`${row}city`]?.value).toBe("");
			expect(first.store.getState()[testUuid("form.root_city")]?.value).toBe(
				"",
			);
			await first.applyDisplayMessage(`${row}document`, {
				filename: "route.pdf",
			});
			expect(first.store.getState()[`${row}filename`]?.value).toBe("route.pdf");
			await first.applyDisplayMessage(`${row}address`, {
				province: "North",
				region: "South",
			});
			expect(first.store.getState()[`${row}region`]?.value).toBe("north_id");
			expect(first.store.getState()[`${row}city`]?.value).toBe("");
			await first.applyDisplayMessage(`${row}address`, null);
			expect(first.store.getState()[`${row}region`]?.value).toBe("");
			expect(first.store.getState()[`${row}filename`]?.value).toBe("route.pdf");
		} finally {
			for (const controller of controllers) controller.dispose();
			await Promise.all(
				controllers.map((controller) => controller.awaitSettled()),
			);
		}
	});
	it.each(["filename", "indexed"])(
		"addresses only the selected repeat row using the %s receiver and leaves Android's answer to the worker",
		(receiverField) => {
			const input = visitInput(receiverField);
			const web = new FormEngine(input);
			web.addRepeat("/data/stops");
			const paths = web
				.displayMessageAnswers("/data/stops[1]/document", {
					filename: "later.pdf",
				})
				.map(({ path, value }) => [path, value]);
			expect(paths).toEqual([["/data/stops[1]/filename", "later.pdf"]]);
			const android = new FormEngine(
				input,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ device: androidDevice() },
			);
			expect(
				android.displayMessageAnswers("/data/stops[0]/document", {
					filename: "phone.pdf",
				}),
			).toEqual([]);
		},
	);
});
