/**
 * Wire-body pin for the SA's OpenAI Responses request — built through the
 * REAL production pieces (static prompt, app-state message, stable-prefix
 * breakpoint, reasoning provider options with the per-app cache pair,
 * strict:false tools) against a capturing fetch that never sends.
 *
 * This is the drift guard for the whole cache + statelessness configuration:
 * every assertion here is a field the provider must emit for caching or
 * privacy to work, and several (the breakpoint especially) would vanish
 * SILENTLY if a refactor moved them somewhere the Responses input converter
 * has no slot for — e.g. an assistant message's `output_text` items, which
 * carry no `prompt_cache_breakpoint`. Cheaper and stricter than a live
 * probe: the request body is asserted byte-level, offline, on every run.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type ModelMessage, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import { reasoningProviderOptions, SA_EDIT_MODEL } from "@/lib/models";
import {
	buildAppStateMessage,
	buildSolutionsArchitectPrompt,
	markStablePrefixBoundary,
} from "../prompts";

function fixtureDoc(): BlueprintDoc {
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a-probe",
		appName: "Probe App",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: {
				uuid: modUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "register",
				name: "Register",
				type: "registration",
			},
		},
		fields: {
			[fieldUuid]: { uuid: fieldUuid, id: "name", kind: "text", label: "Name" },
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/** The captured Responses API request body, typed loosely on purpose — the
 *  assertions pin the exact wire fields, not a TS mirror of them. */
interface CapturedBody {
	model?: string;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
	input?: Array<{
		role?: string;
		/** A plain string on system/developer items, part arrays elsewhere. */
		content?:
			| string
			| Array<{
					text?: string;
					prompt_cache_breakpoint?: { mode?: string };
			  }>;
	}>;
	tools?: Array<{ name?: string; strict?: boolean }>;
}

async function captureEditTurnBody(): Promise<CapturedBody> {
	let captured: CapturedBody | null = null;
	const capture: typeof fetch = async (_url, init) => {
		captured = JSON.parse(init?.body as string) as CapturedBody;
		return new Response(JSON.stringify({ error: { message: "intercepted" } }), {
			status: 500,
		});
	};
	const openai = createOpenAI({ apiKey: "sk-fake-never-sent", fetch: capture });

	const doc = fixtureDoc();
	const history: ModelMessage[] = [
		{ role: "user", content: [{ type: "text", text: "add a phone field" }] },
		{ role: "assistant", content: [{ type: "text", text: "Done — added." }] },
		{ role: "user", content: [{ type: "text", text: "rename the module" }] },
	];
	const appState = buildAppStateMessage(doc);
	if (!appState)
		throw new Error("populated doc must yield an app-state message");

	await generateText({
		model: openai(SA_EDIT_MODEL),
		system: buildSolutionsArchitectPrompt(doc),
		messages: [...markStablePrefixBoundary(history), appState],
		maxRetries: 0,
		tools: {
			updateModule: tool({
				description: "Update a module",
				inputSchema: z.object({ id: z.string(), name: z.string().optional() }),
				strict: false,
				execute: async () => "ok",
			}),
		},
		providerOptions: reasoningProviderOptions("medium", {
			promptCacheKey: "nova:app:a-probe",
		}),
	}).catch(() => {
		// expected — the capturing fetch answers 500 after recording the body
	});

	if (!captured) throw new Error("no request captured");
	return captured;
}

describe("SA edit-turn Responses wire body", () => {
	it("carries the full cache + statelessness configuration", async () => {
		const body = await captureEditTurnBody();

		expect(body.model).toBe(SA_EDIT_MODEL);
		// Stateless: nothing retained server-side, reasoning comes back as
		// self-contained encrypted items the thread can replay.
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
		expect(body.reasoning?.effort).toBe("medium");
		expect(body.reasoning?.summary).toBeTruthy();
		// The documented GPT-5.6 cache triple, as ONE unit.
		expect(body.prompt_cache_key).toBe("nova:app:a-probe");
		expect(body.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		// Non-strict tools: optionals stay omittable.
		expect(body.tools?.find((t) => t.name === "updateModule")?.strict).toBe(
			false,
		);
	});

	it("emits exactly one breakpoint, before the volatile tail", async () => {
		const body = await captureEditTurnBody();
		const input = body.input ?? [];

		const breakpoints = input.flatMap((item, i) =>
			(Array.isArray(item.content) ? item.content : []).flatMap((part) =>
				part.prompt_cache_breakpoint
					? [
							{
								index: i,
								role: item.role,
								mode: part.prompt_cache_breakpoint.mode,
							},
						]
					: [],
			),
		);
		expect(breakpoints).toHaveLength(1);
		const bp = breakpoints[0];
		expect(bp?.mode).toBe("explicit");
		// On a markable item (a user message — assistant output_text has no
		// breakpoint slot on this wire) …
		expect(bp?.role).toBe("user");
		// … and strictly before the two volatile trailing messages (the new
		// user message, the app-state message), so the cached prefix it marks
		// replays byte-identically next turn.
		expect(bp?.index).toBeLessThan(input.length - 2);

		// The app-state summary is the very last input item.
		const last = input[input.length - 1];
		expect(last?.role).toBe("user");
		const lastText = Array.isArray(last?.content)
			? last.content.map((p) => p.text ?? "").join("")
			: (last?.content ?? "");
		expect(lastText).toContain("Current app state");
	});
});
