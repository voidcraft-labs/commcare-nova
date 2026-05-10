// lib/commcare/suite/case-search/remoteRequest.ts
//
// Top-level orchestrator for `<remote-request>`. Walks one module
// with a `caseSearchConfig` and composes the full element from five
// pieces: `<post>` claim guard (`claim.ts`), `<command>` label,
// `<instance>` declarations (one per accumulated id), `<session>`
// body (`searchSession.ts`), `<stack>` rewind frame. The
// `WireShape` flag set comes from `compileForPlatform.ts` and
// drives the downstream sub-emitters' attribute choices.

import type { CaseListConfig, CaseSearchConfig, Module } from "@/lib/domain";
import { emitClaimPost, SEARCH_CASE_ID_REF } from "./claim";
import { compileForPlatform } from "./compileForPlatform";
import { emitSearchSession } from "./searchSession";
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

	const postXml = emitClaimPost();

	const moduleId = `m${moduleIndex}`;
	const commandLocaleId = `case_search.${moduleId}`;
	// `"Search All Cases"` is CCHQ's contract default for an unset
	// `search_button_label` (see `CaseSearch.search_button_label`). A
	// fresh Nova-authored search renders the same English text as a
	// CCHQ-authored one whose label was never customized.
	const commandLabel =
		caseSearchConfig.searchButtonLabel !== undefined &&
		caseSearchConfig.searchButtonLabel !== ""
			? caseSearchConfig.searchButtonLabel
			: "Search All Cases";
	const commandXml = [
		`    <command id="search_command.${moduleId}">`,
		`      <display>`,
		`        <text>`,
		`          <locale id="${commandLocaleId}"/>`,
		`        </text>`,
		`      </display>`,
		`    </command>`,
	].join("\n");

	const sessionEmission = emitSearchSession({
		caseListConfig,
		caseSearchConfig,
		wire,
		caseType,
		moduleIndex,
	});

	// Instance declarations — sort the accumulated id set so the wire
	// form is deterministic across invocations regardless of Set
	// iteration order.
	const instanceLines = Array.from(sessionEmission.instances)
		.sort()
		.map((id) => `    <instance id="${id}" src="${getInstanceSource(id)}"/>`);

	const stackXml = [
		`    <stack>`,
		`      <push>`,
		`        <rewind value="${SEARCH_CASE_ID_REF}"/>`,
		`      </push>`,
		`    </stack>`,
	].join("\n");

	const xml = [
		`  <remote-request>`,
		postXml,
		commandXml,
		instanceLines.join("\n"),
		sessionEmission.xml,
		stackXml,
		`  </remote-request>`,
	].join("\n");

	const strings: Record<string, string> = {
		[commandLocaleId]: commandLabel,
		...sessionEmission.strings,
	};

	return { xml, strings, wire };
}

/**
 * Map an instance id to its `jr://` source URL. Unrecognised ids
 * throw — the orchestrator's accumulator should only surface ids
 * the wire layer knows how to source.
 */
function getInstanceSource(instanceId: string): string {
	switch (instanceId) {
		case "casedb":
			return "jr://instance/casedb";
		case "commcaresession":
			return "jr://instance/session";
		case "results":
			return "jr://instance/remote/results";
		case "results:inline":
			return "jr://instance/remote/results:inline";
		default:
			throw new Error(
				`Unknown instance id '${instanceId}' reached the <remote-request> instance emitter. ` +
					"The orchestrator's instance accumulator surfaced an id without a known jr:// source. " +
					"Check lib/commcare/suite/case-search/searchSession.ts's instance accumulation — every accumulated id needs a corresponding case in getInstanceSource.",
			);
	}
}
