/**
 * The switch's line names the screen a worker opens the menu from, read
 * from the production projection (`menuTileScreenOf`) over documents built
 * by `buildDoc`: a copy that named the parent where the parent shows its
 * forms above would send the reader to a screen workers never see.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { menuScreenLines } from "../menuScreenCopy";

const PARENT = testUuid("copy-parent");
const CHILD = testUuid("copy-child");

function survey(uuid: string, name: string) {
	return {
		uuid,
		name,
		type: "survey" as const,
		fields: [f({ kind: "text", id: "note" })],
	};
}

function nested(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: "copy-parent",
				name: "Outreach",
				forms: [survey("copy-parent-form", "Plan visit")],
			},
			{
				uuid: "copy-child",
				name: "Follow-ups",
				forms: [survey("copy-child-form", "Log call")],
			},
		],
	});
	doc.modules[CHILD].parentModuleUuid = PARENT;
	return doc;
}

describe("where a menu's forms show, in the switch's line", () => {
	it("names the parent a submenu opens from while the parent keeps its screen", () => {
		expect(menuScreenLines(nested(), CHILD).line).toBe(
			"Workers open Follow-ups from Outreach, then choose a form.",
		);
	});

	it("names the app's first menu for a submenu whose parent shows its forms above", () => {
		const doc = nested();
		doc.modules[PARENT].formsInMenuAbove = true;
		expect(menuScreenLines(doc, CHILD).line).toBe(
			"Workers open Follow-ups from the app's first menu, then choose a form.",
		);
		expect(menuScreenLines(doc, PARENT).line).toBe(
			"Outreach's forms show in the app's first menu, and Outreach has no entry of its own.",
		);
	});
});
