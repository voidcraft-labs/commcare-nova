// Which throws escape a tool body, and which become an `{ error }` the model
// reads and acts on.
//
// The distinction is the whole safety property: an `{ error }` envelope is an
// invitation to try again, so anything the model cannot fix by trying again has
// to escape instead. A batch id is server-minted, so a collision is Nova's own
// protocol failure — handing it back as `{ error }` invites the model to remint
// the id and re-call, turning one broken write into a loop.

import { describe, expect, it } from "vitest";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { toToolErrorResult } from "../../tools/common";

describe("toToolErrorResult", () => {
	it("re-throws every failure the model cannot resolve by retrying", () => {
		for (const err of [
			new AppProjectChangedError(),
			new BlueprintCommitRejectedError("a peer changed the target"),
			new CommitReauthError("the actor lost edit access"),
			new RunHolderLostError(),
			new MutationBatchIdCollisionError(),
		]) {
			expect(
				() => toToolErrorResult(err),
				`${err.name} must escape the tool body`,
			).toThrow(err.constructor as ErrorConstructor);
		}
	});

	it("turns an ordinary tool fault into an error envelope with nothing committed", () => {
		const result = toToolErrorResult(new Error("a genuine tool-body fault"));
		expect(result.mutations).toEqual([]);
		expect(result.result.error).toContain("a genuine tool-body fault");
	});
});
