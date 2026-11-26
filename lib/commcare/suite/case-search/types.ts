// lib/commcare/suite/case-search/types.ts
//
// Shared types for the case-search wire-emission package.
// `searchWireShape` produces a `WireShape`; the `<remote-request>`
// orchestrator and the case-list short-detail emitter consume it.
// `WireShape` is Nova-internal: the flags are the authored workflow's
// spelling, one shape for every platform.

/**
 * The three wire flags the orchestrator and case-list short-detail
 * emitter consume. Each lands in a specific CCHQ wire slot:
 *
 *   - `autoLaunch` — `<action auto_launch="...">` inside
 *     `m{N}_case_short` (NOT on `<query>`). The wire form is an
 *     XPath expression — `false()` when off; one of CCHQ's
 *     `AUTO_LAUNCH_EXPRESSIONS` strings when on.
 *   - `defaultSearch` — `<query default_search="...">` inside
 *     `<remote-request>/<session>`. Drives the runtime to execute
 *     immediately on screen entry rather than waiting for submit.
 *   - `inlineSearch` — selects the storage-instance identifier
 *     `<datum nodeset>` references and the matching `<query
 *     storage-instance>` value: `results` (standalone) vs
 *     `results:inline` (inline). CCHQ does NOT emit a separate
 *     `<query inline_search>` attribute — the inline-vs-standalone
 *     distinction surfaces only through the chosen storage instance.
 *
 * `searchWireShape` spells the authored `caseSearchConfig.workflow` and
 * `formsReadSearch` as these flags; nothing else chooses them.
 */
export interface WireShape {
	readonly autoLaunch: boolean;
	readonly defaultSearch: boolean;
	readonly inlineSearch: boolean;
	readonly resultsName?: string;
}

/** The results instance a search stores into and every datum reads from:
 *  `results` for the standalone `<remote-request>` roundtrip, CCHQ's
 *  `RESULTS_INSTANCE_INLINE` for the inline shape
 *  (`suite_xml/post_process/remote_requests.py`). */
export type InlineSearchInstance = `results:${string}`;
export function inlineSearchInstance(
	name: string | undefined,
): InlineSearchInstance {
	return `results:${name ?? "inline"}`;
}
export function searchStorageInstance(
	wire: Pick<WireShape, "inlineSearch" | "resultsName">,
): "results" | InlineSearchInstance {
	return wire.inlineSearch ? inlineSearchInstance(wire.resultsName) : "results";
}

/** Core names the prompt answers after the instance into which it stored the results. */
export function searchInputInstanceId(
	wire: Pick<WireShape, "inlineSearch" | "resultsName">,
): `search-input:${ReturnType<typeof searchStorageInstance>}` {
	return `search-input:${searchStorageInstance(wire)}`;
}
