/**
 * `getModule`'s `advanced` read, through the real tool body and the authored
 * projection every client sees. The plausible failures: a menu CommCare HQ
 * receives as advanced read as ordinary (an author then edits a published
 * menu blind to its kind), a kept kind read as one an edit can undo, or an
 * ordinary menu read as advanced. Documents come from the menu-kind fixture
 * and the real commit gate.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import {
	carryVisit,
	HOUSEHOLDS,
	kindFixture,
	publishedAdvanced,
	publishedBasic,
	VISITS,
} from "@/lib/doc/__tests__/moduleKindMoveFixture";
import { verdict } from "@/lib/doc/__tests__/placementMoveFixture";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { getModuleTool } from "../getModule";

const advancedRead = z.object({
	advanced: z.strictObject({ kept: z.boolean() }).nullable(),
});

/** The authored `advanced` read of `moduleUuid` in `doc`. */
async function readAdvanced(doc: BlueprintDoc, moduleUuid: Uuid) {
	const h = makeToolWorkspaceHarness(doc);
	const read = await h.runTool(getModuleTool, { moduleUuid });
	const authored = projectAuthoringRead({
		toolName: "getModule",
		data: read.data,
		doc: h.currentDoc(),
	});
	return advancedRead.parse(authored).advanced;
}

describe("getModule — advanced", () => {
	it("reads a menu a carried create makes advanced, not kept", async () => {
		const result = verdict(kindFixture(), carryVisit());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(emittedModuleKind(result.nextDoc, HOUSEHOLDS)).toBe("advanced");
		expect(await readAdvanced(result.nextDoc, HOUSEHOLDS)).toEqual({
			kept: false,
		});
		// The link's target menu carries nothing and stays ordinary.
		expect(await readAdvanced(result.nextDoc, VISITS)).toBeNull();
	});

	it("reads a menu a published app keeps advanced as kept", async () => {
		const doc = expectAdmittedDoc(publishedAdvanced(kindFixture(), HOUSEHOLDS));
		expect(await readAdvanced(doc, HOUSEHOLDS)).toEqual({ kept: true });
	});

	it("reads an ordinary menu, published or not, as null", async () => {
		for (const doc of [
			expectAdmittedDoc(kindFixture()),
			expectAdmittedDoc(publishedBasic(kindFixture(), HOUSEHOLDS)),
		])
			expect(await readAdvanced(doc, HOUSEHOLDS)).toBeNull();
	});
});
