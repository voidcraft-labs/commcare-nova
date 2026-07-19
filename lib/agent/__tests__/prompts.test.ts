/**
 * `buildSolutionsArchitectPrompt` / `buildAppStateMessage` unit tests.
 *
 * The load-bearing property here is prompt STABILITY: provider prompt
 * caching is exact-prefix, so the system prompt must be byte-identical
 * across turns and across docs — anything app-specific that leaked into
 * it would re-bill the shared tail + tool rendering + history on every
 * doc-mutating turn. The volatile blueprint summary travels instead as
 * the per-turn app-state message (`buildAppStateMessage`), and the two
 * halves share one gate (`isEditableDoc`) so the edit framing and the
 * summary it promises cannot come apart.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	buildAppStateMessage,
	buildSolutionsArchitectPrompt,
	isEditableDoc,
	markStablePrefixBoundary,
} from "../prompts";

/** Minimal populated blueprint — one module + one form + one field, with
 *  distinctive names the assertions can spot in (or prove absent from)
 *  rendered output. */
function fixtureDoc(appName: string, moduleName: string): BlueprintDoc {
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a-edit",
		appName,
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: {
				uuid: modUuid,
				id: "patients",
				name: moduleName,
				caseType: "patient",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "register",
				name: "Register Patient",
				type: "registration",
			},
		},
		fields: {
			[fieldUuid]: {
				uuid: fieldUuid,
				id: "patient_name",
				kind: "text",
				label: "Patient Name",
				required: xp("true()"),
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/** The degenerate doc `createApp` writes before generation starts. */
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

describe("buildSolutionsArchitectPrompt", () => {
	it("edit prompt carries the editing framing but ZERO doc bytes", () => {
		const sp = buildSolutionsArchitectPrompt(
			fixtureDoc("Vaccine Tracker", "Patients"),
		);
		expect(sp).toContain("Editing Mode");
		expect(sp).toContain("full visibility");
		/* The doc picks the branch and contributes nothing — an app name or
		 * module name in the prompt means the volatile summary leaked back
		 * into the cached prefix. */
		expect(sp).not.toContain("Vaccine Tracker");
		expect(sp).not.toContain("Patients");
	});

	it("edit prompt is byte-identical across different apps", () => {
		const a = buildSolutionsArchitectPrompt(
			fixtureDoc("Vaccine Tracker", "Patients"),
		);
		const b = buildSolutionsArchitectPrompt(
			fixtureDoc("Household Census", "Households"),
		);
		expect(a).toBe(b);
	});

	it("no doc, or an empty doc, renders the build prompt", () => {
		for (const sp of [
			buildSolutionsArchitectPrompt(),
			buildSolutionsArchitectPrompt(fixtureEmptyDoc()),
		]) {
			expect(sp).toContain("Initial Build");
			expect(sp).not.toContain("Editing Mode");
		}
	});
});

describe("buildAppStateMessage", () => {
	it("renders the fresh summary as a clearly-labeled reference message", () => {
		const msg = buildAppStateMessage(fixtureDoc("Vaccine Tracker", "Patients"));
		expect(msg).not.toBeNull();
		expect(msg?.role).toBe("user");
		const content = msg?.content as string;
		/* The label is the handle `EDIT_PREAMBLE` teaches — the model finds
		 * the summary by this name. */
		expect(content).toContain("Current app state");
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
	const BREAKPOINT = {
		openai: { promptCacheBreakpoint: { mode: "explicit" } },
	};

	/** Collect every marker location as "index:role:partType" strings. */
	function markerLocations(messages: ModelMessage[]): string[] {
		return messages.flatMap((m, i) => [
			...(m.providerOptions ? [`${i}:${m.role}:message`] : []),
			...(Array.isArray(m.content)
				? m.content.flatMap((p) =>
						(p as { providerOptions?: unknown }).providerOptions
							? [`${i}:${m.role}:${p.type}`]
							: [],
					)
				: []),
		]);
	}

	it("marks the last user message before the final user message", () => {
		/* NOT the assistant message between them: the Responses wire has no
		 * breakpoint slot on assistant `output_text` items, so an assistant
		 * marker would silently vanish from the request. */
		const messages: ModelMessage[] = [
			{ role: "system", content: "SYSTEM" },
			{ role: "user", content: [{ type: "text", text: "u1" }] },
			{ role: "assistant", content: [{ type: "text", text: "a1" }] },
			{ role: "user", content: [{ type: "text", text: "new question" }] },
		];
		const marked = markStablePrefixBoundary(messages);
		expect(markerLocations(marked)).toEqual(["1:user:text"]);
		const content = marked[1]?.content as Array<{ providerOptions?: unknown }>;
		expect(content[0]?.providerOptions).toEqual(BREAKPOINT);
		// Inputs are never mutated — the base array is reused across retries.
		expect(markerLocations(messages)).toEqual([]);
	});

	it("walks past unmarkable messages (tool results, assistant turns) to a user message", () => {
		const messages: ModelMessage[] = [
			{ role: "system", content: "SYSTEM" },
			{ role: "user", content: [{ type: "text", text: "u1" }] },
			{ role: "assistant", content: [{ type: "text", text: "a1" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "t1",
						toolName: "askQuestions",
						output: { type: "json", value: {} },
					},
				],
			},
			{ role: "user", content: [{ type: "text", text: "new question" }] },
		];
		expect(markerLocations(markStablePrefixBoundary(messages))).toEqual([
			"1:user:text",
		]);
	});

	it("falls back to the system message on a first turn", () => {
		const messages: ModelMessage[] = [
			{ role: "system", content: "SYSTEM" },
			{ role: "user", content: [{ type: "text", text: "only question" }] },
		];
		expect(markerLocations(markStablePrefixBoundary(messages))).toEqual([
			"0:system:message",
		]);
	});
});
