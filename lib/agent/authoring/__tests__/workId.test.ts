import { expect, it } from "vitest";
import { toMcpErrorResult } from "@/lib/mcp/errors";
import { AuthoringInputError } from "../errors";
import {
	discardWork,
	executeWorkTool,
	getWork,
	getWorkSnapshot,
	saveWork,
} from "../session";

it("refuses malformed work before opening a database connection through every service entry", async () => {
	const args = {
		actorUserId: "author",
		workId: "placeholder",
		host: { kind: "mcp" } as const,
		requestId: "retry-id",
		expectedRevision: "invalid-revision",
	};
	for (const call of [
		() => getWork(args),
		() => getWorkSnapshot(args),
		() => saveWork(args),
		() => discardWork(args),
		() => executeWorkTool({ ...args, toolName: "getApp", input: {} }),
	]) {
		await expect(call()).rejects.toBeInstanceOf(AuthoringInputError);
	}
	const result = toMcpErrorResult(
		new AuthoringInputError("Use the work ID returned by begin_work."),
	);
	expect(result).toMatchObject({ isError: true });
	expect(JSON.stringify(result)).toContain("invalid_input");
});
