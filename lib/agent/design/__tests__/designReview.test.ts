import Ajv from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { renderSourceTagLegend } from "@/lib/agent/design/prompts";
import type { DesignFinding, DesignReview } from "@/lib/agent/design/review";
import {
	designFindingSchema,
	designReviewSchema,
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
import {
	strictStructuredSchema,
	strictWireJsonSchema,
} from "@/lib/agent/strictStructuredOutput";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
import {
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "./fixtures";
import { reviewSourceFixture } from "./reviewSourceFixture";
import { SOURCE_DOCUMENT, SOURCE_THREAD } from "./sourcePackageFixtures";

let producedPackage: DesignSourcePackage;
beforeAll(async () => {
	producedPackage = await reviewSourceFixture();
});
function pkg(): DesignSourcePackage {
	return structuredClone(producedPackage);
}
function messageRef(partIndex = 0) {
	return {
		kind: "message" as const,
		threadId: SOURCE_THREAD,
		messageId: "request",
		partIndex,
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

describe("complete review protocol", () => {
	it("admits the complete strict payload and resolves it through the real structured-output bridge", async () => {
		const schema = reviewerSchema();
		const payload = {
			summary: "One correction and one optional note",
			findings: [
				{
					severity: "important",
					dispositionClass: "design-correction",
					claim: "Confirm the saved visit.",
					affectedElements: ["@task_visit"],
					proposedResolution: "Show the saved summary.",
					evidenceRefs: [
						{ source: "S1", sectionPath: null, figureMarker: null },
						{
							source: "S2",
							sectionPath: ["Requirements"],
							figureMarker: '<nova:figure index="1"/>',
						},
						{ source: "S3", sectionPath: null, figureMarker: null },
						{ source: "S4", sectionPath: null, figureMarker: null },
						{ platform: "CASE_SEARCH_IS_LIVE_AND_ONLINE" },
					],
				},
				{
					severity: "advisory",
					dispositionClass: "note",
					claim: "An optional wording improvement.",
					evidenceRefs: [],
					affectedElements: [],
					proposedResolution: null,
				},
			],
		};
		const check = new Ajv({ strict: false }).compile(
			strictWireJsonSchema(schema),
		);
		expect(
			check(JSON.parse(JSON.stringify(payload))),
			JSON.stringify(check.errors),
		).toBe(true);
		const bridge = strictStructuredSchema(schema);
		const parsed = await fixtureValue(
			bridge.validate,
			"strict validation",
		)(JSON.parse(JSON.stringify(payload)));
		if (!parsed.success) throw parsed.error;
		const result = designReviewSchema.parse(
			JSON.parse(JSON.stringify(parsed.value)),
		);
		expect(
			new Set([result.id, ...result.findings.map((finding) => finding.id)])
				.size,
		).toBe(3);
		expect(result.summary).toBe(payload.summary);
		expect(result.findings.map(({ id: _id, ...body }) => body)).toEqual([
			{
				severity: "important",
				dispositionClass: "design-correction",
				claim: "Confirm the saved visit.",
				affectedElementIds: [ids.taskVisit],
				proposedResolution: "Show the saved summary.",
				evidenceRefs: [
					messageRef(),
					{
						kind: "attachment-extract",
						assetId: SOURCE_DOCUMENT,
						extractorVersion: EXTRACTOR_VERSION,
						sectionPath: ["Requirements"],
						figureMarker: '<nova:figure index="1"/>',
					},
					fixtureValue(producedPackage.sources[2], "image source").ref,
					{
						kind: "message",
						threadId: SOURCE_THREAD,
						messageId: "answers",
						partIndex: 1,
					},
					{
						kind: "platform-constraint",
						code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
						sourceAnchor: "lib/commcare/suite/case-search/remoteRequest.ts",
					},
				],
			},
			{
				severity: "advisory",
				dispositionClass: "note",
				claim: "An optional wording improvement.",
				evidenceRefs: [],
				affectedElementIds: [],
			},
		]);
		const unlisted = structuredClone(payload);
		fixtureValue(unlisted.findings[0], "first finding").affectedElements = [
			"@not_declared",
		];
		expect(check(unlisted)).toBe(false);
		const unknownSource = structuredClone(payload);
		fixtureValue(unknownSource.findings[0], "first finding").evidenceRefs = [
			{ source: "S99", sectionPath: null, figureMarker: null },
		];
		expect(check(unknownSource)).toBe(false);
	});

	it.each([
		["critical", "design-correction", true],
		["important", "design-correction", true],
		["advisory", "design-correction", false],
		["critical", "user-decision", true],
		["important", "user-decision", true],
		["advisory", "user-decision", true],
		["critical", "note", false],
		["important", "note", false],
		["advisory", "note", false],
	] as const)(
		"keeps %s/%s grounding separate from its blocking policy",
		(severity, dispositionClass, blocks) => {
			const candidate = finding({
				severity,
				dispositionClass,
				evidenceRefs: [],
				affectedElementIds: [ids.taskVisit],
			});
			expect(findingBlocksAcceptance(candidate)).toBe(blocks);
			const external = designFindingSchema.safeParse({
				...candidate,
				evidenceRefs: [messageRef()],
				affectedElementIds: [],
			});
			expect(external.success).toBe(severity !== "advisory");
			const ungrounded = designFindingSchema.safeParse({
				...candidate,
				affectedElementIds: [],
			});
			expect(ungrounded.success).toBe(severity === "advisory");
			if (!ungrounded.success)
				expect(ungrounded.error.issues.map((issue) => issue.path)).toEqual([
					["evidenceRefs"],
				]);
		},
	);
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
	const ATTACHMENT_ASSET = SOURCE_DOCUMENT;

	function richPackage(): DesignSourcePackage {
		return pkg();
	}

	it("admits exactly the tags the prompt's legend renders, including claim refs", () => {
		const sourcePackage = richPackage();
		const tagged = taggedCitableSourceRefs(sourcePackage);
		// Actual request block, extract, image and completed-card coordinate.
		expect(tagged.map(({ tag }) => tag)).toEqual(["S1", "S2", "S3", "S4"]);
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
		expect(legend).toContain("S2 — attached document requirements.txt");
		expect(legend).toContain(
			"S4 — a message coordinate from the normalized source notes",
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
			extractorVersion: EXTRACTOR_VERSION,
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
			assetId: ATTACHMENT_ASSET,
			extractorVersion: EXTRACTOR_VERSION,
			sectionPath: ["From the claim"],
		};
		const sourcePackage: DesignSourcePackage = {
			...pkg(),
			sources: [{ ref: messageRef() }],
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
			extractorVersion: EXTRACTOR_VERSION,
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

describe("complete disposition closure", () => {
	it.each([
		{ kind: "missing", ids: [], paths: [["dispositions"]] },
		{
			kind: "unknown",
			ids: [did(999)],
			paths: [["dispositions", 0, "findingId"], ["dispositions"]],
		},
		{
			kind: "duplicate",
			ids: [did(300), did(300)],
			paths: [["dispositions", 1, "findingId"]],
		},
		{
			kind: "nonblocking",
			ids: [did(300), did(301)],
			paths: [["dispositions", 1, "findingId"]],
		},
	])(
		"refuses $kind dispositions with exact diagnostic coordinates",
		({ ids: dispositionIds, paths }) => {
			const schema = designRevisionResultSchemaFor([
				review([
					finding(),
					finding({ id: did(301), dispositionClass: "note" }),
				]),
			]);
			const result = schema.safeParse({
				contract: makeContract(),
				dispositions: dispositionIds.map((findingId) => ({
					findingId,
					status: "accepted",
					rationale: "Review the exact finding.",
				})),
			});
			if (result.success) throw new Error("Expected disposition refusal");
			expect(result.error.issues.map((issue) => issue.path)).toEqual(paths);
		},
	);
	it.each([
		{ status: "accepted", related: true, allowed: false },
		{ status: "accepted", related: false, allowed: true },
		{ status: "deferred", related: true, allowed: true },
		{ status: "deferred", related: false, allowed: false },
		{ status: "rejected", related: true, allowed: true },
		{ status: "rejected", related: false, allowed: true },
	] as const)(
		"binds a $status user decision to related=$related pending questions",
		({ status, related, allowed }) => {
			const contract = makeContract();
			contract.openQuestions.push({
				id: ids.question,
				question: "Which result should workers see?",
				blocking: true,
				relatedElementIds: [related ? ids.taskVisit : ids.taskRegister],
			});
			appDesignContractSchema.parse(contract);
			const schema = designRevisionResultSchemaFor([
				review([finding({ dispositionClass: "user-decision" })]),
			]);
			const parsed = schema.safeParse({
				contract,
				dispositions: [
					{
						findingId: did(300),
						status,
						rationale: "Preserve the explicit remaining decision.",
					},
				],
			});
			expect(parsed.success).toBe(allowed);
			if (!parsed.success)
				expect(parsed.error.issues.map((issue) => issue.path)).toEqual([
					["dispositions", 0, "status"],
				]);
		},
	);
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

describe("sensitivity transitions", () => {
	it.each([
		["ordinary", "ordinary", false],
		["ordinary", "sensitive", false],
		["ordinary", "highly-sensitive", false],
		["sensitive", "ordinary", true],
		["sensitive", "sensitive", false],
		["sensitive", "highly-sensitive", false],
		["highly-sensitive", "ordinary", true],
		["highly-sensitive", "sensitive", true],
		["highly-sensitive", "highly-sensitive", false],
	] as const)(
		"checks %s to %s without a covering correction",
		(before, after, refuses) => {
			const parent = makeContract();
			fixtureValue(
				parent.records[0]?.properties.find(
					(property) => property.id === ids.factRisk,
				),
				"risk",
			).sensitivity = before;
			appDesignContractSchema.parse(parent);
			const revised = cloneContract(parent);
			fixtureValue(
				revised.records[0]?.properties.find(
					(property) => property.id === ids.factRisk,
				),
				"risk",
			).sensitivity = after;
			const result = designRevisionResultSchemaFor([]).parse({
				contract: revised,
				dispositions: [],
			});
			expect(validateSensitivityNotSilentlyLowered(parent, result)).toEqual(
				refuses
					? [
							`The property "Risk level" was quietly downgraded from ${before} to ${after}.`,
						]
					: [],
			);
		},
	);
	it.each(["rejected", "deferred"] as const)(
		"does not treat a %s correction as permission to lower sensitivity",
		(status) => {
			const parent = makeContract();
			const revised = cloneContract(parent);
			fixtureValue(
				revised.records[0]?.properties.find(
					(property) => property.id === ids.factRisk,
				),
				"risk",
			).sensitivity = "ordinary";
			const reviews = [
				review([finding({ affectedElementIds: [ids.factRisk] })]),
			];
			const result = designRevisionResultSchemaFor(reviews).parse({
				contract: revised,
				dispositions: [
					{
						findingId: did(300),
						status,
						rationale: "This correction was not accepted.",
					},
				],
			});
			expect(
				validateSensitivityNotSilentlyLowered(parent, result, reviews),
			).toEqual([
				'The property "Risk level" was quietly downgraded from sensitive to ordinary.',
			]);
		},
	);
});
