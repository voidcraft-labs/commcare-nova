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
const ADDRESS_PARENT = testUuid("form.stops.collected");
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
						submissionPlacement: { parent: ADDRESS_PARENT },
					},
					{
						kind: "group",
						uuid: ADDRESS_PARENT,
						id: "collected",
						children: [{ kind: "text", id: "reference" }],
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
		{ formUuid: FORM, formType: "survey", form: { dataRootName: "visit" } },
	);
}

describe("a worker question receiving a form update", () => {
	it("commits an address under its submitted group and updates only the receivers in its own repeat row and entry", async () => {
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
			const stops = testUuid("form.stops");
			await Promise.all(
				controllers.map((controller) => controller.addRepeatAsync(stops)),
			);
			await first.setValueAtAsync("/visit/stops[0]/plain_region", "north_id");
			const row = "/visit/stops[0]/";
			const address = `${row}collected/address`;
			const message = { city: "Mtoni", province: "Missing", region: "South" };
			const value = JSON.stringify(message);
			const entry = first.entryKey;
			if (entry === undefined) throw new Error("The form did not open.");
			const target = {
				fieldUuid: testUuid("form.stops.address"),
				repeatInstances: [
					{
						fieldUuid: stops,
						instanceKey: first.getRepeatInstanceKey(stops, 0),
					},
				],
			};
			const pending = first.commitAddressAnswer(entry, target, value, message);
			await first.touchAtAsync(address);
			await expect(pending).resolves.toBe(true);
			await first.awaitSettled();
			expect(first.store.getState()[address]?.value).toBe(value);
			expect(first.store.getState()[`${row}address`]).toBeUndefined();
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
			await first.applyDisplayMessage(address, {
				province: "North",
				region: "South",
			});
			expect(first.store.getState()[`${row}region`]?.value).toBe("north_id");
			expect(first.store.getState()[`${row}city`]?.value).toBe("");
			await first.applyDisplayMessage(address, null);
			expect(first.store.getState()[`${row}region`]?.value).toBe("");
			expect(first.store.getState()[`${row}filename`]?.value).toBe("route.pdf");

			await first.addRepeatAsync(stops);
			expect(await first.removeRepeatAsync(stops, 0)).toBe(true);
			expect(first.getRepeatCount(stops)).toBe(1);
			await expect(
				first.commitAddressAnswer(entry, target, value, message),
			).resolves.toBe(false);
			await first.awaitSettled();
			expect(first.getRepeatCount(stops)).toBe(1);
			expect(first.store.getState()[address]?.value).toBe("");
			expect(first.store.getState()[`${row}city`]?.value).toBe("");
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
			web.addRepeat("/visit/stops");
			web.addRepeat("/visit/stops");
			const paths = web
				.displayMessageAnswers("/visit/stops[1]/document", {
					filename: "later.pdf",
				})
				.map(({ path, value }) => [path, value]);
			expect(paths).toEqual([["/visit/stops[1]/filename", "later.pdf"]]);
			const android = new FormEngine(
				input,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ device: androidDevice() },
			);
			android.addRepeat("/visit/stops");
			expect(
				android.store.getState()["/visit/stops[0]/document"],
			).toBeDefined();
			expect(
				android.displayMessageAnswers("/visit/stops[0]/document", {
					filename: "phone.pdf",
				}),
			).toEqual([]);
		},
	);
});
