import { describe, expect, it } from "vitest";
import {
	admitMutationFrame,
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
});
