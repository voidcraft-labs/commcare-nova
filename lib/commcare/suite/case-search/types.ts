// lib/commcare/suite/case-search/types.ts
//
// Shared types for the case-search wire-emission package.
// `compileForPlatform` produces a `WireShape`; the `<remote-request>`
// orchestrator and the case-list short-detail emitter consume it.
// `WireShape` is Nova-internal — the author configures content, the
// platform comes from the export boundary, and the flags fall out
// of pure inference.

/**
 * Closed-set platform discriminator. CommCare ships two runtime
 * players: Android (device-installed) and Web Apps (browser-hosted).
 * A future runtime lands as a new arm with its own compilation branch.
 */
export type Platform = "android" | "web";

/**
 * Per-export platform context. Supplied at the export boundary by
 * whatever knows which runtime the wire output is being shaped for.
 */
export interface PlatformContext {
	readonly platform: Platform;
}

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
 * The flag set is the only choice point. No parallel "workflow
 * mode" enum, no author override.
 */
export interface WireShape {
	readonly autoLaunch: boolean;
	readonly defaultSearch: boolean;
	readonly inlineSearch: boolean;
}
