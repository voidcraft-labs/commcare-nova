import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";

// lib/commcare/suite/case-search/remoteRequest.ts
//
// Top-level orchestrator for `<remote-request>`. Walks one module
// with a `caseSearchConfig` and composes the full element from five
// pieces: `<post>` claim guard (`claim.ts`), `<command>` label,
// `<instance>` declarations (one per accumulated id), `<session>`
// body (`searchSession.ts`), `<stack>` rewind frame. The
// `WireShape` flag set comes from `compileForPlatform.ts` and
// drives the downstream sub-emitters' attribute choices.

import type { Element } from "domhandler";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type InstanceDecl,
	InstanceSink,
} from "@/lib/commcare/xpath/wire/instances";
import {
	CASE_SEARCH_BUTTON_LABEL,
	type CaseListConfig,
	effectiveCaseSearchConfig,
	emptyCaseListConfig,
	type Module,
	type OrdinaryCaseSearchConfig,
	type WireStringSource,
} from "@/lib/domain";
import type { DatumRef } from "@/lib/domain/expression/types";
import type { ModuleExpressionContexts } from "../../expressionContext";
import {
	buildClaimPost,
	SEARCH_CASE_ID_REF,
	SEARCH_SELECTED_CASES_REF,
} from "./claim";
import { compileForPlatform } from "./compileForPlatform";
import { searchScreenTranslationUnits } from "./inlineSearch";
import { buildSearchSession } from "./searchSession";
import type { PlatformContext, WireShape } from "./types";

/**
 * Default platform context — web. Callers compiling a per-Android
 * variant pass an override.
 */
export const DEFAULT_PLATFORM_CONTEXT: PlatformContext = { platform: "web" };

/**
 * The Element-returning shape `buildRemoteRequest` produces for the
 * compiler (`compileCcz`). The rendered tree slots into the
 * surrounding `<suite>` parent without a parse-then-reserialize
 * round-trip.
 */
export interface RemoteRequestBuild {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, WireStringSource>;
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
	readonly runtimeTarget?: RuntimeTarget;
	readonly moduleIndex: number;
	readonly platformContext?: PlatformContext;
	readonly expressions: ModuleExpressionContexts;
	readonly lookupNaming?: LookupWireNaming;
	/** Printed reads from the short and long details this request references. */
	readonly detailInstances?: Iterable<InstanceDecl>;
	/** The id each case chosen before the module's case list step prints
	 * under (`formLinkProjection.ts::caseListStepDatumId`). */
	readonly datumId?: (ref: DatumRef) => string | undefined;
}): RemoteRequestBuild {
	const { module: mod, moduleIndex } = args;
	const platformContext = args.platformContext ?? DEFAULT_PLATFORM_CONTEXT;

	// Defensive narrowing — the upstream compiler gates on both slots,
	// but the type narrows locally here.
	const effectiveSearch = effectiveCaseSearchConfig(mod);
	if (mod.caseType === undefined || effectiveSearch === undefined) {
		const missing =
			mod.caseType === undefined && effectiveSearch === undefined
				? "neither a case type nor a caseSearchConfig"
				: mod.caseType === undefined
					? "no case type"
					: "no caseSearchConfig";
		throw new Error(
			`Tried to build a <remote-request> element for module index ${moduleIndex} ("${mod.name}"), but the module has ${missing}. ` +
				"A <remote-request> needs both slots set, the case type names the cases the search returns; the caseSearchConfig configures how the search runs. " +
				"`compileCcz` gates on both being present before calling this builder, so reaching here means a caller bypassed the gate. Check the call site against `compiler.ts::compileCcz`.",
		);
	}

	const caseType: string = mod.caseType;
	const caseSearchConfig: OrdinaryCaseSearchConfig = effectiveSearch;
	const caseListConfig: CaseListConfig =
		mod.caseListConfig ?? emptyCaseListConfig();

	const wire = compileForPlatform(
		caseListConfig,
		caseSearchConfig,
		platformContext,
	);
	const multiple = caseListConfig.selection?.kind === "multiple";

	const moduleId = `m${moduleIndex}`;
	const commandLocaleId = `case_search.${moduleId}`;
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
		expressions: args.expressions,
		lookupNaming: args.lookupNaming,
		runtimeTarget: args.runtimeTarget,
		...(args.datumId === undefined ? {} : { datumId: args.datumId }),
	});

	const instances = new InstanceSink(sessionEmission.instances);
	instances.add(args.detailInstances ?? []);
	const context: WireElementContext = { mode: { target: "suite" }, instances };
	const post = buildClaimPost(multiple, context, args.runtimeTarget);

	// `<stack>` rewind frame — CCHQ's contract on every
	// `<remote-request>`. The frame pops the search-result selection
	// back onto the session stack so the surrounding entry's case-id
	// datum picks up the chosen case id without a second user
	// interaction.
	const stackEl = el("stack", {}, [
		el("push", {}, [
			xel(
				"rewind",
				{
					xpath: {
						value: multiple ? SEARCH_SELECTED_CASES_REF : SEARCH_CASE_ID_REF,
					},
				},
				context,
			),
		]),
	]);

	// `<remote-request>` children in canonical order: post → command →
	// instances → session → stack. The serializer preserves child
	// insertion order, so the rendered bytes match the canonical CCHQ
	// fixture
	// `~/code/commcare-hq/.../tests/data/suite/search_command_detail.xml`.
	const remoteRequestEl = el("remote-request", {}, [
		post,
		commandEl,
		...instances
			.declarations()
			.map(({ id, src }) => el("instance", { id, src })),
		sessionEmission.element,
		stackEl,
	]);

	// The button's text names no translation unit, so the compiler writes it
	// as it stands into every language's strings: the one text HQ's Case List
	// save keeps.
	const strings: Record<string, string> = {
		[commandLocaleId]: CASE_SEARCH_BUTTON_LABEL,
		...sessionEmission.strings,
	};
	const translationUnits: Record<string, WireStringSource> = {
		...sessionEmission.translationUnits,
		...searchScreenTranslationUnits(mod, moduleIndex, caseSearchConfig),
	};

	return { element: remoteRequestEl, strings, translationUnits, wire };
}
