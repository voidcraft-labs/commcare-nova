/**
 * Deterministic complexity depth — same contract, same score, always; the
 * thresholds place the fixture where its shape says it belongs.
 */

import { describe, expect, it } from "vitest";
import { computeDesignComplexity } from "@/lib/agent/design/complexity";
import { cloneContract, makeContract } from "./fixtures";

describe("computeDesignComplexity", () => {
	it("is deterministic and persists its components", () => {
		const first = computeDesignComplexity(makeContract());
		const second = computeDesignComplexity(makeContract());
		expect(first).toEqual(second);
		expect(first.algorithmVersion).toBe(1);
		expect(first.components.recordCount).toBe(2);
		expect(first.components.hasRecordHierarchy).toBe(true);
	});

	it("scores the fixture as standard", () => {
		// records>=2 (+1), hierarchy (+1), actors>=2 (+1), access>0 (+1),
		// lookup fact (+1), sensitive fact (+1) = 6.
		const evidence = computeDesignComplexity(makeContract());
		expect(evidence.score).toBe(6);
		expect(evidence.depth).toBe("standard");
	});

	it("scores a single-actor, single-record survey as compact", () => {
		const contract = cloneContract(makeContract());
		const chw = contract.actors[0];
		const patient = contract.records[0];
		if (!chw || !patient) throw new Error("fixture has actors and records");
		contract.actors = [chw];
		contract.records = [patient];
		contract.facts = contract.facts
			.filter((fact) => fact.recordId === patient.id)
			.map((fact) => ({ ...fact, sensitivity: "ordinary" as const }));
		contract.accessPolicies = [];
		const evidence = computeDesignComplexity(contract);
		expect(evidence.depth).toBe("compact");
	});

	it("crosses into extended with enough workflow shape", () => {
		// Complexity is pure arithmetic over the shape and deliberately does
		// not re-validate the graph, so the clone can pile shape on freely.
		const contract = cloneContract(makeContract());
		const actor = contract.actors[0];
		const rule = contract.rules[0];
		const model = contract.readModels[0];
		const policy = contract.accessPolicies[0];
		const transition = contract.transitions[1];
		const fact = contract.facts[0];
		if (!actor || !rule || !model || !policy || !transition || !fact) {
			throw new Error("fixture is complete");
		}
		contract.actors.push({ ...actor });
		transition.transitionKind = "link";
		contract.readModels.push({ ...model });
		contract.rules.push({ ...rule }, { ...rule });
		policy.locationScopeIntent = "Assigned village only";
		fact.source = {
			kind: "lookup",
			lookupIntentId: fact.id,
			columnIntentId: fact.id,
		};
		const evidence = computeDesignComplexity(contract);
		expect(evidence.score).toBeGreaterThanOrEqual(7);
		expect(evidence.depth).toBe("extended");
	});
});
