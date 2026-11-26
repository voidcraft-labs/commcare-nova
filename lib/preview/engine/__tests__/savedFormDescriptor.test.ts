import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { savedFormDescriptor } from "@/proof/targeted/documents/savedFormDescriptor";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { androidDevice } from "./fixtures/previewDevices";

describe("Android saved form label", () => {
	it("reads the saved answers in the active form language", async () => {
		const doc = hydratePersistedBlueprint(savedFormDescriptor().doc);
		const form = Object.values(doc.forms)[0];
		const input = buildEngineInput(doc, form.uuid, "fra");
		if (!input) throw new Error("The saved form is missing.");
		const open = new FormEngine(
			input,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device: androidDevice("fr") },
		);
		open.setValue("/data/record", "Chef");
		expect(await open.savedFormDescriptor()).toBe("Visite Chef");

		const reopened = new FormEngine(
			input,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				device: androidDevice("fr"),
				restoredEntry: {
					checkpoint: open.entryCheckpoint(),
					preserveAllValues: true,
				},
			},
		);
		expect(await reopened.savedFormDescriptor()).toBe("Visite Chef");
		reopened.setValue("/data/record", "Nord");
		expect(await reopened.savedFormDescriptor()).toBe("Visite Nord");

		const english = buildEngineInput(doc, form.uuid, "eng");
		if (!english) throw new Error("The saved form is missing in English.");
		const translated = new FormEngine(
			english,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ device: androidDevice() },
		);
		translated.setValue("/data/record", "Chef");
		expect(await translated.savedFormDescriptor()).toBe("Visit Chef");
	});
});
