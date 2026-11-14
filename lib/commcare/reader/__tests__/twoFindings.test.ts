/**
 * Every finding in one pass: one app holding a child case the case reader
 * refuses and a link the menus reader refuses raises both, each at its form.
 */
import { describe, expect, it } from "vitest";
import { buildShape } from "../../__tests__/formLinkDocArbitrary";
import {
	codesOf,
	type JsonObject,
	readMenusOf,
} from "../menus/__tests__/menuReading";

const F = "forms-and-case-writes";

describe("a reading with two findings", () => {
	it("raises the refused child case and the refused link together", async () => {
		const doc = buildShape([{ toMenu: true }], { kind: "none" });
		const reading = await readMenusOf(doc, (app) => {
			const check = app.modules[0]?.forms[0] as JsonObject;
			const actions = check.actions as JsonObject;
			actions.subcases = [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "frog",
					name_update: { question_path: "/data/mood" },
					case_properties: {},
					condition: { type: "always" },
					close_condition: { type: "never" },
					relationship: "extension",
				},
			];
			const [link] = check.form_links as JsonObject[];
			// A link HQ's checks refuse: it names a form and a menu at once.
			if (link !== undefined) link.form_id = "not-a-form";
		});
		const codes = codesOf(reading);
		expect(codes).toContain(`${F}/subcases-relationship-extension`);
		expect(codes).toContain(
			`${F}/form-links-failing-hq-s-link-checks-no-form-links-and-bad-form`,
		);
		const places = reading.findings
			.filter((finding) => finding.code.startsWith(`${F}/`))
			.map((finding) => finding.place.kind);
		expect(places).not.toContain("app");
	});
});
