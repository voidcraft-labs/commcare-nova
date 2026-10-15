import { describe, expect, it } from "vitest";
import { log } from "@/lib/logger";
import { classifyError } from "../errorClassifier";
import { makeTestContext } from "./fixtures";

describe("generation error evidence", () => {
	it("retains the original exception once while emitting only safe conversation data", () => {
		const { ctx, writer } = makeTestContext();
		const original = new Error("private SQL diagnostic", {
			cause: new Error("database origin"),
		});
		const classified = classifyError(original);
		ctx.emitError(classified, "extractDocument", { originalError: original });
		ctx.emitError(classified, "route:failure", { originalError: original });
		expect(log.error).toHaveBeenCalledExactlyOnceWith(
			expect.any(String),
			original,
			expect.objectContaining({
				appId: "test-app",
				runId: "run-1",
				raw: original.message,
			}),
		);
		expect(writer.write).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(writer.write.mock.calls)).not.toContain(
			original.message,
		);
	});
	it("retains a failed event writer's exception", () => {
		const { ctx, writer } = makeTestContext();
		const failure = new Error("writer failed");
		writer.write.mockImplementation(() => {
			throw failure;
		});
		ctx.emitError(
			{ type: "internal", message: "Could not finish.", recoverable: false },
			"test",
			{ reportedAtSource: true },
		);
		expect(log.error).toHaveBeenCalledWith(
			expect.any(String),
			failure,
			expect.any(Object),
		);
	});
});
