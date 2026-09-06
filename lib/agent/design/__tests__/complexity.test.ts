import { describe, expect, it } from "vitest";
import { computeDesignComplexity } from "../complexity";
import { type AppDesignContract, appDesignContractSchema } from "../contract";
import {
	did,
	fixtureValue,
	makeContract,
	makeNestedMenuContract,
	makeWorkflowChainContract,
} from "./fixtures";

function evidence(contract: AppDesignContract) {
	const admitted = appDesignContractSchema.parse(contract);
	const before = structuredClone(admitted);
	const result = computeDesignComplexity(admitted);
	expect(admitted).toEqual(before);
	return result;
}

describe("design process depth from admitted workflow shapes", () => {
	it("records the readings behind an ordinary hierarchical program", () => {
		expect(evidence(makeContract())).toEqual({
			algorithmVersion: 2,
			score: 5,
			depth: "standard",
			components: {
				recordCount: 2,
				hasRecordHierarchy: true,
				actorCount: 2,
				workflowCount: 2,
				linkingEffects: 0,
				decisionCount: 1,
				listCount: 1,
				accessPolicyCount: 1,
				hasLocationScope: false,
				externalReferenceCount: 0,
				sensitivePropertyCount: 2,
				nestedMenuCount: 0,
			},
		});
	});
	it.each([
		[1, 0, "compact"],
		[2, 1, "compact"],
		[3, 2, "compact"],
		[5, 2, "compact"],
		[6, 3, "standard"],
		[13, 3, "standard"],
	] as const)(
		"classifies %i workflows with score %i as %s",
		(count, score, depth) => {
			const result = evidence(makeWorkflowChainContract(count));
			expect(result).toMatchObject({
				score,
				depth,
				components: { recordCount: count, workflowCount: count },
			});
		},
	);
	it("places the standard/extended threshold between six and seven independent risks", () => {
		const standard = makeNestedMenuContract();
		expect(evidence(standard)).toMatchObject({
			score: 6,
			depth: "standard",
			components: { nestedMenuCount: 1 },
		});
		fixtureValue(standard.access[0], "supervisor access").locationScope =
			"Assigned clinic";
		expect(evidence(standard)).toMatchObject({
			score: 7,
			depth: "extended",
			components: { hasLocationScope: true },
		});
	});
	it("counts actor handoffs at two and three without growing forever with actor labels", () => {
		const contract = makeContract();
		const actor = fixtureValue(contract.actors[0], "worker");
		contract.actors.push({
			...structuredClone(actor),
			id: did(12),
			name: "Clinic reviewer",
		});
		expect(evidence(contract)).toMatchObject({
			score: 6,
			components: { actorCount: 3 },
		});
		contract.actors.push({
			...structuredClone(actor),
			id: did(13),
			name: "Program reviewer",
		});
		expect(evidence(contract)).toMatchObject({
			score: 6,
			components: { actorCount: 4 },
		});
	});
	it.each(["link", "reassign"] as const)(
		"prices explicit %s effects",
		(kind) => {
			const contract = makeContract();
			const workflow = fixtureValue(contract.workflows[1], "visit workflow");
			workflow.recordEffects.push({
				handle: `additional_${kind}`,
				recordId: fixtureValue(contract.records[1], "visit record").id,
				sourceRecordId: fixtureValue(contract.records[0], "patient record").id,
				kind,
				writes: [],
				outcome: "Connect the completed visit to its patient.",
			});
			expect(evidence(contract)).toMatchObject({
				score: 6,
				components: { linkingEffects: 1 },
			});
		},
	);
	it("prices three workflow decisions, not architecture notes", () => {
		const contract = makeContract();
		const workflow = fixtureValue(contract.workflows[0], "registration");
		const decision = fixtureValue(workflow.decisions[0], "triage");
		workflow.decisions.push({
			...structuredClone(decision),
			handle: "follow_up",
			name: "Arrange follow-up",
		});
		expect(evidence(contract)).toMatchObject({
			score: 5,
			components: { decisionCount: 2 },
		});
		workflow.decisions.push({
			...structuredClone(decision),
			handle: "review",
			name: "Choose review queue",
		});
		expect(evidence(contract)).toMatchObject({
			score: 6,
			components: { decisionCount: 3 },
		});
	});
	it("distinguishes existing references from later deployment readiness", () => {
		const contract = makeContract();
		const workflow = fixtureValue(contract.workflows[0], "registration");
		workflow.externalRequirementIds.push(did(161));
		contract.externalRequirements.push({
			id: did(161),
			name: "Reference material",
			kind: "existing-reference",
			description: "Use the supplied reference material.",
			relatedWorkflowIds: [workflow.id],
			blocksConstruction: false,
		});
		expect(evidence(contract)).toMatchObject({
			score: 6,
			components: { externalReferenceCount: 1 },
		});
		fixtureValue(contract.externalRequirements[0], "reference").kind =
			"deployment-readiness";
		expect(evidence(contract)).toMatchObject({
			score: 5,
			components: { externalReferenceCount: 0 },
		});
	});
	it("prices sensitivity once while retaining the exact property reading", () => {
		const contract = makeContract();
		for (const record of contract.records)
			for (const property of record.properties)
				property.sensitivity = "ordinary";
		expect(evidence(contract)).toMatchObject({
			score: 4,
			components: { sensitivePropertyCount: 0 },
		});
		fixtureValue(
			fixtureValue(contract.records[0], "patient").properties[0],
			"name",
		).sensitivity = "sensitive";
		expect(evidence(contract)).toMatchObject({
			score: 5,
			components: { sensitivePropertyCount: 1 },
		});
	});
});
