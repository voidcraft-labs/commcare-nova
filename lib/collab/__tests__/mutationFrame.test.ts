import { describe, expect, it } from "vitest";
import {
	admitMutationFrame,
	diagnoseMutationFrameText,
	parseMutationFrame,
} from "@/lib/collab/mutationFrame";

const ordinary = {
	seq: 2,
	batchId: "batch-2",
	actorId: "actor-1",
	mutations: [{ kind: "setAppName", name: "Changed" }],
};

describe("browser mutation-frame admission", () => {
	it.each(["autosave", "mcp", "chat"] as const)(
		"admits the client-replayable %s kind",
		(kind) => {
			expect(admitMutationFrame({ ...ordinary, kind })).toMatchObject({
				seq: 2,
				kind,
			});
		},
	);

	it.each(["blueprint-migration", "fold-baseline", "project-move"] as const)(
		"rejects the server-only %s kind",
		(kind) => {
			expect(admitMutationFrame({ ...ordinary, kind })).toBeNull();
			expect(
				parseMutationFrame(JSON.stringify({ ...ordinary, kind })),
			).toBeNull();
		},
	);

	it("classifies invalid JSON without retaining payload text", () => {
		const result = diagnoseMutationFrameText('{"private":"do-not-log"');
		expect(result).toMatchObject({
			ok: false,
			failure: { stage: "json", reason: "invalid-json" },
		});
		expect(JSON.stringify(result)).not.toContain("do-not-log");
	});

	it("reports only schema code and path for an invalid envelope", () => {
		const result = diagnoseMutationFrameText(
			JSON.stringify({ ...ordinary, kind: "server-only", private: "secret" }),
		);
		expect(result).toMatchObject({
			ok: false,
			failure: {
				stage: "envelope",
				reason: "schema-parse",
				issues: expect.arrayContaining([expect.stringContaining("kind")]),
			},
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("retains canonicality location without retaining mutation values", () => {
		const result = diagnoseMutationFrameText(
			JSON.stringify({
				...ordinary,
				kind: "autosave",
				mutations: [
					{ kind: "setAppName", name: "do-not-log", unexpected: true },
				],
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			failure: {
				stage: "mutation-admission",
				mutationIndex: 0,
				pointer: expect.any(String),
				reason: expect.any(String),
			},
		});
		expect(JSON.stringify(result)).not.toContain("do-not-log");
	});
});
