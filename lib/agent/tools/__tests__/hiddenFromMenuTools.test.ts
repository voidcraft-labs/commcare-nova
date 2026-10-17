/** `hiddenFromMenu` and the five after-submit destinations through the shared
 * tools, over admitted documents and the production reducer and gate. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { getFormTool } from "../getForm";
import { getModuleTool } from "../getModule";
import { updateFormTool } from "../updateForm";
import { updateModuleTool } from "../updateModule";

const LOANS = testUuid("loans");
const RETURN = testUuid("return");

function harness() {
	return makeToolWorkspaceHarness(
		expectAdmittedDoc(
			buildDoc({
				caseTypes: [{ name: "loan", properties: [] }],
				modules: [
					{
						uuid: "loans",
						name: "Loans",
						caseType: "loan",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								uuid: "return",
								name: "Return",
								type: "close",
								postSubmit: "previous",
								fields: [f({ kind: "text", id: "note" })],
							},
						],
					},
				],
			}),
		),
	);
}

describe("hiddenFromMenu through the module and form tools", () => {
	it("takes a module off the menu, moves the destination it no longer offers, and puts it back", async () => {
		const h = harness();
		const hidden = await h.runTool(updateModuleTool, {
			moduleUuid: LOANS,
			hiddenFromMenu: true,
		});
		if ("error" in hidden.result) throw new Error(hidden.result.error);
		expect(hidden.result.hiddenFromMenu).toBe(true);
		expect(h.currentDoc().forms[RETURN]?.postSubmit).toBe("firstMenu");
		const read = await h.runTool(getModuleTool, { moduleUuid: LOANS });
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.hidden_from_menu).toBe(true);
		expect(read.data.forms[0]?.hidden_from_menu).toBe(false);

		const shown = await h.runTool(updateModuleTool, {
			moduleUuid: LOANS,
			hiddenFromMenu: null,
		});
		if ("error" in shown.result) throw new Error(shown.result.error);
		expect(shown.result.hiddenFromMenu).toBe(false);
		expect(h.currentDoc().modules[LOANS]?.hiddenFromMenu).toBeUndefined();
	});

	it("takes a form off the menu and shows it on the form read", async () => {
		const h = harness();
		const updated = await h.runTool(updateFormTool, {
			moduleUuid: LOANS,
			formUuid: RETURN,
			hiddenFromMenu: true,
		});
		if ("error" in updated.result) throw new Error(updated.result.error);
		expect(updated.result.hiddenFromMenu).toBe(true);
		const read = await h.runTool(getFormTool, {
			moduleUuid: LOANS,
			formUuid: RETURN,
		});
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.form.hiddenFromMenu).toBe(true);
	});

	it("refuses a destination the module does not offer, naming the ones it does", async () => {
		const h = harness();
		const refused = await h.runTool(updateFormTool, {
			moduleUuid: LOANS,
			formUuid: RETURN,
			post_submit: "parentMenu",
		});
		expect(refused.mutations).toEqual([]);
		if (!("error" in refused.result)) throw new Error("expected a refusal");
		expect(refused.result.error).toContain("has no parent module");
		expect(h.currentDoc().forms[RETURN]?.postSubmit).toBe("previous");

		const accepted = await h.runTool(updateFormTool, {
			moduleUuid: LOANS,
			formUuid: RETURN,
			post_submit: "firstMenu",
		});
		if ("error" in accepted.result) throw new Error(accepted.result.error);
		expect(h.currentDoc().forms[RETURN]?.postSubmit).toBe("firstMenu");
	});
});
