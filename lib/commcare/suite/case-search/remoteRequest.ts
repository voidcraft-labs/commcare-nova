// lib/commcare/suite/case-search/remoteRequest.ts
//
// Top-level orchestrator for `<remote-request>`. Walks one module
// with a `caseSearchConfig` and composes the full element from five
// pieces: `<post>` claim guard (`claim.ts`), `<command>` label,
// `<instance>` declarations (one per accumulated id), `<session>`
// body (`searchSession.ts`), `<stack>` rewind frame. The
// `WireShape` flag set comes from `compileForPlatform.ts` and
// drives the downstream sub-emitters' attribute choices.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import type { CaseListConfig, CaseSearchConfig, Module } from "@/lib/domain";
import { instanceSourceFor } from "../../predicate";
import { buildClaimPost, SEARCH_CASE_ID_REF } from "./claim";
import { compileForPlatform } from "./compileForPlatform";
import { buildSearchSession } from "./searchSession";
import type { PlatformContext, WireShape } from "./types";

/**
 * Default platform context — web. Callers compiling a per-Android
 * variant pass an override.
 */
export const DEFAULT_PLATFORM_CONTEXT: PlatformContext = { platform: "web" };

/**
 * Composed result of the orchestrator.
 *
 *   - `xml` — the `<remote-request>` element ready to splice into
 *     the surrounding `<suite>` at `<detail>` / `<entry>` indent depth.
 *   - `strings` — locale entries (`case_search.{m}` command label,
 *     `case_search.{m}.inputs` title, per-prompt entries) the
 *     compiler threads into per-language string tables.
 *   - `wire` — the computed `WireShape`. Returned so the case-list
 *     short-detail emitter can consume `wire.autoLaunch` for the
 *     `<action auto_launch>` element on `m{N}_case_short` without
 *     recomputing.
 */
export interface RemoteRequestEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly wire: WireShape;
}

/**
 * Compose the `<remote-request>` element. Pre-conditions:
 * `module.caseSearchConfig` and `module.caseType` are both set.
 * `lib/commcare/compiler.ts` is the upstream gate.
 *
 * `caseListConfig` defaults to an empty config when absent — the
 * `<remote-request>` still emits cleanly, with no filter, no
 * advanced inputs, no prompts.
 */
export function emitRemoteRequest(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly platformContext?: PlatformContext;
}): RemoteRequestEmission {
	const { module: mod, moduleIndex } = args;
	const platformContext = args.platformContext ?? DEFAULT_PLATFORM_CONTEXT;

	// Defensive narrowing — the upstream compiler gates on both slots,
	// but the type narrows locally here.
	if (mod.caseType === undefined || mod.caseSearchConfig === undefined) {
		throw new Error(
			"emitRemoteRequest was called on a module without both a case type and a case-search config. " +
				"Check the surrounding compiler — the case-search emission path should only fire when both are present. " +
				"Look at the call site in lib/commcare/compiler.ts for the gating condition.",
		);
	}

	const caseType: string = mod.caseType;
	const caseSearchConfig: CaseSearchConfig = mod.caseSearchConfig;
	const caseListConfig: CaseListConfig = mod.caseListConfig ?? {
		columns: [],
		searchInputs: [],
	};

	const wire = compileForPlatform(
		caseListConfig,
		caseSearchConfig,
		platformContext,
	);

	const moduleId = `m${moduleIndex}`;
	const commandLocaleId = `case_search.${moduleId}`;
	// `"Search All Cases"` is CCHQ's contract default for an unset
	// `search_button_label` (see `CaseSearch.search_button_label`). A
	// fresh Nova-authored search renders the same English text as a
	// CCHQ-authored one whose label was never customized. The schema's
	// `searchButtonLabel: z.string().min(1).optional()` guarantees the
	// slot is either `undefined` or a non-empty string — no `=== ""`
	// branch is needed here.
	const commandLabel = caseSearchConfig.searchButtonLabel ?? "Search All Cases";
	const commandEl = el("command", { id: `search_command.${moduleId}` }, [
		el("display", {}, [
			el("text", {}, [el("locale", { id: commandLocaleId })]),
		]),
	]);

	const sessionEmission = buildSearchSession({
		caseListConfig,
		caseSearchConfig,
		wire,
		caseType,
		moduleIndex,
	});

	// Instance declarations — sort the accumulated id set so the wire
	// form is deterministic across invocations regardless of Set
	// iteration order.
	const instanceElements: Element[] = Array.from(sessionEmission.instances)
		.sort()
		.map((id) => el("instance", { id, src: instanceSourceFor(id) }));

	// `<stack>` rewind frame — CCHQ's contract on every
	// `<remote-request>`. The frame pops the search-result selection
	// back onto the session stack so the surrounding entry's case-id
	// datum picks up the chosen case id without a second user
	// interaction.
	const stackEl = el("stack", {}, [
		el("push", {}, [el("rewind", { value: SEARCH_CASE_ID_REF })]),
	]);

	// `<remote-request>` children in canonical order: post → command →
	// instances → session → stack. The serializer preserves child
	// insertion order, so the rendered bytes match the canonical CCHQ
	// fixture
	// `~/code/commcare-hq/.../tests/data/suite/search_command_detail.xml`.
	const remoteRequestEl = el("remote-request", {}, [
		buildClaimPost(),
		commandEl,
		...instanceElements,
		sessionEmission.element,
		stackEl,
	]);

	const strings: Record<string, string> = {
		[commandLocaleId]: commandLabel,
		...sessionEmission.strings,
	};

	return { xml: render(remoteRequestEl, RENDER_OPTS), strings, wire };
}
