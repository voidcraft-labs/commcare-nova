import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { entryPointArguments } from "../entryPointLinks";
import type { PublishedEntryPoint } from "../entryPointTypes";

const MODULE = testUuid("patients");
const entry: PublishedEntryPoint = {
	target: { kind: "module", moduleUuid: MODULE },
	uuid: testUuid("entry"),
	id: "visit",
	signature: "not-used-by-argument-encoding",
	requiredSelections: [
		{
			moduleUuid: MODULE,
			caseType: "patient",
			argumentId: "case_id",
			cardinality: "one",
			maximum: 1,
		},
	],
};

it("transports a single external case ID intact and refuses a collection for a single selection", () => {
	const args = entryPointArguments(entry, [
		{ moduleUuid: MODULE, caseIds: ["hq +/中文?&="] },
	]);
	const decoded = new URLSearchParams(args.toString());
	expect([...decoded]).toEqual([["case_id", "hq +/中文?&="]]);
	expect(() =>
		entryPointArguments(entry, [{ moduleUuid: MODULE, caseIds: ["a", "b"] }]),
	).toThrow("Choose one case");
	expect(() =>
		entryPointArguments(entry, [
			{ moduleUuid: testUuid("other"), caseIds: ["a"] },
		]),
	).toThrow("Choose one case");
});

it("needs no arguments for an entry point without selections and refuses unsolicited case IDs", () => {
	const noSelections = { ...entry, requiredSelections: [] };
	expect(entryPointArguments(noSelections, []).toString()).toBe("");
	expect(() =>
		entryPointArguments(noSelections, [{ moduleUuid: MODULE, caseIds: ["a"] }]),
	).toThrow("without extra or repeated selections");
});
