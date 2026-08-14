import { describe, expect, it } from "vitest";
import { renderSourceTagLegend } from "@/lib/agent/design/prompts";
import type { DesignFinding, DesignReview } from "@/lib/agent/design/review";
import {
	designFindingSchema,
	designRevisionResultSchemaFor,
	findingBlocksAcceptance,
	validateSensitivityNotSilentlyLowered,
} from "@/lib/agent/design/review";
import { designReviewSchemaFor } from "@/lib/agent/design/reviewerSchema";
import {
	type ReviewHandleBinding,
	taggedCitableSourceRefs,
} from "@/lib/agent/design/reviewVocabulary";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
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

/** The ledger rows the reviewer schema resolves against — the contract's
 *  elements under their authored handles. */
function bindings(): ReviewHandleBinding[] {
	return [
		{ handle: "@task_visit", designId: ids.taskVisit },
		{ handle: "@risk_level", designId: ids.factRisk },
	];
}

function reviewerSchema(sourcePackage: DesignSourcePackage = pkg()) {
	return designReviewSchemaFor({
		contract: makeContract(),
		pkg: sourcePackage,
		bindings: bindings(),
	});
}

/** A wire-shaped finding — what the reviewer model actually emits. */
function wireFinding(overrides: Record<string, unknown> = {}) {
	return {
		severity: "important",
		dispositionClass: "design-correction",
		claim: "The visit result is not shown after submission.",
		evidenceRefs: [{ source: "S1" }],
		affectedElements: ["@task_visit"],
		proposedResolution: "Show the saved visit summary.",
		...overrides,
	};
}

function wireReview(findings: unknown[]) {
	return { summary: "Focused review", findings };
}

