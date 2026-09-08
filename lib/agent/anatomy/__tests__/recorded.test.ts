/**
 * The recorded-ledger reader's pure rules: append-key families, the
 * tool-result refinement, usage normalization, and the semantic scope.
 *
 * The source sweep at the end is deliberate source inspection: the rule is
 * "every append key the runners template has a family here", a property of
 * the source tree. A new prefix that lands as "unknown" would render as a
 * raw key on the timeline and hide from every moment that filters by kind.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	APPEND_KEY_FAMILIES,
	classifyAppendKey,
	NON_MESSAGE_KEY_PREFIXES,
	normalizeRecordedUsage,
	refineToolResultKind,
	semanticScopeOf,
} from "../recorded";

describe("classifyAppendKey", () => {
	it.each([
		["seed:abc", "seed"],
		["seed-through:msg-1", "seed"],
		["ui-turn:msg-2", "user-turn"],
		["answer:digest", "answer"],
		["state:digest", "state-packet"],
		["compaction-state:boundary:digest", "compaction-state"],
		["required-question-v5:h1:h2:tail", "required-questions"],
		["required-question-card-v1:digest", "question-card"],
		["required-question-rejection:call:digest", "correction"],
		["required-question-omission:digest:3", "correction"],
		["input-terminal-rejection:call:digest", "correction"],
		["design-terminal-omission:turn:", "correction"],
		["design-response:turn:author:", "response"],
		["design-wait:turn:", "wait"],
		["recovered-design-wait:call", "wait"],
		["slice-brief:scope", "slice-brief"],
		["candidate:scope:digest", "candidate-checkpoint"],
		["focus:scope:digest", "slice-focus"],
		["step:scope:3:response", "response"],
		["step:scope:3:tool:call-1", "tool-result"],
		["step:scope:3:empty", "empty-step-nudge"],
		["compaction-reseed:scope:7:0:digest", "compaction-reseed"],
		["something-new:x", "unknown"],
		["step:scope:3", "unknown"],
		["", "unknown"],
	] as const)("classifies %s as %s", (key, kind) => {
		expect(classifyAppendKey(key)).toBe(kind);
	});

	it("does not let a longer family shadow a shorter one", () => {
		expect(classifyAppendKey("state:x")).toBe("state-packet");
		expect(classifyAppendKey("compaction-state:x")).toBe("compaction-state");
		expect(classifyAppendKey("design-wait:x")).toBe("wait");
		expect(classifyAppendKey("recovered-design-wait:x")).toBe("wait");
	});
});

describe("refineToolResultKind", () => {
	const toolMessage = (toolName: string, value: unknown): ModelMessage => ({
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName,
				output: { type: "json", value: value as never },
			},
		],
	});

	it("chips a reportExecutionBlocker result as a blocker decision", () => {
		expect(
			refineToolResultKind(
				"tool-result",
				toolMessage("reportExecutionBlocker", { decision: "continue" }),
			),
		).toBe("blocker");
	});

	it("chips a failed result carrying architect guidance as repeated-failure guidance", () => {
		expect(
			refineToolResultKind(
				"tool-result",
				toolMessage("createForm", {
					error: "rejected",
					architectGuidance: "Host the form on the parent module.",
				}),
			),
		).toBe("auto-blocker");
	});

	it("leaves an ordinary tool result and every other kind alone", () => {
		expect(
			refineToolResultKind(
				"tool-result",
				toolMessage("createForm", { message: "Created." }),
			),
		).toBe("tool-result");
		expect(
			refineToolResultKind(
				"tool-result",
				toolMessage("createForm", "plain text output"),
			),
		).toBe("tool-result");
		expect(
			refineToolResultKind(
				"response",
				toolMessage("reportExecutionBlocker", { decision: "continue" }),
			),
		).toBe("response");
		expect(
			refineToolResultKind("tool-result", {
				role: "assistant",
				content: "not a tool message",
			}),
		).toBe("tool-result");
	});
});

describe("normalizeRecordedUsage", () => {
	it("returns null for a step with no usage", () => {
		expect(normalizeRecordedUsage(null)).toBeNull();
	});

	it("reads the AI SDK's nested token details", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: 1200,
				outputTokens: 80,
				totalTokens: 1280,
				inputTokenDetails: { cacheReadTokens: 1000, noCacheTokens: 200 },
				outputTokenDetails: { reasoningTokens: 30, textTokens: 50 },
			}),
		).toEqual({
			inputTokens: 1200,
			outputTokens: 80,
			totalTokens: 1280,
			cachedInputTokens: 1000,
			reasoningTokens: 30,
		});
	});

	it("reads the flat cached and reasoning fields when present", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				cachedInputTokens: 4,
				reasoningTokens: 2,
			}),
		).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			cachedInputTokens: 4,
			reasoningTokens: 2,
		});
	});

	it("reports non-numeric or absent counts as null rather than zero", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: "12",
				outputTokens: Number.NaN,
				inputTokenDetails: { cacheReadTokens: null },
			}),
		).toEqual({
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			cachedInputTokens: null,
			reasoningTokens: null,
		});
	});
});

describe("semanticScopeOf", () => {
	it("returns the slice attempt id an executor context version names", () => {
		expect(semanticScopeOf("v1")).toBeNull();
		expect(semanticScopeOf("v1:semantic-scope:abc")).toBe("abc");
		expect(semanticScopeOf("v1:semantic-scope:")).toBeNull();
	});
});

describe("append-key source sweep", () => {
	const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
	const SWEPT_FILES = [
		"lib/agent/build/designLoopRunner.ts",
		"lib/agent/build/executorLoop.ts",
		"lib/agent/design/loop/designAgent.ts",
	];
	/* A key is templated as `prefix:${...}` or held as a bare "prefix:"
	 * constant the runner later interpolates or matches with startsWith. */
	const TEMPLATED_KEY = /`([a-z][a-z0-9-]*):\$\{/g;
	const PREFIX_CONSTANT = /"([a-z][a-z0-9-]*):"/g;

	function sweptPrefixes(): Map<string, string[]> {
		const found = new Map<string, string[]>();
		for (const file of SWEPT_FILES) {
			const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
			for (const pattern of [TEMPLATED_KEY, PREFIX_CONSTANT]) {
				for (const match of text.matchAll(pattern)) {
					const prefix = `${match[1]}:`;
					found.set(prefix, [...(found.get(prefix) ?? []), file]);
				}
			}
		}
		return found;
	}

	it("gives every templated append or claim key a family or a non-message listing", () => {
		const unaccounted = [...sweptPrefixes().entries()]
			.filter(([prefix]) => {
				if (prefix === "step:") {
					return (
						classifyAppendKey("step:s:1:response") === "unknown" ||
						classifyAppendKey("step:s:1:tool:c") === "unknown" ||
						classifyAppendKey("step:s:1:empty") === "unknown"
					);
				}
				return (
					classifyAppendKey(`${prefix}x`) === "unknown" &&
					!NON_MESSAGE_KEY_PREFIXES.includes(prefix)
				);
			})
			.map(
				([prefix, files]) => `${prefix} (${[...new Set(files)].join(", ")})`,
			);
		expect(
			unaccounted,
			"a runner templates a key prefix the anatomy cannot classify; add it to APPEND_KEY_FAMILIES or NON_MESSAGE_KEY_PREFIXES",
		).toEqual([]);
	});

	it("keeps no family for a prefix the runners no longer template", () => {
		const swept = sweptPrefixes();
		const retired = APPEND_KEY_FAMILIES.map((family) => family.prefix).filter(
			(prefix) => !swept.has(prefix),
		);
		expect(
			retired,
			"a classified prefix no longer appears in the runner sources; remove its family",
		).toEqual([]);
	});
});
