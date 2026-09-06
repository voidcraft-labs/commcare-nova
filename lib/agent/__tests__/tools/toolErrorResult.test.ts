/** Error routing, not persistence proof: the real MCP/DB suite owns rollback. */
import { DatabaseError } from "pg";
import { expect, it } from "vitest";
import {
	AppProjectChangedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { toToolErrorResult } from "../../tools/common";

it("propagates the original authority, protocol and PostgreSQL errors to the surface", () => {
	for (const error of [
		new AppProjectChangedError(),
		new BlueprintCommitRejectedError("Peer change"),
		new CommitReauthError("Revoked"),
		new RunHolderLostError(),
		new MutationBatchIdCollisionError(),
		new DatabaseError("private database diagnostic", 0, "error"),
	]) {
		let caught: unknown;
		try {
			toToolErrorResult(error);
		} catch (value) {
			caught = value;
		}
		expect(caught).toBe(error);
	}
});
it("projects ordinary tool refusals into the complete shared result shape", () => {
	for (const [error, message] of [
		[new Error("Choose a field."), "Choose a field."],
		["Choose a form.", "Choose a form."],
		[null, "null"],
	]) {
		expect(toToolErrorResult(error)).toEqual({
			kind: "mutate",
			mutations: [],
			result: { error: message },
		});
	}
});