/** A persisted-shape finding for the UUID-space laws below. */
function finding(overrides: Partial<DesignFinding> = {}): DesignFinding {
	return designFindingSchema.parse({
		id: did(300),
		severity: "important",
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
	it("requires grounding for important and critical findings", () => {
		expect(
			designFindingSchema.safeParse({
				...finding(),
				evidenceRefs: [],
				affectedElementIds: [],
			}).success,
		).toBe(false);
	});

	it("accepts contract-internal grounding through the named elements", () => {
		/* An internal contradiction has no source to cite — the named elements
		 * ARE its evidence. Demanding a citation here was exactly the pressure
		 * that produced padded citations. */
		expect(
			designFindingSchema.safeParse({
				...finding(),
				evidenceRefs: [],
				affectedElementIds: [ids.taskVisit, ids.factRisk],
			}).success,
		).toBe(true);
	});

	it("keeps advisory findings citation-free and non-blocking", () => {
		const advisory = finding({
			severity: "advisory",
			dispositionClass: "note",
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
		expect(findingBlocksAcceptance(finding({ dispositionClass: "note" }))).toBe(
			false,
		);
		expect(
			findingBlocksAcceptance(
				finding({ dispositionClass: "user-decision", severity: "important" }),
			),
		).toBe(true);
	});
});

describe("the reviewer's symbol vocabulary resolves to the persisted shape", () => {
	it("resolves handles and tags into the UUID-only review", () => {
		const result = reviewerSchema().safeParse(wireReview([wireFinding()]));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.schemaVersion).toBe(1);
		expect(result.data.id).toMatch(CANONICAL_UUID_PATTERN);
		const resolved = result.data.findings[0];
		expect(resolved?.id).toMatch(CANONICAL_UUID_PATTERN);
		expect(resolved?.id).not.toBe(result.data.id);
		expect(resolved?.affectedElementIds).toEqual([ids.taskVisit]);
		expect(resolved?.evidenceRefs).toEqual([messageRef()]);
	});

	it("accepts a raw identity only when the contract prints it raw", () => {
		const schema = reviewerSchema();
		// taskRegister has no ledger row, so the projection printed its raw id.
		expect(
			schema.safeParse(
				wireReview([wireFinding({ affectedElements: [ids.taskRegister] })]),
			).success,
		).toBe(true);
		// A bound element prints as its @handle — the raw identity is out of the
		// grammar entirely, not merely discouraged.
		expect(
			schema.safeParse(
				wireReview([wireFinding({ affectedElements: [ids.taskVisit] })]),
			).success,
		).toBe(false);
		const unknown = schema.safeParse(
			wireReview([wireFinding({ affectedElements: [did(9999)] })]),
		);
		expect(unknown.success).toBe(false);
		expect(
			unknown.success ? "" : (unknown.error.issues[0]?.message ?? ""),
		).toContain(did(9999));
	});

	it("names an unbound handle instead of a resolved coordinate", () => {
		const result = reviewerSchema().safeParse(
			wireReview([wireFinding({ affectedElements: ["@not_declared"] })]),
		);
		expect(result.success).toBe(false);
		const message = result.success
			? ""
			: (result.error.issues[0]?.message ?? "");
		// The model's own symbol is the diagnosable value — the exact gap that
		// once hid what a live reviewer spliced.
		expect(message).toContain("@not_declared");
		expect(result.success ? [] : (result.error.issues[0]?.path ?? [])).toEqual([
			"findings",
			0,
			"affectedElements",
			0,
		]);
	});

	it("rejects a bound handle whose element left the reviewed contract", () => {
		const schema = designReviewSchemaFor({
			contract: makeContract(),
			pkg: pkg(),
			bindings: [...bindings(), { handle: "@ghost", designId: did(9999) }],
		});
		// The ledger row survives element removal, but the contract no longer
		// prints @ghost — so the symbol is out of the element grammar.
		const result = schema.safeParse(
			wireReview([wireFinding({ affectedElements: ["@ghost"] })]),
		);
		expect(result.success).toBe(false);
		const message = result.success
			? ""
			: (result.error.issues[0]?.message ?? "");
		expect(message).toContain("@ghost");
		expect(message).toContain("not an element symbol");
	});

	it("keeps workflow-local names out of the element grammar", () => {
		// The live failure class: the contract prints effect/decision handles as
		// bare workflow-local names, and a reviewer glued @ onto one. The exact
		// symbol enum makes that citation inexpressible, and the rejection
		// teaches the enclosing workflow instead — retrying the same prompt
		// could never have fixed it.
		const result = reviewerSchema().safeParse(
			wireReview([wireFinding({ affectedElements: ["@record_visit"] })]),
		);
		expect(result.success).toBe(false);
		const message = result.success
			? ""
			: (result.error.issues[0]?.message ?? "");
		expect(message).toContain("@record_visit");
		expect(message).toContain("enclosing workflow");
	});

	it("makes an out-of-set source tag grammatically inexpressible", () => {
		expect(
			reviewerSchema().safeParse(
				wireReview([wireFinding({ evidenceRefs: [{ source: "S9" }] })]),
			).success,
		).toBe(false);
	});

	it("attaches the catalog's anchor to a platform citation", () => {
		const result = reviewerSchema().safeParse(
			wireReview([
				wireFinding({
					evidenceRefs: [{ platform: "CASE_SEARCH_IS_LIVE_AND_ONLINE" }],
				}),
			]),
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.findings[0]?.evidenceRefs[0]).toEqual({
			kind: "platform-constraint",
			code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
			sourceAnchor: "lib/commcare/suite/case-search/remoteRequest.ts",
		});
	});

	it("teaches that sectionPath belongs to attachment tags only", () => {
		const result = reviewerSchema().safeParse(
			wireReview([
				wireFinding({
					evidenceRefs: [{ source: "S1", sectionPath: ["Requirements"] }],
				}),
			]),
		);
		expect(result.success).toBe(false);
		const message = result.success
			? ""
			: (result.error.issues[0]?.message ?? "");
		expect(message).toContain("S1");
		expect(message).toContain("message");
	});

	it("keeps the persisted schema's citation laws speaking with wire paths", () => {
		const result = reviewerSchema().safeParse(
			wireReview([
				wireFinding({
					severity: "advisory",
					dispositionClass: "note",
					// Advisory findings carry no citations — the law lives once, in
					// the persisted schema, and the backstop re-parse surfaces it.
				}),
			]),
		);
		expect(result.success).toBe(false);
		const issue = result.success ? undefined : result.error.issues[0];
		expect(issue?.path).toEqual(["findings", 0, "evidenceRefs"]);
		expect(issue?.message ?? "").toContain("Advisory findings");
	});
});

describe("citation grounding stays in lockstep with the review prompt", () => {
	const ATTACHMENT_ASSET = "00000000-0000-4000-8000-000000000860";

	function richPackage(): DesignSourcePackage {
		const attachmentRef = {
			kind: "attachment-extract" as const,
			assetId: ATTACHMENT_ASSET as never,
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
					// the tagged set must dedup, not double-list.
					sourceRefs: [messageRef(9), messageRef()],
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

	it("admits exactly the tags the prompt's legend renders, including claim refs", () => {
		const sourcePackage = richPackage();
		const tagged = taggedCitableSourceRefs(sourcePackage);
		// message block + attachment + the claim's extra coordinate, deduped.
		expect(tagged.map(({ tag }) => tag)).toEqual(["S1", "S2", "S3"]);
		const schema = designReviewSchemaFor({
			contract: makeContract(),
			pkg: sourcePackage,
			bindings: bindings(),
		});
		for (const { tag } of tagged) {
			expect(
				schema.safeParse(
					wireReview([wireFinding({ evidenceRefs: [{ source: tag }] })]),
				).success,
			).toBe(true);
		}
		const legend = renderSourceTagLegend(sourcePackage);
		expect(legend.match(/^- /gm)).toHaveLength(tagged.length);
		expect(legend).toContain("S1 — user message block");
		expect(legend).toContain("S2 — attached document spec.pdf");
		expect(legend).toContain(
			"S3 — a message coordinate from the normalized source notes",
		);
	});

	it("resolves an attachment tag from identity fields plus the model's own narrowing", () => {
		const sourcePackage = richPackage();
		const schema = designReviewSchemaFor({
			contract: makeContract(),
			pkg: sourcePackage,
			bindings: bindings(),
		});
		const result = schema.safeParse(
			wireReview([
				wireFinding({
					evidenceRefs: [
						{
							source: "S2",
							sectionPath: ["Requirements"],
							figureMarker: '<nova:figure index="1"/>',
						},
					],
				}),
			]),
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.findings[0]?.evidenceRefs[0]).toEqual({
			kind: "attachment-extract",
			assetId: ATTACHMENT_ASSET,
			extractorVersion: 3,
			sectionPath: ["Requirements"],
			figureMarker: '<nova:figure index="1"/>',
		});
	});

	it("never inherits a claim-carried sectionPath into a citation", () => {
		// The attachment coordinate enters the citable set ONLY through a claim
		// that narrowed it to a section; a citation of its tag without narrowing
		// must resolve to the bare identity, not the claim's location.
		const attachmentViaClaim = {
			kind: "attachment-extract" as const,
			assetId: ATTACHMENT_ASSET as never,
			extractorVersion: 3,
			sectionPath: ["From the claim"],
		};
		const sourcePackage: DesignSourcePackage = {
			...pkg(),
			claims: [
				{
					id: did(701),
					statement: "The spec names the requirement.",
					sourceRefs: [attachmentViaClaim],
				},
			],
		};
		const schema = designReviewSchemaFor({
			contract: makeContract(),
			pkg: sourcePackage,
			bindings: bindings(),
		});
		const result = schema.safeParse(
			wireReview([wireFinding({ evidenceRefs: [{ source: "S2" }] })]),
		);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.findings[0]?.evidenceRefs[0]).toEqual({
			kind: "attachment-extract",
			assetId: ATTACHMENT_ASSET,
			extractorVersion: 3,
			sectionPath: [],
		});
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

	it("does not require dispositions for notes", () => {
		const readiness = finding({ dispositionClass: "note" });
		const advisory = finding({
			id: did(301),
			severity: "advisory",
			dispositionClass: "note",
			evidenceRefs: [],
		});
		expect(
			designRevisionResultSchemaFor([review([readiness, advisory])]).safeParse({
				contract: makeContract(),
				dispositions: [],
			}).success,
		).toBe(true);
	});

	it("names the offending finding by its printed handle in closure issues", () => {
		/* The model's only finding vocabulary is the positional @f handle; an
		 * issue naming a dispositions array index reads as a finding number
		 * and sends the correction at the wrong entry (observed live as a
		 * nonconvergent removal chase). */
		const blocking = finding();
		const advisory = finding({
			id: did(301),
			severity: "advisory",
			dispositionClass: "note",
			evidenceRefs: [],
		});
		const schema = designRevisionResultSchemaFor([
			review([blocking, advisory]),
		]);
		const rejected = schema.safeParse({
			contract: makeContract(),
			dispositions: [
				{
					findingId: advisory.id,
					status: "accepted",
					rationale: "Advisory findings take no disposition.",
				},
			],
		});
		expect(rejected.success).toBe(false);
		if (rejected.success) return;
		const messages = rejected.error.issues.map((issue) => issue.message);
		expect(
			messages.some(
				(message) =>
					message.includes("@f2") && message.includes("does not block"),
			),
		).toBe(true);
		expect(
			messages.some(
				(message) =>
					message.includes("@f1") && message.includes("no disposition"),
			),
		).toBe(true);
	});

	it("keeps a deferred user decision linked to a blocking question", () => {
		const userDecision = finding({ dispositionClass: "user-decision" });
		const schema = designRevisionResultSchemaFor([review([userDecision])]);
		const disposition = {
			findingId: userDecision.id,
			status: "deferred" as const,
			rationale: "The person must choose before construction.",
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
			affectedElementIds: [ids.factRisk],
		});
		expect(
			validateSensitivityNotSilentlyLowered(parent, result, [
				review([sensitivityFinding]),
			]),
		).toEqual([]);
	});
});
