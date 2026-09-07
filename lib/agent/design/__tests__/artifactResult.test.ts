import { expect, it } from "vitest";
import { toArtifactResult } from "../artifactResult";

it.each([
	"length",
	"content-filter",
	"tool-calls",
	"error",
	"other",
	undefined,
] as const)(
	"does not authorize parsed output after %s completion",
	(finishReason) => {
		expect(
			toArtifactResult(
				{
					object: { guidance: "Continue" },
					usage: undefined,
					warnings: undefined,
					finishReason,
				},
				new AbortController().signal,
			),
		).toEqual({
			kind: "not-produced",
			reason:
				finishReason === "length" ? "length" : "invalid-structured-output",
			usage: undefined,
		});
	},
);
it("gives cancellation precedence even after a parsed complete response", () => {
	const controller = new AbortController();
	controller.abort();
	expect(
		toArtifactResult(
			{
				object: { guidance: "Continue" },
				usage: undefined,
				warnings: undefined,
				finishReason: "stop",
			},
			controller.signal,
		),
	).toEqual({ kind: "not-produced", reason: "cancelled", usage: undefined });
});
it("does not authorize absent structured output after normal completion", () => {
	expect(
		toArtifactResult(
			{
				object: null,
				usage: undefined,
				warnings: undefined,
				finishReason: "stop",
			},
			new AbortController().signal,
		),
	).toEqual({
		kind: "not-produced",
		reason: "invalid-structured-output",
		usage: undefined,
	});
});
