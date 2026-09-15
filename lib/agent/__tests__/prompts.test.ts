/** Pure app-state framing and request-local cache metadata. Native request
 * stability is exercised by wireCacheConfig against the actual SA factory.
 * Prompt prose is reviewed with its contract; substring inventories cannot
 * establish how a model follows that guidance. */

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import {
	buildAppStateMessage,
	isEditableDoc,
	markStablePrefixBoundary,
} from "../prompts";
import { expectAdmittedDoc } from "./admittedFixture";

/** Minimal populated blueprint — one module + one form + one field, with
 *  distinctive names the assertions can spot in (or prove absent from)
 *  rendered output. */
function fixtureDoc(appName: string, moduleName: string): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName,
			modules: [
				{
					name: moduleName,
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [f({ id: "note", kind: "text", label: "Note" })],
						},
					],
				},
			],
		}),
	);
}

/** Defensive in-memory empty shape; persisted `createApp` never writes this. */
function fixtureEmptyDoc(): BlueprintDoc {
	return {
		appId: "a-empty",
		appName: "Untitled",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("buildAppStateMessage", () => {
	it("carries current app orientation in a separate reference message", () => {
		const msg = buildAppStateMessage(fixtureDoc("Vaccine Tracker", "Patients"));
		expect(msg).not.toBeNull();
		expect(msg?.role).toBe("user");
		const content = msg?.content;
		expect(content).toContain("Current app overview");
		expect(content).toContain("Vaccine Tracker");
		expect(content).toContain("Patients");
	});

	it("returns null for a doc with nothing to summarize", () => {
		/* Same gate as the prompt branch: a build-prompt turn promises no
		 * app-state summary, so it must not receive one. */
		expect(buildAppStateMessage(fixtureEmptyDoc())).toBeNull();
		expect(isEditableDoc(fixtureEmptyDoc())).toBe(false);
	});
});

describe("markStablePrefixBoundary", () => {
	it("marks a request-local copy of the final user item", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			{ role: "user", content: [{ type: "text", text: "next" }] },
		];
		const marked = markStablePrefixBoundary(messages);
		const markedPart = Array.isArray(marked[2]?.content)
			? marked[2].content[0]
			: undefined;
		expect(
			markedPart !== undefined && "providerOptions" in markedPart
				? markedPart.providerOptions
				: undefined,
		).toEqual({
			openai: { promptCacheBreakpoint: { mode: "explicit" } },
		});
		const originalPart = Array.isArray(messages[2]?.content)
			? messages[2].content[0]
			: undefined;
		expect(
			originalPart !== undefined && "providerOptions" in originalPart
				? originalPart.providerOptions
				: undefined,
		).toBeUndefined();
	});

	it("walks past unmarkable assistant and tool items", () => {
		const marked = markStablePrefixBoundary([
			{ role: "user", content: [{ type: "text", text: "question" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "probe",
						output: { type: "json", value: {} },
					},
				],
			},
		]);
		const part = Array.isArray(marked[0]?.content)
			? marked[0].content[0]
			: undefined;
		expect(
			part !== undefined && "providerOptions" in part
				? part.providerOptions
				: undefined,
		).toBeDefined();
	});
});

it("marks scalar user content and system fallback without changing caller metadata", () => {
	const original: ModelMessage[] = [
		{
			role: "system",
			content: "Rules",
			providerOptions: { openai: { custom: "keep" } },
		},
		{ role: "assistant", content: "Prior answer" },
	];
	const before = structuredClone(original);
	const marked = markStablePrefixBoundary(original);
	expect(marked[0]).toMatchObject({
		role: "system",
		content: "Rules",
		providerOptions: {
			openai: { promptCacheBreakpoint: { mode: "explicit" } },
		},
	});
	expect(original).toEqual(before);
	const scalar = markStablePrefixBoundary([
		{ role: "user", content: "Question" },
	]);
	expect(scalar[0]?.content).toEqual([
		{
			type: "text",
			text: "Question",
			providerOptions: {
				openai: { promptCacheBreakpoint: { mode: "explicit" } },
			},
		},
	]);
	const unmarkable: ModelMessage[] = [{ role: "assistant", content: "Answer" }];
	expect(markStablePrefixBoundary(unmarkable)).toBe(unmarkable);
});
