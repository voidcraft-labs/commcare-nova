import { describe, expect, it } from "vitest";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	designArtifactEnvelopeSchema,
	sealArtifactEnvelope,
	verifyArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { makeContract } from "./fixtures";

const persistedContractEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-contract",
	appDesignContractSchema,
);

function frozenV1Envelope(artifactSchemaVersion = 1) {
	return sealArtifactEnvelope({
		artifactType: "design-contract" as const,
		artifactSchemaVersion,
		artifactId: "00000000-0000-4000-8000-000000008101",
		designSessionId: "00000000-0000-4000-8000-000000008102",
		revision: 1,
		parentArtifactId: null,
		sourcePackageDigest: "a".repeat(64),
		inputArtifactDigests: [],
		promptVersion: "design-agent-v15",
		producer: {
			provider: "openai" as const,
			modelId: "historical-design-model",
			finishReason: "stop",
		},
		createdAt: "2026-08-01T12:00:00.000Z",
		payload: makeContract(),
	});
}

describe("Design Contract artifact versioning", () => {
	it("round-trips the frozen persisted v1 body without changing its digest", () => {
		const historical = frozenV1Envelope();
		expect(historical.artifactDigest).toBe(
			"321ea450a7724070ef1d0aaf187bb8911fef011533a84f3a2508c16ac2c7e239",
		);
		const parsed = persistedContractEnvelopeSchema.parse(
			JSON.parse(JSON.stringify(historical)),
		);
		verifyArtifactEnvelope(parsed);
		expect(parsed).toEqual(historical);
	});

	it("rejects a coherently sealed header/payload schema-version mismatch", () => {
		const mismatch = frozenV1Envelope(2);
		expect(persistedContractEnvelopeSchema.safeParse(mismatch).success).toBe(
			false,
		);
	});
});
