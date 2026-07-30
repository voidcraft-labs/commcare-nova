import { describe, expect, it } from "vitest";
import { SHARED_TOOL_MANIFEST } from "../sharedToolManifest";

const camelToSnake = (value: string): string =>
	value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

describe("shared tool manifest", () => {
	it("owns unique chat and MCP names", () => {
		const chatNames = SHARED_TOOL_MANIFEST.map(({ chatName }) => chatName);
		const mcpNames = SHARED_TOOL_MANIFEST.map(({ mcpName }) => mcpName);

		expect(new Set(chatNames).size).toBe(chatNames.length);
		expect(new Set(mcpNames).size).toBe(mcpNames.length);
	});

	it("projects every chat name to its exact snake_case MCP name", () => {
		for (const { chatName, mcpName } of SHARED_TOOL_MANIFEST) {
			expect(mcpName).toBe(camelToSnake(chatName));
		}
	});

	it("uses the write capability exactly for mutations", () => {
		for (const entry of SHARED_TOOL_MANIFEST) {
			if (entry.kind === "mutate") {
				expect(entry.requires).toBe("edit");
			}
		}
	});
});
