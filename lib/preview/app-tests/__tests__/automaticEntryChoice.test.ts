/**
 * An App Test opens a form whose menu's list opens a single match
 * automatically the way a device does: the form keeps its menu's choices,
 * its datum is written `autoselect="true"`, so the walk reaches that list as
 * an automatic step and a lone household opens the form without a tap. The
 * failure: the test reaches the ordinary case list and waits for a choice a
 * device never asks for.
 */

import { expect, it } from "vitest";
import {
	advancedFixture,
	HOUSEHOLDS,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import type { BlueprintDoc } from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { previewAsMe } from "../../engine/identity";
import { previewLookupData } from "../../engine/lookupEvaluation";
import type { AppTestContext } from "../context";
import { appTestFormOpening, enterAppTestForm } from "../navigation";
import type { AppTestSessionState } from "../types";

function contextOf(doc: BlueprintDoc): AppTestContext {
	return {
		doc,
		language: effectiveAppLocalization(doc.localization).defaultLanguage,
		identity: previewAsMe({ id: "worker", name: "Worker" }, doc),
		device: webAppsDevice(),
		lookup: previewLookupData({
			projectRevision: "auto",
			definitions: [],
			rowsByTable: new Map(),
		}),
	} as unknown as AppTestContext;
}

const onMenu = {
	screen: { kind: "menu", moduleUuid: HOUSEHOLDS },
	history: [],
	selections: {},
	deviceCases: { rows: [], indices: [] },
} as unknown as AppTestSessionState;

function automatic(on: boolean) {
	const { doc, formUuid } = advancedFixture({
		formType: "followup",
		operations: () => [],
	});
	if (on)
		doc.modules[HOUSEHOLDS] = {
			...doc.modules[HOUSEHOLDS],
			autoSelectSingle: true,
		};
	return { doc, formUuid };
}

it("walks a menu's own choice that opens its single match automatically, and opens the form on the case chosen", () => {
	const { doc, formUuid } = automatic(true);
	const context = contextOf(doc);
	const [own] = formCaseSelections(doc, formUuid);
	const screen = enterAppTestForm(context, onMenu, HOUSEHOLDS, formUuid);
	expect(screen).toMatchObject({
		kind: "records",
		moduleUuid: HOUSEHOLDS,
		formEntry: {
			formUuid,
			choices: [],
			next: { selectionUuid: own.uuid, autoSelectSingle: true },
		},
	});
	expect(
		appTestFormOpening(context, onMenu, HOUSEHOLDS, formUuid, [
			{ selectionUuid: own.uuid, caseId: "household-1" },
		]),
	).toMatchObject({
		kind: "form",
		moduleUuid: HOUSEHOLDS,
		formUuid,
		caseIds: ["household-1"],
	});
});

it("reaches the ordinary case list where the list never opens its single match automatically", () => {
	const { doc, formUuid } = automatic(false);
	const screen = enterAppTestForm(contextOf(doc), onMenu, HOUSEHOLDS, formUuid);
	expect(screen).toMatchObject({ kind: "records", moduleUuid: HOUSEHOLDS });
	expect(screen).not.toHaveProperty("formEntry");
});
