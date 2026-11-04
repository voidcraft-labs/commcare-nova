/**
 * The HQ import file's guide asks about the two project-space settings an
 * app needs off: links between cases of the same type, which get their own
 * step rather than a line in the capabilities step (whose features Dimagi
 * turns on), and CommCare Supply. Catches a guide that files the same-type
 * links under "turn on", or misses either step for an app that needs it.
 */

import { describe, expect, it } from "vitest";
import type { CaseOperation } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import {
	childCreate,
	own,
	placementFixture,
} from "../../__tests__/placementFixture";
import { SUPPLY_POINT_SESSION_TEXT } from "../../xform/supplyPointText";
import { hqImportFileGuide } from "../hqJsonExportArchive";

const twin = (formType: Parameters<typeof childCreate>[1]): CaseOperation =>
	({
		...childCreate("twin", formType),
		caseType: "patient",
	}) as CaseOperation;

function guide(doc: ReturnType<typeof placementFixture>["doc"]) {
	return hqImportFileGuide({
		appName: "Clinic",
		doc,
		assets: new Map(),
		lookupWorkbook: undefined,
		attachmentTarget: null,
		lookupNaming: undefined,
	});
}

describe("hqImportFileGuide's settings that must be off", () => {
	it("gives same-type links a step of their own, naming the form, and leaves them out of the capabilities step", () => {
		const { doc } = placementFixture("followup", {
			operations: (t) => [own(), twin(t)],
		});
		const steps = guide(doc);
		const sameType = steps.find(
			(step) => step.kind === "same-type-child-links",
		);
		expect(sameType?.lines[0]).toContain("Under test");
		const capabilities = steps.find((step) => step.kind === "capabilities");
		expect(
			capabilities?.lines.some((line) =>
				line.includes("Links between cases of the same type"),
			) ?? false,
		).toBe(false);
		expect(steps.some((step) => step.kind === "commtrack-off")).toBe(false);
	});

	it("asks about CommCare Supply for a form holding the supply point text, and nothing about same-type links for another type's child", () => {
		const { doc } = placementFixture("followup", {
			operations: (t) => [own(), childCreate("kid", t)],
			extraRoot: [
				{
					kind: "label",
					id: "place_note",
					label: proseText(SUPPLY_POINT_SESSION_TEXT),
				},
			],
		});
		const steps = guide(doc);
		expect(steps.some((step) => step.kind === "commtrack-off")).toBe(true);
		expect(steps.some((step) => step.kind === "same-type-child-links")).toBe(
			false,
		);
	});
});
