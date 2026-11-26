import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { EngineController } from "../engineController";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice } from "./fixtures/previewDevices";

it("keeps an empty invoking Date empty and writes named results past entry widget filters", async () => {
	const owner = testUuid("meter");
	const target = testUuid("reference");
	const formUuid = testUuid("meter-form");
	const { doc } = engineFixtureInput(
		[
			{
				kind: "text",
				uuid: owner,
				id: "meter",
				label: "Meter",
				androidApp: {
					kind: "open-app",
					action: "org.example.meter.READ",
					send: [],
					receive: [{ name: "reference", question: target }],
				},
			},
			{
				kind: "date",
				id: "reading_day",
				label: "Reading day",
				androidApp: { kind: "use-question", question: owner },
			},
			{
				kind: "text",
				uuid: target,
				id: "reference",
				label: "Reference",
				keypad: "numbers",
			},
			{ kind: "hidden", id: "copy", calculate: "#form/reference" },
		],
		{ formUuid, formType: "survey" },
	);
	const store = createBlueprintDocStore();
	store
		.getState()
		.load({
			...doc,
			appSettings: { ...doc.appSettings, runsOnlyOn: "android" },
		});
	const controller = new EngineController(
		new XPathRuntime({ workerFactory: createInProcessXPathWorkerFactory() }),
	);
	try {
		controller.setDocStore(store);
		controller.setPreviewDevice(androidDevice());
		expect(await controller.activateFormAsync(formUuid)).toBe(true);
		const entryKey = controller.entryKey;
		if (!entryKey) throw new Error("The Android form did not open.");
		const date = "/data/reading_day";
		expect(await controller.enterScreenAsync(date)).toBe(true);
		const launch = await controller.openAndroidApp(
			entryKey,
			date,
			new AbortController().signal,
		);
		expect(launch?.current).toBe("");
		if (!launch) throw new Error("The Date did not open its app.");
		expect(
			await controller.commitAndroidAppResult(
				entryKey,
				date,
				launch.signature,
				{ extras: new Map([["reference", { value: "A12" }]]) },
				new Map(),
				() => {},
			),
		).toBe(true);
		const saved = await controller.snapshotAndroidSave(entryKey, "incomplete");
		expect(saved?.checkpoint.state[date]).toMatchObject({ value: "" });
		expect(saved?.checkpoint.state[date].androidPickerDay).toBeUndefined();
		expect(saved?.checkpoint.state["/data/reference"].value).toBe("A12");
		expect(saved?.checkpoint.state["/data/copy"].value).toBe("A12");
	} finally {
		controller.dispose();
	}
});
