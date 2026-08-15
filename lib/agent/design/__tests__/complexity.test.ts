import { describe, expect, it } from "vitest";
import {
	computeDesignComplexity,
	DESIGN_EFFORT_TIME_ESTIMATES,
} from "@/lib/agent/design/complexity";
import { cloneContract, did, fixtureValue, makeContract } from "./fixtures";

describe("computeDesignComplexity", () => {
	it("is deterministic and records semantic shape", () => {
		const first = computeDesignComplexity(makeContract());
		expect(computeDesignComplexity(makeContract())).toEqual(first);
		expect(first.components.recordCount).toBe(2);
		expect(first.components.workflowCount).toBe(2);
		expect(first.components.hasRecordHierarchy).toBe(true);
	});

	it("assigns a conservative effort estimate", () => {
		const evidence = computeDesignComplexity(makeContract());
		expect(["compact", "standard", "extended"]).toContain(evidence.depth);
		expect(DESIGN_EFFORT_TIME_ESTIMATES[evidence.depth]).toMatch(/about/);
	});

	it("moves a genuinely broader workflow shape to extended", () => {
		const contract = cloneContract(makeContract());
		const actor = fixtureValue(contract.actors[0], "first actor");
		const workflow = fixtureValue(contract.workflows[1], "second workflow");
		const access = fixtureValue(contract.access[0], "first access policy");
		contract.actors.push({ ...actor, id: did(12) });
		contract.workflows.push(
			...Array.from({ length: 5 }, (_, index) => ({
				...workflow,
				id: did(500 + index),
				recordEffects: workflow.recordEffects.map((effect) => ({
					...effect,
					kind: "link" as const,
				})),
			})),
		);
		access.locationScope = "Assigned facility";
		expect(computeDesignComplexity(contract).depth).toBe("extended");
	});
});
