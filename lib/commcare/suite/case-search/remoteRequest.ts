// lib/commcare/suite/case-search/remoteRequest.ts
//
// Top-level orchestrator for `<remote-request>`. Walks one module
// with a `caseSearchConfig` and produces the full `<remote-request>`
// element, composing the four child element families per CCHQ's
// canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`:
//
//   <remote-request>
//     <post .../>            ← from `claim.ts`
//     <command id="search_command.{m}">
//       <display>
//         <text><locale id="case_search.{m}"/></text>
//       </display>
//     </command>
//     <instance ... />        ← one per accumulated instance
//     <session>...</session>  ← from `searchSession.ts`
//     <stack>
//       <push>
//         <rewind value="instance('commcaresession')/session/data/search_case_id"/>
//       </push>
//     </stack>
//   </remote-request>
//
// The orchestrator's responsibilities:
//
//   1. Choose the `WireShape` per platform (delegates to
//      `compileForPlatform`).
//   2. Compose the `<post>` claim guard (delegates to `claim.ts`).
//   3. Compose the `<command>` element — the search command label
//      mapped to the `case_search.{m}` locale per CCHQ's
//      `commcare-hq/corehq/apps/app_manager/id_strings.py::case_search_locale`.
//   4. Compose the `<session>` body (delegates to `searchSession.ts`).
//   5. Accumulate the instance set across the `<post>`, `<query>`,
//      and `<datum>` element bodies and emit one `<instance>`
//      declaration per id.
//   6. Compose the `<stack>` rewind frame (single-frame
//      `<rewind value="...search_case_id"/>` per CCHQ's
//      `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_stack`'s
//      no-smart-link branch).

import type { CaseListConfig, CaseSearchConfig, Module } from "@/lib/domain";
import { emitClaimPost, SEARCH_CASE_ID_REF } from "./claim";
import { compileForPlatform } from "./compileForPlatform";
import { emitSearchSession } from "./searchSession";
import type { PlatformContext, WireShape } from "./types";

/**
 * Default per-export platform context. Web is Nova's primary target
 * (the live-preview runtime, the .ccz path's per-mobile-player
 * variability is Dimagi's runtime concern); the orchestrator
 * accepts a context override at the call site for callers that
 * need to compile a per-Android variant.
 */
export const DEFAULT_PLATFORM_CONTEXT: PlatformContext = { platform: "web" };

/**
 * Composed result of the orchestrator. Three pieces flow out:
 *
 *   - `xml` — the full `<remote-request>` element, indented for
 *     splicing into the surrounding `<suite>` block at the same
 *     indent depth as `<detail>` / `<entry>` / `<menu>`.
 *   - `strings` — the `app_strings.txt` entries the surrounding
 *     compiler threads into per-language string tables. Includes
 *     the `case_search.{m}` command label, the
 *     `case_search.{m}.inputs` title, plus per-prompt locale ids
 *     accumulated from `emitSearchPrompts`.
 *   - `wire` — the `WireShape` flag set the orchestrator computed
 *     for this module. The case-list short-detail emitter consumes
 *     `wire.autoLaunch` to render the `<action auto_launch>`
 *     element on `m{N}_case_short`. Returning the shape lets the
 *     surrounding compiler thread the flag through without
 *     recomputing.
 */
export interface RemoteRequestEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly wire: WireShape;
}

/**
 * Compose the `<remote-request>` element for one module.
 *
 * Pre-condition: `module.caseSearchConfig !== undefined` AND
 * `module.caseType !== undefined`. The function is total against
 * those two preconditions; callers gate via
 * `module.caseSearchConfig` presence (the case-search authoring
 * surface requires a declared case type to be activated). The
 * compiler at `lib/commcare/compiler.ts` enforces the gate before
 * calling.
 *
 * `caseListConfig` defaults to an empty config when the module
 * carries no case-list authoring — the `<remote-request>` still
 * emits, with no filter, no advanced inputs, no prompts. CCHQ
 * accepts the empty shape cleanly; the runtime renders the search
 * screen with only the structural `<title>` element.
 */
export function emitRemoteRequest(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly platformContext?: PlatformContext;
}): RemoteRequestEmission {
	const { module: mod, moduleIndex } = args;
	const platformContext = args.platformContext ?? DEFAULT_PLATFORM_CONTEXT;

	// Gating contract — both slots must be present. The compiler's
	// branch `if (caseType && mod.caseSearchConfig)` is the upstream
	// gate; this defensive check keeps the type narrowing local.
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

	// Step 1 — `WireShape` per platform. Drives the `<query>`
	// attributes, the storage-instance choice, and (downstream at
	// the case-list short-detail emitter) the `<action auto_launch>`
	// attribute.
	const wire = compileForPlatform(
		caseListConfig,
		caseSearchConfig,
		platformContext,
	);

	// Step 2 — `<post>` claim emission. The post element is the
	// same five-line structural template across every emission;
	// `claim.ts` owns the literal.
	const postXml = emitClaimPost();

	// Step 3 — `<command>` element. The locale id pattern is
	// CCHQ's `case_search.{m}` per
	// `commcare-hq/corehq/apps/app_manager/id_strings.py::case_search_locale`;
	// the command id pattern is `search_command.{m}` per
	// `commcare-hq/corehq/apps/app_manager/id_strings.py::search_command`.
	const moduleId = `m${moduleIndex}`;
	const commandLocaleId = `case_search.${moduleId}`;
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

	// Step 4 — `<session>` body emission. Owns `<query>` + `<datum>`.
	// The session emission also reports the instance set its body
	// references; the orchestrator threads that set into the
	// `<instance>` declaration list.
	const sessionEmission = emitSearchSession({
		caseListConfig,
		caseSearchConfig,
		wire,
		caseType,
		moduleIndex,
	});

	// Step 5 — `<instance>` declarations. The base set every
	// `<remote-request>` requires (`casedb`, `commcaresession`,
	// the chosen results-instance) accumulates structurally in
	// `sessionEmission.instances`; emitting one `<instance>` per id
	// in sorted order keeps the wire form deterministic across
	// invocations regardless of Set iteration order.
	const instanceLines = Array.from(sessionEmission.instances)
		.sort()
		.map((id) => `    <instance id="${id}" src="${getInstanceSource(id)}"/>`);

	// Step 6 — `<stack>` element. CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_stack`
	// no-smart-link branch emits a single rewind frame pointing
	// back to the case_id session datum. Smart-link support is
	// Dimagi-specific and out of Nova's authoring scope.
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
 * Map an instance id to its `jr://` source URL. The four ids the
 * orchestrator emits today route to fixed CCHQ-canonical sources:
 *
 *   - `casedb` → `jr://instance/casedb`
 *   - `commcaresession` → `jr://instance/session`
 *   - `results` → `jr://instance/remote/results` (the standalone
 *     search-result instance per
 *     `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`).
 *   - `results:inline` → `jr://instance/remote/results:inline` (the
 *     inline embedded-result instance).
 *
 * Unrecognised ids throw — the orchestrator's instance accumulator
 * should only surface ids the wire layer knows how to source.
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
