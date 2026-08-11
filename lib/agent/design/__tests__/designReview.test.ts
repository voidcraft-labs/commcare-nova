import { describe, expect, it } from "vitest";
import type { DesignFinding, DesignReview } from "@/lib/agent/design/review";
import {
	designFindingSchema,
	designReviewSchemaFor,
	designRevisionResultSchemaFor,
	findingBlocksAcceptance,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { cloneContract, did, ids, makeContract, messageRef } from "./fixtures";

function pkg(): DesignSourcePackage {
	return {
		schemaVersion: 1,
		designSessionId: "00000000-0000-4000-8000-000000000700",
		projectId: "project-1",
		packageDigest: "a".repeat(64),
		request: {
			blocks: [{ ref: messageRef(), text: "Track visits.", truncated: false }],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref: messageRef() }],
	};
}

function finding(overrides: Partial<DesignFinding> = {}): DesignFinding {
	return designFindingSchema.parse({
		id: did(300),
		category: "workflow-gap",
		severity: "important",
		basis: "source-supported",
		dispositionClass: "design-correction",
		claim: "The visit result is not shown after submission.",
		evidenceRefs: [messageRef()],
		affectedElementIds: [ids.taskVisit],
		proposedResolution: "Show the saved visit summary.",
		...overrides,
	});
}

function review(findings: DesignFinding[]): DesignReview {
	return {
		schemaVersion: 1,
		id: did(400),
		summary: "Focused review",
		findings,
	};
}

describe("review findings", () => {
	it("requires citations for important and critical findings", () => {
		expect(
			designFindingSchema.safeParse({ ...finding(), evidenceRefs: [] }).success,
		).toBe(false);
	});

	it("keeps advisory findings citation-free and non-blocking", () => {
		const advisory = finding({
			severity: "advisory",
			basis: "heuristic",
			dispositionClass: "advisory",
			evidenceRefs: [],
		});
		expect(findingBlocksAcceptance(advisory)).toBe(false);
		expect(
			designFindingSchema.safeParse({
				...advisory,
				evidenceRefs: [messageRef()],
			}).success,
		).toBe(false);
	});

	it("blocks only design corrections and user decisions", () => {
		expect(findingBlocksAcceptance(finding())).toBe(true);
		expect(
			findingBlocksAcceptance(
				finding({ dispositionClass: "runtime-readiness" }),
			),
		).toBe(false);
		expect(
			findingBlocksAcceptance(
				finding({ dispositionClass: "user-decision", severity: "important" }),
			),
		).toBe(true);
	});

	it("binds element ids and citations to the reviewed artifacts", () => {
		const schema = designReviewSchemaFor(makeContract(), pkg());
		expect(schema.safeParse(review([finding()])).success).toBe(true);
		expect(
			schema.safeParse(review([finding({ affectedElementIds: [did(9999)] })]))
				.success,
		).toBe(false);
		expect(
			schema.safeParse(
				review([
					finding({
						evidenceRefs: [{ ...messageRef(), messageId: "not-in-package" }],
					}),
				]),
			).success,
		).toBe(false);
	});
});

describe("blocking dispositions", () => {
	it("requires exactly one disposition for each blocking finding", () => {
		const schema = designRevisionResultSchemaFor([review([finding()])]);
		expect(
			schema.safeParse({ contract: makeContract(), dispositions: [] }).success,
		).toBe(false);
		expect(
			schema.safeParse({
				contract: makeContract(),
				dispositions: [
					{
						findingId: did(300),
						status: "accepted",
						rationale: "The readback now confirms the saved visit.",
					},
				],
			}).success,
		).toBe(true);
	});

	it("does not require dispositions for readiness or advisory findings", () => {
		const readiness = finding({ dispositionClass: "deployment-readiness" });
		const advisory = finding({
			id: did(301),
			severity: "advisory",
			basis: "heuristic",
			dispositionClass: "advisory",
			evidenceRefs: [],
		});
		expect(
			designRevisionResultSchemaFor([review([readiness, advisory])]).safeParse({
				contract: makeContract(),
				dispositions: [],
			}).success,
		).toBe(true);
	});

	it("requires a visible consequence for an unresolved user decision", () => {
		const userDecision = finding({ dispositionClass: "user-decision" });
		const schema = designRevisionResultSchemaFor([review([userDecision])]);
		expect(
			schema.safeParse({
				contract: makeContract(),
				dispositions: [
					{
						findingId: userDecision.id,
						status: "deferred-with-user-visible-consequence",
						rationale: "The person must choose.",
					},
				],
			}).success,
		).toBe(false);
	});

	it("keeps a deferred user decision linked to a blocking question", () => {
		const userDecision = finding({ dispositionClass: "user-decision" });
		const schema = designRevisionResultSchemaFor([review([userDecision])]);
		const disposition = {
			findingId: userDecision.id,
			status: "deferred-with-user-visible-consequence" as const,
			rationale: "The person must choose before construction.",
			userVisibleConsequence: "The build waits for this choice.",
		};
		expect(
			schema.safeParse({
				contract: makeContract(),
				dispositions: [disposition],
			}).success,
		).toBe(false);

		const contract = cloneContract(makeContract());
		contract.openQuestions.push({
			id: ids.question,
			question: "Should the saved visit be shown after submission?",
			structuralImpact: "local",
			blocking: true,
			relatedElementIds: [ids.taskVisit],
		});
		expect(
			schema.safeParse({ contract, dispositions: [disposition] }).success,
		).toBe(true);
	});
});

describe("sensitivity preservation", () => {
	it("rejects a quiet downgrade and allows only a correction naming that property", () => {
		const parent = makeContract();
		const revised = cloneContract(parent);
		const property = revised.records[0]?.properties.find(
			(entry) => entry.id === ids.factRisk,
		);
		if (!property) throw new Error("risk property missing");
		property.sensitivity = "ordinary";
		const result = {
			contract: revised,
			dispositions: [
				{
					findingId: did(302),
					status: "accepted" as const,
					rationale: "The source explicitly classifies this as ordinary.",
				},
			],
		};
		expect(validateSensitivityNotSilentlyLowered(parent, result)).toHaveLength(
			1,
		);
		const sensitivityFinding = finding({
			id: did(302),
			category: "privacy-and-sensitivity",
			affectedElementIds: [ids.factRisk],
		});
		expect(
			validateSensitivityNotSilentlyLowered(parent, result, [
				review([sensitivityFinding]),
			]),
		).toEqual([]);
	});
});
