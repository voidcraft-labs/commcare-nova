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
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

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
	const modUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = testUuid("33333333-3333-3333-3333-333333333333");
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
				label: proseText("Patient Name"),
				required: xp("true()"),
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
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

describe("buildSolutionsArchitectPrompt", () => {
	it("opens a human turn before extended reasoning", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain("Make it your first visible output");
		expect(sp).toContain("before extended reasoning");
		expect(sp).toContain(
			"Do not treat the generated current-app-state message as a human turn",
		);
	});

	it("edit prompt carries the editing framing but ZERO doc bytes", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain("Editing Mode");
		expect(sp).toContain("full visibility");
		/* The doc picks the branch and contributes nothing — an app name or
		 * module name in the prompt means the volatile summary leaked back
		 * into the cached prefix. */
		expect(sp).not.toContain("Vaccine Tracker");
		expect(sp).not.toContain("Patients");
	});

	it("teaches the user-identity bridge and explicit-clear contract", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain("addUserProperties");
		expect(sp).toContain("userPropertyUuid");
		expect(sp).toContain("valuePatch");
		expect(sp).toContain("changes exactly one UUID-addressed value");
		expect(sp).toContain("Removing a persona preserves");
	});

	it("teaches exact one-tier menu placement without conflating case parents", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain("Nova supports one child-menu tier");
		expect(sp).toContain("`createModule.parentModuleUuid`");
		expect(sp).toContain("`moveModule` always takes `after`");
		expect(sp).toContain("separate from case `parent_type`");
		expect(sp).toContain("does not author linked/shadow form reuse");
	});

	it("keeps automation match counts on Builder Preview instead of SA reads", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain("Matching case counts belong only to Builder Preview");
		expect(sp).not.toContain(
			"counts the locally representable matching subset",
		);
	});

	it("teaches contextual automation host and message-property refusals", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).toContain(
			"advanced case operation can add a second extension relationship",
		);
		expect(sp).toContain(
			"host-scoped criterion, update target, update source, or message case-property part",
		);
		expect(sp).toContain("`owner`, `host`, or `last_modified_by`");
		expect(sp).toContain("formatter context shadows those names");
		expect(sp).toContain(
			"Every triggering case must contain each referenced filter property",
		);
		expect(sp).toContain(
			"HQ filters only contacts that resolve to user accounts",
		);
		expect(sp).toContain("case, parent/child-case, case-email, case-group");
		expect(sp).toContain(
			"case-property event-time value must begin with H:MM or HH:MM",
		);
		expect(sp).toContain("AM/PM or seconds are accepted");
		expect(sp).toContain("blank, nonmatching, or unparseable values");
		expect(sp).toContain("12:00 PM");
		expect(sp).toContain(
			"Every host-scoped reference also requires exactly one live extension at runtime",
		);
		expect(sp).toContain(
			"Retained extra extension indices make the current-match count unavailable",
		);
	});

	it("edit prompt is byte-identical across different apps", () => {
		const a = buildSolutionsArchitectPrompt();
		const b = buildSolutionsArchitectPrompt();
		expect(a).toBe(b);
	});

	it("has no build composition — the design pipeline owns new-app builds", () => {
		const sp = buildSolutionsArchitectPrompt();
		expect(sp).not.toContain("Initial Build");
		expect(sp).toContain("Editing Mode");
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
