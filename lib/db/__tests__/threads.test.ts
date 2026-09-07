import { describe, expect, it } from "vitest";
import { mergeTranscript } from "../threads";

describe("mergeTranscript", () => {
	const m = (id: string, partCount = 1) => ({
		id,
		parts: Array.from({ length: partCount }, (_, i) => ({
			type: "text",
			text: `p${i}`,
		})),
	});

	it("unions: stored-only survive, incoming-only append in order", () => {
		const merged = mergeTranscript([m("a"), m("b")], [m("a"), m("c"), m("d")]);
		expect(merged.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("richer version wins a shared id; incoming wins ties", () => {
		const richStored = m("a", 3);
		const staleIncoming = m("a", 1);
		expect(mergeTranscript([richStored], [staleIncoming])[0]).toBe(richStored);

		const tieIncoming = m("b", 2);
		expect(mergeTranscript([m("b", 2)], [tieIncoming])[0]).toBe(tieIncoming);
	});

	it("keeps stored attachment identity authoritative for a shared message id", () => {
		const stored = {
			...m("attached"),
			metadata: {
				attachments: [
					{
						assetId: "70000000-0000-4000-8000-000000000002",
						kind: "pdf",
						filename: "requirements.pdf",
						mimeType: "application/pdf",
					},
				],
			},
		};
		const stale = {
			...m("attached", 2),
			metadata: {
				attachments: [
					{
						assetId: "70000000-0000-4000-8000-000000000003",
						kind: "pdf",
						filename: "requirements.pdf",
						mimeType: "application/pdf",
					},
				],
				model: "new-model",
			},
		};

		expect(mergeTranscript([stored], [stale])).toEqual([
			{
				...stale,
				metadata: {
					...stale.metadata,
					attachments: stored.metadata.attachments,
				},
			},
		]);
	});
});
