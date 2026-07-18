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
import {
	type CaseListConfig,
	type CaseSearchConfig,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	type Module,
} from "@/lib/domain";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
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
 * The string-returning shape `emitRemoteRequest` produces for callers
 * that assert against the rendered XML (the test surface). The
 * compiler (`compileCcz`) consumes `RemoteRequestBuild` instead.
 *
 *   - `xml` — the serialized `<remote-request>` element.
 *   - `strings` — locale entries (`case_search.{m}` command label,
 *     `case_search.{m}.inputs` title, per-prompt entries) the
 *     compiler threads into per-language string tables.
 *   - `wire` — the computed `WireShape`. The case-list short-detail
 *     emitter consumes `wire.autoLaunch` for the `<action
 *     auto_launch>` element on `m{N}_case_short` without recomputing.
 */
export interface RemoteRequestEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly wire: WireShape;
}

/**
 * The Element-returning shape `buildRemoteRequest` produces for the
 * compiler (`compileCcz`). The rendered tree slots into the
 * surrounding `<suite>` parent without a parse-then-reserialize
 * round-trip.
 */
export interface RemoteRequestBuild {
	readonly element: Element;
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
export function buildRemoteRequest(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly platformContext?: PlatformContext;
	readonly typeContext?: TypeContext;
}): RemoteRequestBuild {
	const { module: mod, moduleIndex } = args;
	const platformContext = args.platformContext ?? DEFAULT_PLATFORM_CONTEXT;

	// Defensive narrowing — the upstream compiler gates on both slots,
	// but the type narrows locally here.
	if (mod.caseType === undefined || mod.caseSearchConfig === undefined) {
		const missing =
			mod.caseType === undefined && mod.caseSearchConfig === undefined
				? "neither a case type nor a caseSearchConfig"
				: mod.caseType === undefined
					? "no case type"
					: "no caseSearchConfig";
		throw new Error(
			`Tried to build a <remote-request> element for module index ${moduleIndex} ("${mod.name}"), but the module has ${missing}. ` +
				"A <remote-request> needs both slots set — the case type names the cases the search returns; the caseSearchConfig configures how the search runs. " +
				"`compileCcz` gates on both being present before calling this builder, so reaching here means a caller bypassed the gate. Check the call site against `compiler.ts::compileCcz`.",
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
	// Nova deliberately uses the short, friendly "Search" default on both
	// preview and wire paths instead of inheriting CCHQ's longer chrome. The schema's
	// `searchButtonLabel: z.string().min(1).optional()` guarantees the
	// slot is either `undefined` or a non-empty string — no `=== ""`
	// branch is needed here.
	const commandLabel =
		caseSearchConfig.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL;
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
		hasDetailScreen: caseListConfig.columns.some(
			(column) => column.visibleInDetail !== false,
		),
		typeContext: args.typeContext,
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

	return { element: remoteRequestEl, strings, wire };
}

/**
 * String adapter — serializes `buildRemoteRequest`'s Element for
 * callers that assert against the rendered XML string (the test
 * surface). `compileCcz` itself calls `buildRemoteRequest` directly.
 */
export function emitRemoteRequest(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly platformContext?: PlatformContext;
	readonly typeContext?: TypeContext;
}): RemoteRequestEmission {
	const { element, strings, wire } = buildRemoteRequest(args);
	return { xml: render(element, RENDER_OPTS), strings, wire };
}
