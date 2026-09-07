import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import {
	formLinkCarryVerdict,
	formLinkManualCarryVerdict,
	formLinkRequiredDatums,
} from "@/lib/doc/formLinkReview";
import type { BlueprintDoc, FormLink } from "@/lib/domain";
import { carryValuesModel } from "../carryValuesModel";
import {
	CARE,
	fixture,
	INTAKE,
	SOURCE,
	toInspect,
	toNote,
	toVisit,
} from "./fixture";

function project(doc: BlueprintDoc, link: FormLink) {
	return carryValuesModel(
		link,
		formLinkCarryVerdict(doc, SOURCE, link.target),
		formLinkRequiredDatums(doc, SOURCE, link.target),
		formLinkManualCarryVerdict(doc, SOURCE, link.uuid, link.target),
	);
}
function selectionDoc() {
	const doc = produce(
		fixture([{ uuid: "carried-link", target: toVisit }]),
		(draft) => {
			for (const module of [INTAKE, CARE]) {
				const config = draft.modules[module].caseListConfig;
				if (!config) throw new Error("Missing selection");
				config.selection = { kind: "multiple", maximum: 10 };
			}
			draft.forms[SOURCE].type = "followup";
		},
	);
	assertAdmittedDoc(doc);
	return doc;
}
describe("carried-value presentation from real admission", () => {
	it("a case selection travels automatically without a scalar manual choice", () => {
		const doc = selectionDoc();
		const link = doc.forms[SOURCE].formLinks?.[0];
		if (!link) throw new Error("Missing link");
		expect(project(doc, link)).toStrictEqual({
			manual: false,
			manualCarryUnavailable: true,
			invalidManual: false,
			presentation: "collection",
			missing: [{ id: "selected_cases", caseType: "patient" }],
		});
	});
	it("a single new case can use either mode, with required identities derived from its destination", () => {
		const doc = fixture([{ uuid: "carried-link", target: toVisit }]);
		assertAdmittedDoc(doc);
		const link = doc.forms[SOURCE].formLinks?.[0];
		if (!link) throw new Error("Missing link");
		expect(project(doc, link)).toStrictEqual({
			manual: false,
			manualCarryUnavailable: false,
			invalidManual: false,
			presentation: "choices",
			missing: [{ id: "case_id", caseType: "patient" }],
		});
		const manual = {
			...link,
			datums: [{ name: "case_id", xpath: xp("'case-a'") }],
		};
		expect(project(doc, manual)).toStrictEqual({
			manual: true,
			manualCarryUnavailable: false,
			invalidManual: false,
			presentation: "choices",
			missing: [],
		});
	});
	it("a survey destination needs no carried values", () => {
		const doc = fixture([{ uuid: "carried-link", target: toNote }]);
		assertAdmittedDoc(doc);
		const link = doc.forms[SOURCE].formLinks?.[0];
		if (!link) throw new Error("Missing link");
		expect(project(doc, link).presentation).toBe("nothing");
	});
	it("defensive legacy-map projection disables an invalid scalar editor and retains the real recovery choice", () => {
		// Deliberately invalid legacy input; no claim that the current gate can create it.
		const doc = selectionDoc();
		const stale: FormLink = {
			uuid: testUuid("stale"),
			target: toVisit,
			datums: [{ name: "case_id", xpath: xp("'case-a'") }],
		};
		expect(project(doc, stale)).toStrictEqual({
			manual: true,
			manualCarryUnavailable: true,
			invalidManual: true,
			presentation: "choices",
			missing: [{ id: "selected_cases", caseType: "patient" }],
		});
		expect(project(doc, { ...stale, target: toInspect }).presentation).toBe(
			"destination-repair",
		);
	});
});
