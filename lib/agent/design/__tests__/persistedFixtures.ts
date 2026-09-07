import {
	type DesignArtifactWriteAuthority,
	insertDesignBuildPlan,
	insertDesignReview,
	insertDesignRevision,
	insertDesignSourcePackage,
} from "../artifactStore";
import { deriveBuildPlan } from "../buildPlan";
import { type AppDesignContract, appDesignContractSchema } from "../contract";
import {
	sealArtifactEnvelope,
	type UnsealedDesignArtifactEnvelope,
} from "../envelope";
import { asDesignId } from "../ids";
import { buildDesignSourcePackage } from "../sourcePackage";
import { FIXTURE_THREAD_ID, makeContract } from "./fixtures";

/** Persist actual schema/graph/digest-admitted artifacts through their owners.
 * The clean review is controlled fixture content, not a claim about an LLM.
 * The supplied session must already carry the caller's live authority. */
export async function persistAcceptedRevisionFixture(args: {
	designSessionId: string;
	authority: DesignArtifactWriteAuthority;
	contract?: AppDesignContract;
}) {
	const { designSessionId, authority } = args;
	const contract = appDesignContractSchema.parse(
		args.contract ?? makeContract(),
	);
	const pkg = await buildDesignSourcePackage({
		designSessionId,
		projectId: authority.expectedProjectId,
		threadId: FIXTURE_THREAD_ID,
		messages: [
			{
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: "Track patients and their visits." }],
			},
		],
		deps: {
			async loadAssets(ids) {
				if (ids.length !== 0)
					throw new Error("Text-only fixture requested media");
				return [];
			},
			async readExtract() {
				throw new Error("Text-only fixture requested extraction");
			},
			async loadImage() {
				throw new Error("Text-only fixture requested image bytes");
			},
		},
	});
	await insertDesignSourcePackage({ pkg, authority });
	function envelope<P extends { schemaVersion: number }>(
		artifactType: UnsealedDesignArtifactEnvelope<P>["artifactType"],
		payload: P,
		revision: number,
		parentArtifactId: string | null,
		inputArtifactDigests: string[],
	) {
		return sealArtifactEnvelope({
			artifactType,
			payload,
			artifactSchemaVersion: payload.schemaVersion,
			artifactId: crypto.randomUUID(),
			designSessionId,
			revision,
			parentArtifactId,
			sourcePackageDigest: pkg.packageDigest,
			inputArtifactDigests,
			promptVersion: "offline-fixture-v1",
			producer: {
				provider: "fixture",
				modelId: "offline",
				finishReason: "stop",
			},
			createdAt: new Date().toISOString(),
		});
	}
	const draft = await insertDesignRevision({
		envelope: envelope("design-contract", contract, 1, null, []),
		lifecycle: "draft",
		authority,
	});
	const review = await insertDesignReview({
		envelope: envelope(
			"design-review",
			{
				schemaVersion: 1 as const,
				id: asDesignId(crypto.randomUUID()),
				summary: "Fixture review has no findings.",
				findings: [],
			},
			1,
			draft.id,
			[draft.artifactDigest],
		),
		designRevisionId: draft.id,
		authority,
	});
	const accepted = await insertDesignRevision({
		envelope: envelope("design-contract", contract, 2, draft.id, [
			draft.artifactDigest,
			review.artifactDigest,
		]),
		lifecycle: "accepted",
		authority,
	});
	return { pkg, draft, review, accepted, envelope };
}

export async function persistAcceptedDesignFixture(
	args: Parameters<typeof persistAcceptedRevisionFixture>[0],
) {
	const { pkg, draft, review, accepted, envelope } =
		await persistAcceptedRevisionFixture(args);
	const plan = deriveBuildPlan({
		contract: accepted.envelope.payload,
		revision: { id: accepted.id, digest: accepted.artifactDigest },
	});
	const persistedPlan = await insertDesignBuildPlan({
		envelope: envelope("design-build-plan", plan, 2, accepted.id, [
			accepted.artifactDigest,
		]),
		authority: args.authority,
	});
	return { pkg, draft, review, accepted, plan: persistedPlan };
}
