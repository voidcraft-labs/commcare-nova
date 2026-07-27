import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";

function inertDb(): Kysely<Database> {
	return new Proxy(
		{},
		{
			get() {
				throw new Error("Kysely must not be reached");
			},
		},
	) as Kysely<Database>;
}

describe("tenant identity construction boundary", () => {
	it.each([
		{ field: "actor", actorUserId: "", ownerId: "owner" },
		{ field: "owner", actorUserId: "actor", ownerId: "" },
		{
			field: "actor",
			actorUserId: undefined as unknown as string,
			ownerId: "owner",
		},
		{
			field: "owner",
			actorUserId: "actor",
			ownerId: undefined as unknown as string,
		},
	])("rejects a missing $field before any Kysely access", (args) => {
		const db = inertDb();
		const make = vi.fn(
			() =>
				new PostgresCaseStore({
					projectId: "project",
					actorUserId: args.actorUserId,
					ownerId: args.ownerId,
					db,
					sampleGenerator: new HeuristicCaseGenerator(),
				}),
		);

		expect(make).toThrow(/nonblank|identity/i);
		expect(make).toHaveBeenCalledTimes(1);
	});
});
