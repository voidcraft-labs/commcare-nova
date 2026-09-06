/** Pure byte/code-point transport boundaries and malformed continuation
 * input. Real rendered, persisted app pagination lives in the SDK/PG tests. */
import { expect, it } from "vitest";
import { type AgentPromptPage, deliverAgentPrompt } from "../promptDelivery";
import { readPrompt, resultText } from "./promptClient";

const marker = "NOVA-PROMPT-END";
const oversized = `${"x".repeat(76_000)}${marker}`;
function firstPage(prompt = oversized) {
	return JSON.parse(resultText(deliverAgentPrompt(prompt))) as AgentPromptPage;
}
function cursor(overrides: Record<string, unknown>) {
	const first = firstPage();
	expect(first.next_cursor).toEqual(expect.any(String));
	const valid = JSON.parse(
		Buffer.from(first.next_cursor as string, "base64url").toString("utf8"),
	);
	return Buffer.from(
		JSON.stringify({ ...valid, ...overrides }),
		"utf8",
	).toString("base64url");
}
it("keeps exact 75,000-byte plain text intact and pages at the next byte", async () => {
	const prompt = `${"x".repeat(75_000 - marker.length)}${marker}`;
	expect(deliverAgentPrompt(prompt)).toEqual({
		content: [{ type: "text", text: prompt }],
	});
	const paged = `x${prompt}`;
	expect(firstPage(paged).complete).toBe(false);
	expect(
		await readPrompt(async (next) => deliverAgentPrompt(paged, next)),
	).toBe(paged);
});
it.each([
	{ name: "astral Unicode below the UTF-16 limit", text: "💉".repeat(20_000) },
	{
		name: "JSON escaping and control characters",
		text: '\n\t\b"\\'.repeat(16_000),
	},
	{ name: "three or more pages", text: "guidance ".repeat(25_000) },
])(
	"reassembles $name with bounded envelopes, adjacent offsets and a verified digest",
	async ({ text }) => {
		const prompt = `${text}${marker}`;
		expect(firstPage(prompt).complete).toBe(false);
		expect(
			await readPrompt(async (next) => deliverAgentPrompt(prompt, next)),
		).toBe(prompt);
	},
);
it.each(["", "guidance", `${marker} appended after marker`])(
	"refuses source text without a terminal delivery marker (%s)",
	(prompt) => {
		expect(() => deliverAgentPrompt(prompt)).toThrow("missing terminal marker");
	},
);
it.each([
	"",
	"not-a-cursor",
	Buffer.from("null").toString("base64url"),
	Buffer.from("{}").toString("base64url"),
])("refuses malformed continuation %s", (token) => {
	expect(() => deliverAgentPrompt(oversized, token)).toThrow(
		"cursor is invalid",
	);
});
it.each([
	{ v: 2 },
	{ extra: true },
	{ offset_code_points: -1 },
	{ offset_code_points: 1.5 },
	{ prompt_length_code_points: 0 },
	{ prompt_sha256: "invalid" },
])("refuses invalid cursor fields %j", (overrides) => {
	expect(() => deliverAgentPrompt(oversized, cursor(overrides))).toThrow(
		"cursor is invalid",
	);
});
it.each([0, oversized.length, oversized.length + 1])(
	"refuses non-continuation offset %i",
	(offset_code_points) => {
		expect(() =>
			deliverAgentPrompt(oversized, cursor({ offset_code_points })),
		).toThrow("invalid offset");
	},
);
it("binds every continuation to both content and code-point length", () => {
	const first = firstPage();
	for (const changed of [`y${oversized.slice(1)}`, `y${oversized}`]) {
		expect(() => deliverAgentPrompt(changed, first.next_cursor)).toThrow(
			"changed during get_agent_prompt pagination",
		);
	}
	expect(() =>
		deliverAgentPrompt(
			oversized,
			cursor({ prompt_length_code_points: oversized.length + 1 }),
		),
	).toThrow("changed during get_agent_prompt pagination");
});
