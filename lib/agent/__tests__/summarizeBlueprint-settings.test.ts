import { describe, expect, it } from "vitest";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { expectAdmittedDoc, surveyFixture } from "./admittedFixture";

describe("summarizeBlueprint form-list settings", () => {
	it.each<[boolean, boolean, string]>([
		[false, false, "Form lists: saved forms off, incomplete forms off"],
		[true, false, "Form lists: saved forms on, incomplete forms off"],
		[false, true, "Form lists: saved forms off, incomplete forms on"],
		[true, true, "Form lists: saved forms on, incomplete forms on"],
	])(
		"prints saved %s and incomplete %s as one line",
		(saved, incomplete, line) => {
			const doc = surveyFixture();
			doc.appSettings = {
				showSavedForms: saved,
				showIncompleteForms: incomplete,
			};
			const lines = summarizeBlueprint(expectAdmittedDoc(doc)).split("\n");
			expect(lines.filter((entry) => entry.startsWith("Form lists:"))).toEqual([
				line,
			]);
		},
	);
});
