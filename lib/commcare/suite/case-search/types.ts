// lib/commcare/suite/case-search/types.ts
//
// Shared structural types for the case-search wire-emission package.
// `compileForPlatform.ts` produces a `WireShape` from an authored
// `(caseListConfig, caseSearchConfig, platformContext)` triple; the
// `<remote-request>` orchestrator and downstream sub-emitters
// consume that shape to position the four wire flags in their
// CCHQ-prescribed slots. Keeping `WireShape` and `PlatformContext`
// here lets each consumer import only the shape it needs without
// circling back through `compileForPlatform.ts`.
//
// `WireShape` is Nova's internal compilation result — it is not
// exposed on the authoring surface. The author configures the
// content (filter, columns, search inputs); the platform context
// is supplied at the export boundary; the four flags fall out of
// pure inference. Authors never see this type, never set its
// fields, and the schema layer carries no parallel surface.

/**
 * Closed-set platform discriminator. CommCare ships exactly two
 * runtime players: Android (the device-installed player) and Web
 * Apps (the browser-hosted player). `iOS` is not a CommCare target;
 * any future runtime would land here as a new arm with its own
 * compilation branch.
 */
export type Platform = "android" | "web";

/**
 * Per-deploy capability flags the export adapter consults. These
 * model the CommCare HQ project's enabled feature toggles —
 * features the runtime supports vary by deploy, and the wire
 * shape must adapt accordingly.
 *
 *   - `splitScreenAvailable` — whether the target deploy has CCHQ's
 *     `SPLIT_SCREEN_CASE_SEARCH` toggle enabled. Drives the
 *     filters-in-sidebar / results-in-main-panel UX on web. When
 *     unavailable, the compiler falls back to list-first or
 *     skip-to-results emission depending on authored content.
 */
export interface PlatformFlags {
	readonly splitScreenAvailable: boolean;
}

/**
 * Per-export platform context. Supplied at the export boundary by
 * the call site that knows which runtime player + deploy
 * configuration the wire output is being shaped for. The compiler
 * is total against this context — every `(platform, flags)` pair
 * picks exactly one branch of the decision tree, never throws.
 */
export interface PlatformContext {
	readonly platform: Platform;
	readonly flags: PlatformFlags;
}

/**
 * The four wire flags the `<remote-request>` orchestrator + case-
 * list short-detail emitter consume. Each flag positions in a
 * specific CCHQ wire slot; the compiler produces a flag set, the
 * sub-emitters position them.
 *
 *   - `autoLaunch` — positions on the `<action auto_launch="...">`
 *     element inside `m{N}_case_short` (NOT on `<query>`). CCHQ's
 *     wire form is an XPath expression: `false()` when off; one of
 *     `AUTO_LAUNCH_EXPRESSIONS["single-select"|"multi-select"]`
 *     when on (per CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_auto_launch_expression`).
 *   - `defaultSearch` — positions on the
 *     `<query default_search="...">` attribute inside the
 *     `<remote-request>`'s `<session>` block, per CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_remote_request_queries`.
 *     Drives the runtime to execute the search immediately on
 *     screen entry rather than waiting for explicit submit.
 *   - `inlineSearch` — selects between the two storage-instance
 *     identifiers the search-side `<datum nodeset>` references:
 *     `instance('results')` (standalone-results) vs
 *     `instance('results:inline')` (inline-results). CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.get_query_datums`
 *     branches on `module_uses_inline_search(module)` to pick the
 *     instance name; the same flag also surfaces on the `<query
 *     inline_search>` attribute.
 *   - `splitScreen` — runtime UX hint: filters in sidebar, results
 *     in main panel. Positions on the `<query>` block per CCHQ's
 *     `SPLIT_SCREEN_CASE_SEARCH` machinery.
 *
 * The flag set is the only choice point. There is no parallel
 * "workflow mode" enum, no author override; every flag derives
 * from inference over content + platform context.
 */
export interface WireShape {
	readonly autoLaunch: boolean;
	readonly defaultSearch: boolean;
	readonly inlineSearch: boolean;
	readonly splitScreen: boolean;
}
