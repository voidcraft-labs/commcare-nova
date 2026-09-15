import { expect, it } from "vitest";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { proseText, reachableCaseTypes } from "@/lib/domain";
import { caseDatabaseToFormPreloads } from "@/lib/preview/engine/caseDataBindingClient";
import { caseDatabaseXPathInstance } from "@/lib/preview/engine/xpathInstances";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import {
	type EvaluationScenario,
	evaluationScenarioCases,
} from "../evaluationScenario";

it("makes linked test records available to real XPath and preloads, refusing unrepresentable rows", () => {
	const doc = structuredClone(makeCanonicalGenesisDoc());
	doc.caseTypes = [
		{
			name: "household",
			properties: [{ name: "district", label: proseText("District") }],
		},
		{
			name: "visit",
			parent_type: "household",
			properties: [
				{ name: "score", label: proseText("Score"), data_type: "int" },
			],
		},
	];
	const records: EvaluationScenario["records"] = [
		{ id: "home", caseType: "household", properties: { district: "North" } },
		{
			id: "first",
			caseType: "visit",
			parentId: "home",
			properties: { score: 4 },
		},
		{
			id: "second",
			caseType: "visit",
			parentId: "home",
			properties: { score: 8 },
		},
	];
	const snapshot = evaluationScenarioCases(doc, "worker", { records });
	const instance = caseDatabaseXPathInstance(snapshot, doc.caseTypes);
	expect(
		evaluate(
			"sum(instance('casedb')/casedb/case[index/parent = 'home']/score)",
			{
				contextPath: "/data",
				position: undefined,
				getValue: () => undefined,
				resolveHashtag: () => "",
				mainInstance: instance,
				resolveXPathInstance: () => instance,
			},
		),
	).toBe(12);
	const preloads = caseDatabaseToFormPreloads(
		snapshot,
		"first",
		reachableCaseTypes("visit", doc.caseTypes),
	);
	expect(preloads?.get("visit")?.get("score")).toBe("4");
	expect(preloads?.get("household")?.get("district")).toBe("North");
	for (const invalid of [
		[...records, records[0]],
		[{ ...records[1], parentId: "missing" }],
		[{ ...records[0], parentId: "first" }, records[1]],
		[{ ...records[0], caseType: "missing" }],
		[{ ...records[0], properties: { unknown: "North" } }],
		[records[0], { ...records[1], properties: { score: "four" } }],
	])
		expect(() =>
			evaluationScenarioCases(doc, "worker", { records: invalid }),
		).toThrow();
});
