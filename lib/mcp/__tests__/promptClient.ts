import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { AgentPromptPage } from "../promptDelivery";

export function resultText(result: { isError?: boolean; content?: unknown }) {
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	return (result.content as [{ type: "text"; text: string }])[0].text;
}

/** Consumer checks independent of the server's pagination algorithm. Both
 * pure delivery tests and real SDK calls must satisfy the same wire contract. */
export async function readPrompt(
	call: (cursor?: string) => Promise<{ isError?: boolean; content?: unknown }>,
) {
	const chunks: string[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let end = 0;
	let digest: string | undefined;
	let length: number | undefined;
	do {
		const text = resultText(await call(cursor));
		expect(text.length).toBeLessThanOrEqual(75_000);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(75_000);
		if (!text.startsWith("{")) {
			expect(cursor).toBeUndefined();
			expect(text.endsWith("NOVA-PROMPT-END")).toBe(true);
			return text;
		}
		const page = JSON.parse(text) as AgentPromptPage;
		digest ??= page.prompt_sha256;
		length ??= page.prompt_length;
		expect(page).toMatchObject({
			kind: "nova-agent-prompt-page",
			protocol_version: 1,
			offset_unit: "unicode-code-points",
			chunk_start: end,
			prompt_sha256: digest,
			prompt_length: length,
			instruction: expect.any(String),
			complete: expect.any(Boolean),
		});
		expect(page.prompt_chunk.length).toBeGreaterThan(0);
		// UTF-8 encoding replaces isolated surrogates; a split pair cannot survive.
		expect(Buffer.from(page.prompt_chunk, "utf8").toString("utf8")).toBe(
			page.prompt_chunk,
		);
		end += Array.from(page.prompt_chunk).length;
		expect(page.chunk_end).toBe(end);
		expect(end).toBeLessThanOrEqual(length);
		chunks.push(page.prompt_chunk);
		if (page.complete) {
			expect(page.next_cursor).toBeUndefined();
			expect(end).toBe(length);
		} else {
			expect(end).toBeLessThan(length);
			expect(page.next_cursor).toEqual(expect.any(String));
			expect(cursors.has(page.next_cursor as string)).toBe(false);
			cursors.add(page.next_cursor as string);
		}
		cursor = page.next_cursor;
	} while (cursor !== undefined);
	const assembled = chunks.join("");
	expect(assembled.endsWith("NOVA-PROMPT-END")).toBe(true);
	expect(createHash("sha256").update(assembled, "utf8").digest("hex")).toBe(
		digest,
	);
	return assembled;
}
