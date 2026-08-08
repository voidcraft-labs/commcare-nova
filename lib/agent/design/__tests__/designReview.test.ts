/**
 * Review grounding, disposition closure, and the sensitivity pair rule —
 * the epistemic fences that make "reviewed" mean something.
 */

import { describe, expect, it } from "vitest";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import type { DesignFinding, DesignReview } from "@/lib/agent/design/review";
import {
	designFindingSchema,
	designReviewSchemaFor,
	designRevisionResultSchemaFor,
	findingDispositionSchema,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import {
	cloneContract,
	did,
	FIXTURE_IMAGE_ASSET_ID,
	FIXTURE_IMAGE_DIGEST,
	ids,
	imageRef,
	makeContract,
	messageRef,
} from "./fixtures";

const SESSION_ID = "00000000-0000-4000-8000-000000000700";

function makeSourcePackage(): DesignSourcePackage {
	return {
		schemaVersion: 1,
		designSessionId: SESSION_ID,
		projectId: "proj-1",
		packageDigest: "b".repeat(64),
		request: {
			blocks: [
				{ ref: messageRef(), text: "Track CHW visits.", truncated: false },
			],
		},
		claims: [],
		attachments: [],
		images: [
			{
				assetId: asMediaAssetId(FIXTURE_IMAGE_ASSET_ID),
				mediaType: "image/png",
				filename: "queue-mockup.png",
				bytesDigest: FIXTURE_IMAGE_DIGEST,
				dataUrl: "data:image/png;base64,AAAA",
			},
		],
		platformConstraints: [],
		sources: [{ ref: messageRef() }, { ref: imageRef() }],
	};
}

function makeFinding(overrides: Partial<DesignFinding> = {}): DesignFinding {
	return designFindingSchema.parse({
		id: did(300),
		category: "requirement-coverage",
		severity: "important",
		basis: "source-supported",
		claim: "The visit summary is captured but nothing reads it back.",
		evidenceRefs: [messageRef()],
		affectedIntentIds: [ids.factVisitSummary],
		confidence: 0.8,
		...overrides,
	});
}

function makeReview(findings: DesignFinding[]): DesignReview {
	return {
		schemaVersion: 1,
		id: did(400),
		summary: "One coverage gap; otherwise coherent.",
		findings,
	};
}

describe("finding grounding (validateFindingEvidence)", () => {
	it("accepts a grounded important source-supported finding", () => {
		expect(() => makeFinding()).not.toThrow();
	});

	it("rejects a critical heuristic finding", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			severity: "critical",
			basis: "heuristic",
		});
		expect(result.success).toBe(false);
	});

	it("accepts an advisory heuristic finding", () => {
		expect(
			designFindingSchema.safeParse({
				...makeFinding(),
				severity: "advisory",
				basis: "heuristic",
			}).success,
		).toBe(true);
	});

	it("rejects a source-supported critical finding without source evidence", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			severity: "critical",
			evidenceRefs: [],
		});
		expect(result.success).toBe(false);
	});

	it("accepts an important source-supported finding grounded in an image", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			evidenceRefs: [imageRef()],
		});
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues, null, 2),
		).toBe(true);
	});

	it("rejects a platform-constraint finding without a catalogued code", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			basis: "platform-constraint",
			evidenceRefs: [messageRef()],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a contract-internal critical finding naming no intents", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			basis: "contract-internal",
			severity: "critical",
			affectedIntentIds: [],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a missing-intent flag with no evidence at all", () => {
		const result = designFindingSchema.safeParse({
			...makeFinding(),
			basis: "heuristic",
			severity: "advisory",
			affectedIntentIds: [],
			evidenceRefs: [],
		});
		expect(result.success).toBe(false);
	});
});

describe("designReviewSchemaFor — cross-artifact binding", () => {
	const contract = appDesignContractSchema.parse(makeContract());
	const pkg = makeSourcePackage();

	it("accepts a review citing real intents and package sources", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		expect(schema.safeParse(makeReview([makeFinding()])).success).toBe(true);
	});

	it("rejects a finding citing an intent absent from the reviewed revision", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const finding = makeFinding({ affectedIntentIds: [did(9999)] });
		const result = schema.safeParse(makeReview([finding]));
		expect(result.success).toBe(false);
	});

	it("rejects evidence outside the reviewed source package", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const foreign = makeFinding({
			evidenceRefs: [
				{
					kind: "message",
					threadId: "00000000-0000-4000-8000-111111111111",
					messageId: "other",
					partIndex: 0,
				},
			],
		});
		const result = schema.safeParse(makeReview([foreign]));
		expect(result.success).toBe(false);
	});

	it("accepts a finding citing an image the package projected", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const finding = makeFinding({ evidenceRefs: [imageRef()] });
		const result = schema.safeParse(makeReview([finding]));
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues, null, 2),
		).toBe(true);
	});

	it("rejects an image citation whose digest is not the projected content", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const finding = makeFinding({
			evidenceRefs: [imageRef(FIXTURE_IMAGE_ASSET_ID, "d".repeat(64))],
		});
		expect(schema.safeParse(makeReview([finding])).success).toBe(false);
	});

	it("rejects an image citation for an asset the package never projected", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const finding = makeFinding({
			evidenceRefs: [
				imageRef("00000000-0000-4000-8000-000000000889", FIXTURE_IMAGE_DIGEST),
			],
		});
		expect(schema.safeParse(makeReview([finding])).success).toBe(false);
	});

	it("accepts a finding citing a lookup intent of the reviewed revision", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const finding = makeFinding({
			claim: "The villages table carries no column for the assigned CHW.",
			affectedIntentIds: [ids.lookupVillages, ids.lookupColClinic],
		});
		const result = schema.safeParse(makeReview([finding]));
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues, null, 2),
		).toBe(true);
	});

	it("always allows catalogued platform references", () => {
		const schema = designReviewSchemaFor(contract, pkg);
		const platform = makeFinding({
			basis: "platform-constraint",
			evidenceRefs: [
				{
					kind: "platform-constraint",
					code: "AUTOMATION_HQ_MANUAL_SETUP",
					sourceAnchor: "lib/agent/tools/automations.ts",
				},
			],
		});
		expect(schema.safeParse(makeReview([platform])).success).toBe(true);
	});
});

