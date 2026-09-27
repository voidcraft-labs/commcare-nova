import { expect } from "vitest";

export function resultText(result: { isError?: boolean; content?: unknown }) {
	expect(result.isError).not.toBe(true);
	return resultContentText(result);
}

export function resultContentText(result: { content?: unknown }) {
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	return (result.content as [{ type: "text"; text: string }])[0].text;
}
