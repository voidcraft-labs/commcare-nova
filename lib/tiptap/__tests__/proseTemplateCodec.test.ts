import { describe, expect, it } from "vitest";
import type { ProseTemplate } from "@/lib/domain";
import { proseTemplateSurvivesTiptapRoundTrip } from "../proseTemplateCodec";

describe("proseTemplateSurvivesTiptapRoundTrip", () => {
	it("compares semantic JSON structure instead of case-ref key order", () => {
		const admissionOrdered: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Client: " },
				{
					caseType: "client",
					kind: "case-ref",
					property: "case_name",
				},
			],
		};

		expect(proseTemplateSurvivesTiptapRoundTrip(admissionOrdered)).toBe(true);
	});

	it("still rejects a genuinely lossy noncanonical template", () => {
		// Persisted/runtime input can bypass the static type. The editor merges
		// adjacent text nodes into one canonical part, so this input does change.
		const adjacentText = {
			parts: [
				{ kind: "text", text: "Client" },
				{ kind: "text", text: " summary" },
			],
		} as ProseTemplate;

		expect(proseTemplateSurvivesTiptapRoundTrip(adjacentText)).toBe(false);
	});
});