describe("dispositions", () => {
	it("rejects a deferred disposition without its user-visible consequence", () => {
		const result = findingDispositionSchema.safeParse({
			findingId: did(300),
			status: "deferred-with-user-visible-consequence",
			rationale: "Later release.",
			resultingIntentIds: [],
		});
		expect(result.success).toBe(false);
	});

	it("rejects an accepted disposition with no resulting intents", () => {
		const result = findingDispositionSchema.safeParse({
			findingId: did(300),
			status: "accepted",
			rationale: "Fixed.",
			resultingIntentIds: [],
		});
		expect(result.success).toBe(false);
	});
});

describe("validateDispositionClosure (designRevisionResultSchemaFor)", () => {
	const finding = makeFinding();
	const review = makeReview([finding]);

	function acceptedResult() {
		const revised = cloneContract(makeContract());
		// Resolve the finding: the supervisor queue now reads the summary.
		revised.facts
			.find((fact) => fact.id === ids.factVisitSummary)
			?.readerIds.push(ids.rmPatients);
		return {
			contract: revised,
			dispositions: [
				{
					findingId: finding.id,
					status: "accepted" as const,
					rationale: "The queue detail now shows the visit summary.",
					resultingIntentIds: [ids.factVisitSummary],
				},
			],
		};
	}

	it("accepts a closed revision result", () => {
		const schema = designRevisionResultSchemaFor([review]);
		const result = schema.safeParse(acceptedResult());
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues, null, 2),
		).toBe(true);
	});

	it("rejects a missing disposition for an important finding", () => {
		const schema = designRevisionResultSchemaFor([review]);
		const result = schema.safeParse({
			contract: makeContract(),
			dispositions: [],
		});
		expect(result.success).toBe(false);
	});

	it("rejects a disposition for a finding no review raised", () => {
		const schema = designRevisionResultSchemaFor([review]);
		const base = acceptedResult();
		base.dispositions.push({
			findingId: did(9998),
			status: "accepted",
			rationale: "Phantom.",
			resultingIntentIds: [ids.factVisitSummary],
		});
		expect(schema.safeParse(base).success).toBe(false);
	});

	it("rejects a duplicate disposition", () => {
		const schema = designRevisionResultSchemaFor([review]);
		const base = acceptedResult();
		base.dispositions.push({ ...base.dispositions[0] });
		expect(schema.safeParse(base).success).toBe(false);
	});

	it("rejects accepted resolutions pointing outside the revised contract", () => {
		const schema = designRevisionResultSchemaFor([review]);
		const base = acceptedResult();
		const first = base.dispositions[0];
		if (!first) throw new Error("has a disposition");
		first.resultingIntentIds = [did(9997)];
		expect(schema.safeParse(base).success).toBe(false);
	});

	it("rejects a deferred CRITICAL finding with no visible trace, and accepts one surfaced as a blocking question", () => {
		const critical = makeFinding({ id: did(301), severity: "critical" });
		const schema = designRevisionResultSchemaFor([makeReview([critical])]);

		const hidden = {
			contract: makeContract(),
			dispositions: [
				{
					findingId: critical.id,
					status: "deferred-with-user-visible-consequence" as const,
					rationale: "Deferring.",
					resultingIntentIds: [ids.taskVisit],
					userVisibleConsequence: "Summaries stay invisible to supervisors.",
				},
			],
		};
		expect(schema.safeParse(hidden).success).toBe(false);

		const surfaced = cloneContract(makeContract());
		surfaced.openQuestions.push({
			id: did(302),
			question: "Must supervisors see visit summaries in the first release?",
			structuralImpact: "local",
			blocking: true,
			relatedIntentIds: [ids.factVisitSummary],
		});
		const ok = {
			contract: surfaced,
			dispositions: [
				{
					...hidden.dispositions[0],
					resultingIntentIds: [did(302)],
				},
			],
		};
		const parsed = schema.safeParse(ok);
		expect(
			parsed.success,
			parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
		).toBe(true);
	});
});

describe("validateSensitivityNotSilentlyLowered", () => {
	it("flags a quiet downgrade and accepts a dispositioned one", () => {
		const parent = makeContract();
		const revised = cloneContract(parent);
		const fact = revised.facts.find((f) => f.id === ids.factRisk);
		if (!fact) throw new Error("fixture has factRisk");
		fact.sensitivity = "ordinary";

		const silent = validateSensitivityNotSilentlyLowered(parent, {
			contract: revised,
			dispositions: [],
		});
		expect(silent).toHaveLength(1);
		expect(silent[0]).toContain("risk_level");

		const justified = validateSensitivityNotSilentlyLowered(parent, {
			contract: revised,
			dispositions: [
				{
					findingId: did(300),
					status: "accepted",
					rationale: "Risk level is displayed on every queue row by design.",
					resultingIntentIds: [ids.factRisk],
				},
			],
		});
		expect(justified).toHaveLength(0);
	});
});
