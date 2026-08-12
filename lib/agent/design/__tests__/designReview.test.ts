import { describe, expect, it } from "vitest";
import { renderCitableSourceCoordinates } from "@/lib/agent/design/prompts";
import type { DesignFinding, DesignReview } from "@/lib/agent/design/review";
import {
	designFindingSchema,
	designReviewSchemaFor,
	designRevisionResultSchemaFor,
	findingBlocksAcceptance,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import {
	citableSourceRefs,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
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

	it("names the offending coordinate when a citation misses the package", () => {
		const schema = designReviewSchemaFor(makeContract(), pkg());
		const result = schema.safeParse(
			review([
				finding({
					evidenceRefs: [{ ...messageRef(5), messageId: "invented-id" }],
				}),
			]),
		);
		expect(result.success).toBe(false);
		const message = result.success
			? ""
			: (result.error.issues[0]?.message ?? "");
		// The composed key makes the failure diagnosable from the operational
		// log alone — the exact gap that hid what a live reviewer invented.
		expect(message).toContain("message:");
		expect(message).toContain("invented-id");
		expect(message).toContain(":5");
	});
});

describe("citation grounding stays in lockstep with the review prompt", () => {
	function richPackage(): DesignSourcePackage {
		const attachmentRef = {
			kind: "attachment-extract" as const,
			assetId: "00000000-0000-4000-8000-000000000860" as never,
			extractorVersion: 3,
			sectionPath: [],
		};
		return {
			...pkg(),
			claims: [
				{
					id: did(700),
					statement: "The user answered the pilot questions.",
					// One NEW coordinate plus a duplicate of the projected block —
					// the citable set must dedup, not double-list.
					sourceRefs: [messageRef(9), messageRef()],
					status: "explicit",
					confidence: 1,
				},
			],
			attachments: [
				{
					assetId: attachmentRef.assetId,
					extractorVersion: 3,
					filename: "spec.pdf",
					extract: "## Requirements\nTrack visits.",
					truncated: false,
				},
			],
			sources: [{ ref: messageRef() }, { ref: attachmentRef }],
		};
	}

	it("admits exactly the coordinates the prompt renders, including claim refs", () => {
		const sourcePackage = richPackage();
		const schema = designReviewSchemaFor(makeContract(), sourcePackage);
		const refs = citableSourceRefs(sourcePackage);
		// message block + attachment + the claim's extra coordinate, deduped.
		expect(refs).toHaveLength(3);
		for (const ref of refs) {
			expect(
				schema.safeParse(review([finding({ evidenceRefs: [ref] })])).success,
			).toBe(true);
		}
		const rendered = renderCitableSourceCoordinates(sourcePackage);
		expect(rendered.match(/^- /gm)).toHaveLength(refs.length);
		expect(rendered).toContain("partIndex 9");
		expect(rendered).toContain("extractorVersion 3");
	});

	it("matches an attachment citation on identity, not sectionPath", () => {
		const sourcePackage = richPackage();
		const schema = designReviewSchemaFor(makeContract(), sourcePackage);
		const cited = {
			kind: "attachment-extract" as const,
			assetId: "00000000-0000-4000-8000-000000000860" as never,
			extractorVersion: 3,
			sectionPath: ["Requirements"],
			figureMarker: '<nova:figure index="1"/>',
		};
		expect(
			schema.safeParse(review([finding({ evidenceRefs: [cited] })])).success,
		).toBe(true);
		expect(
			schema.safeParse(
				review([
					finding({ evidenceRefs: [{ ...cited, extractorVersion: 4 }] }),
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
