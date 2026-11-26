// Tests the note the inspector shows under Find an address against what
// publishing asks for each declared platform set.
import { describe, expect, it } from "vitest";
import { targetConditionOf } from "@/lib/domain/platforms";
import { addressSearchNote } from "../addressSearchNoteModel";

const reason = targetConditionOf("address-lookup")?.reason ?? "";

describe("addressSearchNote", () => {
	it("names what Web Apps needs and the publish step where the app runs in Web Apps", () => {
		const note = addressSearchNote(["web-apps", "android"], "text");
		expect(note.startsWith(reason)).toBe(true);
		expect(note).toContain("asks you to confirm the plan feature");
	});

	it("asks nothing of the project space for an app that runs only on Android", () => {
		for (const kind of ["text", "secret", "barcode"] as const) {
			const note = addressSearchNote(["android"], kind);
			expect(note).not.toContain(reason);
			expect(note).not.toContain("Publishing checks");
			expect(note).toContain("asks nothing of the project space");
		}
	});

	it("speaks of Android's mask only where the app runs on Android", () => {
		expect(addressSearchNote(["web-apps", "android"], "secret")).toContain(
			"Android masks the answer.",
		);
		expect(addressSearchNote(["web-apps"], "secret")).not.toContain("Android");
	});
});
