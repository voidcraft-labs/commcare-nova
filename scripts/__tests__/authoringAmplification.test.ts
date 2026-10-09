import { describe, expect, it } from "vitest";
import { loadSourceMaterial } from "@/lib/agent/sources";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { planAuthoringAmplificationRepair } from "../lib/authoringAmplification";
import {
	amplifiedConversation,
	durableFinal,
} from "./fixtures/authoringAmplification";

const sourceDeps = {
	loadAssets: async () => [],
	readExtract: async () => {
		throw new Error("No attachment is expected.");
	},
	loadImage: async () => {
		throw new Error("No image is expected.");
	},
};

describe("incident final-response repair", () => {
	it.each([1918, 6539])(
		"preserves source/answer identities for %s copies and admits a genuine next request",
		async (copies) => {
			const original = amplifiedConversation(copies);
			const before = structuredClone(original);
			const plan = planAuthoringAmplificationRepair(original, [durableFinal]);
			expect(plan?.removedParts).toBe(copies - 1);
			expect(original).toEqual(before);
			const repaired = plan?.messages as NovaUIMessage[];
			expect(repaired[1]?.parts).toEqual(original[1]?.parts.slice(0, 2));
			const originalSource = await loadSourceMaterial({
				projectId: "project",
				messages: original,
				deps: sourceDeps,
			});
			const repairedSource = await loadSourceMaterial({
				projectId: "project",
				messages: repaired,
				deps: sourceDeps,
			});
			expect(repairedSource).toEqual(originalSource);
			const continued = await loadSourceMaterial({
				projectId: "project",
				messages: [
					...repaired,
					{
						id: "next-request",
						role: "user",
						parts: [{ type: "text", text: "Here is the missing information." }],
					},
				],
				deps: sourceDeps,
			});
			expect(continued.requests.slice(0, -1)).toEqual(originalSource.requests);
			expect(continued.requests.at(-1)?.key).toBe("request:next-request:0");
			expect(
				planAuthoringAmplificationRepair(repaired, [durableFinal]),
			).toBeNull();
		},
	);

	it("refuses missing or ambiguous model origins, interior duplicates, and a later user reply", () => {
		const messages = amplifiedConversation(3);
		expect(planAuthoringAmplificationRepair(messages, [])).toBeNull();
		expect(
			planAuthoringAmplificationRepair(messages, [durableFinal, durableFinal]),
		).toBeNull();
		const assistant = messages[1];
		if (!assistant) throw new Error("Missing fixture message.");
		assistant.parts.push({
			type: "text",
			text: "A different final.",
			state: "done",
		});
		expect(
			planAuthoringAmplificationRepair(messages, [durableFinal]),
		).toBeNull();
		expect(
			planAuthoringAmplificationRepair(
				[...amplifiedConversation(3), { id: "later", role: "user", parts: [] }],
				[durableFinal],
			),
		).toBeNull();
	});
});
