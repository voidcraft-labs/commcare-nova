// lib/commcare/compiler.ts
//
// HqApplication + BlueprintDoc → .ccz Buffer.
//
// The compile pipeline takes the expanded HQ JSON (produced by
// `expandDoc`) and the source `BlueprintDoc`, and produces a .ccz ZIP
// archive ready for CommCare Mobile. The archive contains:
//
//   - profile.ccpr                : app profile (name + suite descriptors + logo)
//   - suite.xml                   : menus, commands, case details, entries, locales
//   - media_suite.xml             : media resource descriptor (empty when no media)
//   - commcare/<hash>.<ext>       : one bundled file per referenced media asset
//   - {lang}/app_strings.txt      : per-language localized string tables
//   - modules-{m}/forms-{f}.xml   : one XForm per form, with case blocks injected
//
// The domain doc is walked in lockstep with `hqJson.modules` so per-form
// metadata that the HQ wire shape doesn't carry (form type) can be
// resolved without index arithmetic. The parallel order is guaranteed
// by construction from `expandDoc`.
//
// Every XForm is re-validated after case-block injection; structural
// problems (orphaned binds, dangling refs) surface as a thrown Error
// before packaging.
//
// `suite.xml` and `profile.ccpr` are CONSTRUCTED as `domhandler` element
// trees and serialized once via `dom-serializer`. There is NO
// template-literal XML in this file: every attribute value flows through
// `setAttribute` (the `attribs` object literal); every text value flows
// through a `Text` node; the serializer is the single, exclusive
// escaping authority. The `<?xml version="1.0"?>` declaration is the
// only literal — `dom-serializer` does not emit XML declarations, so
// the compiler prepends one before each rendered tree.

import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import render from "dom-serializer";
import type { Element } from "domhandler";
import type { FormActions, HqApplication } from "@/lib/commcare";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { el, RENDER_OPTS, text } from "@/lib/commcare/elementBuilders";
import {
	caseListSessionDatums,
	entrySessionDatums,
	formLinkProjectionContext,
	moduleDestinationFrameChildren,
	previousFrameChildren,
	projectFormLinks,
	selectedCaseSessionDatum,
} from "@/lib/commcare/formLinkProjection";
import { serializeLocaleFileValue } from "@/lib/commcare/localeFile";
import { commCareLocalization } from "@/lib/commcare/localization";
import type { PreparedLookupWire } from "@/lib/commcare/lookup/fixtures";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBundle } from "@/lib/commcare/multimedia/bundle";
import { buildLogoProfileProperty } from "@/lib/commcare/multimedia/logoEntry";
import { buildNavMenuNode } from "@/lib/commcare/multimedia/navMenuMedia";
import {
	collectPredicateInstances,
	instanceSourceFor,
} from "@/lib/commcare/predicate/instances";
import {
	buildEntryElement,
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
} from "@/lib/commcare/session";
import { buildLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { buildShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { buildRemoteRequest } from "@/lib/commcare/suite/case-search/remoteRequest";
import {
	emitFormDisplayConditionForSuite,
	emitModuleDisplayCondition,
} from "@/lib/commcare/suite/displayConditions";
import {
	USERCASE_MISSING_LOCALE_ID,
	USERCASE_MISSING_MESSAGE,
} from "@/lib/commcare/usercaseWire";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";
import { moduleTypeContext } from "@/lib/commcare/validator/rules/case-list/shared";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	caseListColumnIsEmitted,
	defaultPostSubmit,
	effectiveCaseSearchConfig,
	makeTranslationUnitId,
	moduleParent,
	projectedModulePreorder,
	type Uuid,
	userPropertySlugsByUuid,
	type WireStringSource,
} from "@/lib/domain";
import { effectiveDisplayConditionForEmission } from "@/lib/domain/predicate";

/** Compile-time options. `assets` is the resolved media manifest; when
 *  present the archive bundles the referenced files + media_suite.xml +
 *  logo property + menu/command media. Absent = media-free archive
 *  (empty `media_suite.xml`, no logo property, no bundled media bytes,
 *  bare `<text>` nav nodes — the same archive shape with no media
 *  artifacts). */
export interface CompileOptions {
	assets?: AssetManifest;
	/**
	 * Prepared lookup wire from the export boundary: identity naming plus
	 * the budget-checked fixture blocks built from the one validated
	 * snapshot. Present only when the doc references lookup tables on the
	 * local-CCZ path.
	 */
	lookup?: PreparedLookupWire;
	/**
	 * The blueprint's `mutation_seq` at compile time, stamped into the
	 * profile.ccpr `cc-content-version` so each archive names the exact
	 * document version it was built from. Absent = the default `"1"` (tests +
	 * callers that don't thread a live seq). Does NOT touch the per-compile
	 * `uniqueid`, which HQ uses for version dedup.
	 */
	compiledAtSeq?: number;
}

/**
 * Compile an HQ application JSON (already expanded from a domain doc)
 * into a .ccz archive `Buffer`.
 *
 * `doc` is the source `BlueprintDoc` — its `moduleOrder` / `formOrder`
 * walk mirrors `hqJson.modules` / `hqJson.modules[m].forms` exactly,
 * which lets us resolve the form-type metadata (absent from the HQ
 * wire shape) while producing the session entry for each form.
 *
 * `opts.assets` is the resolved media manifest. It MUST be built from
 * the SAME manifest passed to `expandDoc` (so the jr:// references the
 * XForms + shells carry resolve to bundled files); the route that loads
 * assets passes one manifest to both. Absent = media-free archive.
 */
export function compileCcz(
	hqJson: HqApplication,
	appName: string,
	doc: BlueprintDoc,
	opts: CompileOptions = {},
): Buffer {
	const hqModules = hqJson.modules;
	const attachments = hqJson._attachments;
	const assets = opts.assets;
	const lookupNaming = opts.lookup?.naming;
	const userPropertySlugs = userPropertySlugsByUuid(doc);
	const localization = commCareLocalization(doc);

	// Output file map — each entry becomes a zip entry at the end.
	const files: Record<string, string> = {};

	// Media bundle: media_suite.xml descriptor, the multimedia_map (already
	// stamped on `hqJson` by the expander), and the CCZ byte entries. With no
	// manifest the bundle is empty and `mediaSuiteXml` is the byte-identical
	// empty placeholder, so a media-free app's archive is unchanged.
	const mediaBundle = buildMediaBundle(assets ?? new Map(), "compileCcz");

	// The set of `commcare/<hash><ext>` wire paths bundled into the archive
	// — derived from the SAME asset manifest the expander stamped jr://
	// references against. Both the XForm and suite oracle invocations below
	// receive this set so a generator drift between "what gets emitted as a
	// jr:// reference" and "what gets bundled" surfaces as an oracle finding
	// at compile time instead of as a broken-icon symptom on device.
	const bundledWirePaths = new Set(
		mediaBundle.cczEntries.map((entry) => entry.path),
	);

	files["profile.ccpr"] = generateProfile(
		appName,
		buildLogoProfileProperty(doc.logo, assets, "compileCcz logo"),
		opts.compiledAtSeq,
		derivedProfileProperties(doc),
	);
	files["media_suite.xml"] = mediaBundle.mediaSuiteXml;

	// `appStrings` is populated as we walk modules/forms; flushed once
	// per language at the end.
	const appStrings: Record<string, string> = {
		"homescreen.title": appName,
		"app.display.name": appName,
	};
	const appStringUnits: Record<string, WireStringSource> = {
		"homescreen.title": makeTranslationUnitId("app", "name"),
		"app.display.name": makeTranslationUnitId("app", "name"),
	};
	const mergeLocalizedStrings = (emission: {
		readonly strings: Record<string, string>;
		readonly translationUnits: Record<string, WireStringSource>;
	}): void => {
		Object.assign(appStrings, emission.strings);
		Object.assign(appStringUnits, emission.translationUnits);
	};
	// Top-level `<suite>` children accumulate as typed `Element[]`. The
	// orchestrator splices everything into one `<suite>` Element at the
	// end and serializes via `dom-serializer` exactly once. The spread
	// order into `<suite>.children` below pins the canonical wire layout
	// (resources → locales → details → remote-requests → entries →
	// menus) — the serializer preserves child insertion order, so the
	// rendered bytes match CCHQ's reference suite shape.
	const suiteEntries: Element[] = [];
	const suiteMenus: Element[] = [];
	const suiteDetails: Element[] = [];
	const suiteResources: Element[] = [];
	// `<remote-request>` elements accumulate alongside the other
	// top-level suite-XML element families. CCHQ's wire layout has
	// no canonical position for `<remote-request>` relative to
	// `<detail>` / `<entry>` / `<menu>`, so the compiler splices
	// these elements after the case-detail block and before the
	// `<entry>` block — placing them adjacent to the detail blocks
	// they reference (`m{N}_search_short` / `m{N}_search_long`)
	// keeps the rendered suite.xml structurally local.
	const suiteRemoteRequests: Element[] = [];

	// Walk HQ modules and the document's membership-array module sequence in
	// lockstep. `expandDoc` uses the same sequence, so the domain twin of
	// `hqModules[mIdx]` is `sortedModuleUuids[mIdx]`; per-module forms align
	// the same way.
	const sortedModuleUuids = projectedModulePreorder(doc);

	// The after-submit link projection and each form's `previous` frame read
	// every form's expanded actions. The expander already built them, so the
	// context reads them back by uuid instead of deriving a second set — the
	// entry's datums and the frames that reference them come from one source.
	const actionsByForm = new Map<Uuid, FormActions>();
	sortedModuleUuids.forEach((moduleUuid, mIdx) => {
		orderedFormUuids(doc, moduleUuid).forEach((formUuid, fIdx) => {
			const actions = hqModules[mIdx]?.forms[fIdx]?.actions;
			if (actions !== undefined) actionsByForm.set(formUuid, actions);
		});
	});
	const linkContext = formLinkProjectionContext(doc, {
		formActions: (formUuid) => {
			const actions = actionsByForm.get(formUuid);
			if (actions === undefined) {
				throw new Error(
					`Cannot project after-submit links: form ${formUuid} has no expanded actions`,
				);
			}
			return actions;
		},
		...(lookupNaming && { lookupNaming }),
	});

	for (let mIdx = 0; mIdx < hqModules.length; mIdx++) {
		const hqMod = hqModules[mIdx];
		const moduleUuid = sortedModuleUuids[mIdx];
		const formUuids = orderedFormUuids(doc, moduleUuid);

		const mod = doc.modules[moduleUuid];
		const modName = mod.name;
		const caseType = hqMod.case_type;
		const hqForms = hqMod.forms;
		const caseSearchConfig = effectiveCaseSearchConfig(mod);
		// Owner exclusion belongs to case availability, not to the presence of
		// a remote Search action. Read the raw authored slot so an owner-only
		// module still narrows its ordinary `casedb` list even when
		// `effectiveCaseSearchConfig` intentionally disables remote Search.
		const excludedOwnerIds = mod.caseSearchConfig?.excludedOwnerIds;
		const searchButtonDisplayCondition =
			caseSearchConfig?.searchButtonDisplayCondition;
		const effectiveModuleDisplayCondition =
			effectiveDisplayConditionForEmission(mod.displayCondition);
		const moduleRelevant = emitModuleDisplayCondition(
			effectiveModuleDisplayCondition,
			mod.caseType,
			lookupNaming,
			userPropertySlugs,
		);
		const moduleConditionInstances =
			effectiveModuleDisplayCondition === undefined
				? []
				: [
						...collectPredicateInstances(
							effectiveModuleDisplayCondition,
							lookupNaming,
						),
					].map((id) =>
						el("instance", { id, src: instanceSourceFor(id, lookupNaming) }),
					);

		appStrings[`modules.m${mIdx}`] = modName;
		appStringUnits[`modules.m${mIdx}`] = makeTranslationUnitId(
			"module",
			moduleUuid,
			"name",
		);

		// The persistent case tile. When the case list's tile layout asks to
		// stay on screen above the module's forms, every case-loading datum in
		// the module names the short detail as its persistent detail; Web Apps
		// then renders that tile in its sticky region above the form. The same
		// attribute rides the `caseListOnly` browse entry, matching CCHQ
		// (`commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.get_detail_persistent_attr`
		// is consulted for the form entry and the case-list command alike).
		const persistentTileDetailId =
			mod.caseListConfig?.tile?.persistOnForms === true
				? `m${mIdx}_case_short`
				: undefined;

		// The grouped-tile companion datum rides every case-loading FORM
		// entry in a grouped module, and nothing else. CCHQ's gate is
		// `entries.py::EntriesHelper.get_case_datums_basic_module`, which
		// calls `get_extra_case_id_datums` only under `if form:` and only
		// with a non-null case-selection datum — so a registration form's
		// entry and the `caseListOnly` browse entry below never carry it.
		const tileGrouping = mod.caseListConfig?.tile?.grouping;

		// Every calc-column expression on this module's case-list short /
		// long detail. Module-invariant (it depends only on
		// `caseListConfig.columns`), so it's computed once here and reused
		// by both case-loading entry paths below — the per-form entry and
		// the `caseListOnly` browse entry — each of which references the
		// `m{N}_case_short` / `m{N}_case_long` details these expressions
		// land on, and so must declare every `<instance>` they reach.
		const caseListColumnExpressions =
			mod.caseListConfig?.columns
				.filter(
					(c): c is Extract<typeof c, { kind: "calculated" }> =>
						c.kind === "calculated" && caseListColumnIsEmitted(c),
				)
				.map((c) => c.expression) ?? [];

		// Case detail definitions — emitted only when the module has a case
		// type. Short + long details are always paired.
		//
		// Both surfaces emit through typed emitters at
		// `@/lib/commcare/suite/case-list/{shortDetail,longDetail}.ts`,
		// which walk `module.caseListConfig.columns` directly (the typed
		// `Column` discriminated union with per-column sort directives,
		// calculated arms, and visibility flags) and return both the
		// suite-XML fragment and the locale-id → header-string map the
		// runtime renders against. The HQ-JSON projection on
		// `hqMod.case_details` is no longer consulted here; the typed
		// emitters own the wire shape end-to-end.
		//
		// `doc` threads through to the short-detail emitter so the
		// per-column sort comparator type can resolve from the case
		// property's declared `data_type` (or the calculated column's
		// expression's resolved result type). The long-detail emitter
		// accepts `doc` for API symmetry but doesn't read it.
		//
		// When search is authored (explicit config, or legacy inputs), the same
		// `caseListConfig` projects onto a second pair of wire ids —
		// `m{N}_search_short` + `m{N}_search_long`. Nova's principle:
		// "from the user's perspective there is only one case list,
		// regardless of how they get there." The wire emitter
		// duplicates the rendered content under the search-target
		// wire ids; the canonical fixture
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
		// pins the structural identity. Modules without an authored search
		// surface skip the search-target emission;
		// emission is purely additive.
		//
		// Both detail blocks resolve their `<title>` through CCHQ's
		// built-in `cchq.case` locale (registered with
		// `default="Case"` at
		// `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`).
		// Neither emitter registers a per-module title in app_strings;
		// the runtime falls back to "Case" until an author overrides
		// `cchq.case` at the app-strings layer (Nova has no such
		// authoring surface today).
		if (caseType) {
			// `<remote-request>` orchestrator. Computes the
			// `WireShape` for this module via `compileForPlatform`
			// (default platform context: web) and emits the full
			// `<remote-request>` element. The orchestrator returns
			// the `WireShape` so the surrounding short-detail
			// emission can render the `<action auto_launch>` element
			// with the matching expression — the action attribute
			// lives on `m{N}_case_short`, not on `<query>`, per
			// CCHQ's
			// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_action_kwargs`.
			//
			// Modules without an authored search surface skip this emission
			// entirely; their case-list short detail renders without
			// an `<action>` child. The two paths compose without
			// branch-doubling at the detail emitter — `searchAction`
			// is `undefined` when no case-search config is present.
			const remoteRequestEmission = caseSearchConfig
				? buildRemoteRequest({
						module: { ...mod, caseSearchConfig },
						moduleIndex: mIdx,
						typeContext: moduleTypeContext(mod, doc),
						lookupNaming,
					})
				: undefined;
			if (remoteRequestEmission !== undefined) {
				suiteRemoteRequests.push(remoteRequestEmission.element);
				mergeLocalizedStrings(remoteRequestEmission);
			}

			const shortEmission = buildShortDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
				...(assets && { assets }),
				...(lookupNaming && { lookupNaming }),
				...(remoteRequestEmission !== undefined && {
					searchAction: {
						autoLaunch: remoteRequestEmission.wire.autoLaunch,
						...(searchButtonDisplayCondition !== undefined && {
							displayCondition: searchButtonDisplayCondition,
						}),
					},
				}),
			});
			suiteDetails.push(shortEmission.element);
			mergeLocalizedStrings(shortEmission);

			const longEmission = buildLongDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
				...(assets && { assets }),
				...(lookupNaming && { lookupNaming }),
			});
			suiteDetails.push(longEmission.element);
			mergeLocalizedStrings(longEmission);

			// Search-target dual emission. Same `caseListConfig` walked
			// against the `"search"` target — produces `m{N}_search_short`
			// + `m{N}_search_long` blocks. Calc-column cross-case
			// references rewrite their instance root from `casedb` to
			// `results` per the canonical fixture
			// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`.
			// The search-target short detail does NOT carry an
			// `<action>` element — the search results screen IS the
			// action's destination.
			if (caseSearchConfig !== undefined) {
				const searchShort = buildShortDetail({
					module: mod,
					moduleIndex: mIdx,
					doc,
					target: "search",
					...(assets && { assets }),
					...(lookupNaming && { lookupNaming }),
				});
				suiteDetails.push(searchShort.element);
				mergeLocalizedStrings(searchShort);

				const searchLong = buildLongDetail({
					module: mod,
					moduleIndex: mIdx,
					doc,
					target: "search",
					...(assets && { assets }),
					...(lookupNaming && { lookupNaming }),
				});
				suiteDetails.push(searchLong.element);
				mergeLocalizedStrings(searchLong);
			}
		}

		const menuCommands: Element[] = [];

		for (let fIdx = 0; fIdx < hqForms.length; fIdx++) {
			const hqForm = hqForms[fIdx];
			const formUuid = formUuids[fIdx];
			// Form type + post-submit destination live only on the domain
			// doc. The HQ wire shape stores a coerced `post_form_workflow`
			// string whose mapping is lossy (e.g. "app_home" and an absent
			// field both round-trip through "default"), so the compiler
			// reads both fields straight from the doc to avoid losing
			// fidelity. Defaulting follows the form-type rule the expander
			// applies when emitting the wire payload.
			const form = doc.forms[formUuid];
			const formType = form.type;
			const postSubmit = form.postSubmit ?? defaultPostSubmit(formType);
			const ownCaseDatum = selectedCaseSessionDatum(
				doc,
				linkContext,
				moduleUuid,
				formUuid,
			);
			const ownCaseDatumId = ownCaseDatum?.id;
			const formRelevant = emitFormDisplayConditionForSuite(
				form.displayCondition,
				mod.caseType,
				lookupNaming,
				userPropertySlugs,
				ownCaseDatumId,
			);

			const formName = form.name;
			const xmlns = hqForm.xmlns;
			const uniqueId = hqForm.unique_id;
			const cmdId = `m${mIdx}-f${fIdx}`;
			const filePath = `modules-${mIdx}/forms-${fIdx}.xml`;

			appStrings[`forms.m${mIdx}f${fIdx}`] = formName;
			appStringUnits[`forms.m${mIdx}f${fIdx}`] = makeTranslationUnitId(
				"form",
				formUuid,
				"name",
			);

			// Build-time injection. The emitter produces a clean XForm (no case
			// blocks, no meta — those are CCHQ render-time artifacts the HQ-upload
			// source omits and CCHQ regenerates). The local .ccz has no CCHQ render
			// step, so the compiler mirrors `xform.py::add_case_and_meta` here:
			// `addCaseBlocks` splices the <case>/<subcase> transaction blocks from
			// the form's derived actions, then `addMetaBlock` appends the OpenRosa
			// <meta> block. Case-then-meta order matches CCHQ's instance layout.
			// `addMetaBlock` is unconditional — every form carries meta, surveys
			// included. `addCaseBlocks` reads the actions and returns the XForm
			// untouched when there is nothing to emit, so the module's case type
			// is passed through rather than gating the call: a form whose only
			// write is to the worker's own record has no case type and still
			// needs its block, and gating here would emit the suite datum and
			// the assertion for a write the form never makes.
			let xform = attachments[`${uniqueId}.xml`];
			if (xform) {
				xform = addCaseBlocks(
					xform,
					hqForm.actions,
					caseType || undefined,
					ownCaseDatumId === undefined
						? undefined
						: `instance('commcaresession')/session/data/${ownCaseDatumId}`,
					ownCaseDatum?.maxSelectValue === undefined,
				);
			}
			if (xform) {
				xform = addMetaBlock(xform);
			}

			// Entry — `deriveEntryDefinition` builds the datum + post-submit
			// stack from the form's type, its post-submit destination, the
			// module's case type, its projected after-submit links, the
			// module's authored case-list filter, the search-button display
			// condition, and this form's navigation display condition.
			//
			// The links and the `previous` frame are projected here from the
			// document (`formLinkProjection.ts`), not read back from the HQ
			// shape: the HQ `form_links` name target forms by HQ id, while
			// the local suite needs the target's frame children.
			//
			// Three authoring surfaces contribute to the entry's
			// `<instance>` accumulator:
			//   - `caseListConfig.filter` flows through verbatim; the wire
			//     layer at `session.ts::deriveSessionDatums` routes it
			//     through `emitNodesetFilter` to compose the bracketed
			//     fragment that appends to the case-loading datum's
			//     nodeset.
			//   - `caseSearchConfig.searchButtonDisplayCondition` lowers
			//     to the `<action relevant>` attribute on the case-list
			//     detail's search-action element, which evaluates in this
			//     entry's context.
			//   - `form.displayCondition` lowers to `<command relevant>` in
			//     the module menu. Nova's emitted topology has no same-id
			//     nested menu to shadow this direct matching entry in Core's
			//     selection order, so its instances are declared here too.
			//   - Calc-column expressions land on the module's
			//     `m{N}_case_short` / `m{N}_case_long` detail blocks the
			//     entry's `<datum detail-select / detail-confirm>`
			//     references. CCHQ resolves the detail's XPath against
			//     the enclosing entry's declarations, so every instance a
			//     calc expression reaches needs a matching `<instance>`
			//     here.
			//
			// Built BEFORE the validation gates so the binding-resolution
			// oracle has the entry's session datums to cross-check the
			// XForm's `instance('commcaresession')/session/data/<X>`
			// references against. `caseListColumnExpressions` is the
			// module-scoped accumulation hoisted above the form loop.
			const projectedLinks = projectFormLinks(doc, linkContext, formUuid);
			const entryDef = deriveEntryDefinition({
				formXmlns: xmlns,
				moduleIndex: mIdx,
				formIndex: fIdx,
				formType,
				postSubmit,
				caseType: caseType || undefined,
				...(projectedLinks !== undefined && { formLinks: projectedLinks }),
				/* The previous frame is read only when `previous` is the
				 * destination (plain, or as the guarded fallback). */
				previousFrame:
					postSubmit === "previous"
						? previousFrameChildren(doc, linkContext, moduleUuid, formUuid)
						: [],
				moduleFrame: moduleDestinationFrameChildren(
					doc,
					linkContext,
					moduleUuid,
				),
				projectedSessionDatums: entrySessionDatums(
					doc,
					linkContext,
					moduleUuid,
					formUuid,
				),
				caseListFilter: mod.caseListConfig?.filter,
				searchButtonDisplayCondition,
				caseListColumnExpressions:
					caseListColumnExpressions.length > 0
						? caseListColumnExpressions
						: undefined,
				actions: hqForm.actions,
				excludedOwnerIds,
				relationContext: moduleTypeContext(mod, doc),
				formDisplayCondition: form.displayCondition,
				lookupNaming,
				persistentDetailId: persistentTileDetailId,
				tileGrouping,
			});

			// Re-validate after injection — catches orphaned binds or
			// malformed structure introduced by the splice. The oracle
			// is a generator-totality check, not a user gate: a failing
			// XForm here is a compiler bug (the case-block splice
			// produced malformed structure), never a fixable authoring
			// state. Authoring rejection lives in the doc-layer rules
			// (`validator/rules/`); registration-time resolution narrowing for
			// typed case refs lives in `caseHashtagOnCreateForm`
			// (`validator/rules/form.ts`). The binding-resolution oracle
			// (`validator/bindingResolutionOracle.ts`) stays a fuzz-time
			// totality proof — it asserts that every doc the authoring
			// validator accepts compiles to a CCZ whose XPath references
			// all resolve — and is not invoked here.
			if (xform) {
				const xformErrors = validateXForm(
					xform,
					formName,
					modName,
					bundledWirePaths,
				);
				if (xformErrors.length > 0) {
					throw new Error(
						`XForm validation failed for "${formName}" in "${modName}" after case block injection:\n` +
							xformErrors.map((e) => `  - ${errorToString(e)}`).join("\n"),
					);
				}
			}

			files[filePath] = xform;

			// XForm resource declaration in suite.xml. Constructed via
			// nested `el(...)` calls — the serializer escapes the file
			// path and version once at render time.
			suiteResources.push(
				el("xform", {}, [
					el("resource", { id: filePath, version: "1" }, [
						el("location", { authority: "local" }, [text(`./${filePath}`)]),
					]),
				]),
			);

			// Form menu-command media: the entry's `<command>` display gains
			// `<text form="image|audio">` media locales (icon / audio label)
			// when the form carries them. The nav node is a bare `<text>` when
			// it doesn't, so the no-media shape is unchanged. Its app_strings
			// (the jr:// path locales) merge into the table the suite oracle
			// resolves `<locale id>` against.
			const formNav = buildNavMenuNode(
				`forms.m${mIdx}f${fIdx}`,
				form.icon,
				form.audioLabel,
				assets,
				"compileCcz form command",
			);
			Object.assign(appStrings, formNav.strings);
			// The worker-record assertion's message. CommCare throws
			// `NoLocalizedTextException` on a locale id with no app_strings
			// entry, so the string travels with the assertion that references
			// it rather than being seeded unconditionally — a suite that never
			// asserts carries no orphaned message.
			//
			// It carries no translation unit: it is Nova's own system copy
			// rather than something an author wrote, so every language table
			// takes the source text verbatim.
			if (entryDef.assertions !== undefined) {
				appStrings[USERCASE_MISSING_LOCALE_ID] = USERCASE_MISSING_MESSAGE;
			}
			suiteEntries.push(buildEntryElement(entryDef, formNav.node));
			menuCommands.push(
				el("command", {
					id: cmdId,
					...(formRelevant !== undefined && { relevant: formRelevant }),
				}),
			);
		}

		// Case-list-browse command for a `caseListOnly` module. CCHQ emits
		// a standalone case-list command + entry from its
		// `if module.case_list.show:` block (`entries.py`) when a module
		// shows its case list without an attached form — the shape Nova's
		// expander stamps as `case_list.show = true`. The local `.ccz`
		// compiler emits the matching command + entry so a directly-installed
		// archive reaches the case list (without this, a `caseListOnly`
		// module's `<menu>` carries zero commands and the case list is
		// unreachable on-device, diverging from the HQ-regenerated suite).
		//
		// Guarded on a present case type the same way the per-form case
		// path is — a `caseListOnly` module with no case type has no case
		// list to browse (and the validator's `caseListOnlyNoCaseType` rule
		// rejects that state upstream).
		if (mod.caseListOnly && caseType) {
			// The case-list command's display node. A bare
			// `<text><locale id="case_lists.m{N}"/></text>` when the module
			// carries no case-list menu media, or a `<display>` wrapping the
			// text + `<text form="image|audio">` media locales when it does
			// — the same builder the form / module nav nodes use, here fed
			// the case-list link's `icon` / `audioLabel` slots. This is the
			// render target the expander's `case_list.media_*` stamping
			// always implied but the local path previously had nowhere to
			// land.
			const caseListNav = buildNavMenuNode(
				`case_lists.m${mIdx}`,
				mod.caseListConfig?.icon,
				mod.caseListConfig?.audioLabel,
				assets,
				"compileCcz case-list command",
			);
			// The command's base label resolves to the module name —
			// matching CCHQ's `case_list.label = { en: mod.name }` shell
			// stamping in `expander.ts`. Its media locales (when present)
			// merge in alongside.
			appStrings[`case_lists.m${mIdx}`] = modName;
			appStringUnits[`case_lists.m${mIdx}`] = makeTranslationUnitId(
				"module",
				moduleUuid,
				"name",
			);
			Object.assign(appStrings, caseListNav.strings);

			// The browse entry: no `<form>`, a `case_id` datum carrying both
			// detail-select + detail-confirm, and the same instance
			// accumulation the form entry uses (the browse entry is the sole
			// loader of `m{N}_case_short` / `m{N}_case_long` in a formless
			// module). Calc-column expressions + the case-list filter +
			// any search-button display condition are read from the module
			// exactly as the per-form path reads them.
			const caseListEntryDef = deriveCaseListEntryDefinition(
				mIdx,
				caseType,
				mod.caseListConfig?.filter,
				searchButtonDisplayCondition,
				caseListColumnExpressions.length > 0
					? caseListColumnExpressions
					: undefined,
				(mod.caseListConfig?.columns ?? []).some(
					(column) => column.visibleInDetail !== false,
				),
				excludedOwnerIds,
				moduleTypeContext(mod, doc),
				lookupNaming,
				persistentTileDetailId,
				caseListSessionDatums(doc, linkContext, moduleUuid),
			);
			suiteEntries.push(buildEntryElement(caseListEntryDef, caseListNav.node));
			menuCommands.push(el("command", { id: `m${mIdx}-case-list` }));
		}

		// Module home-tile media: the `<menu>`'s display gains the icon /
		// audio-label media locales when the module carries them; an
		// un-mediafied menu emits the bare `<text><locale id="modules.m{N}"/></text>`
		// child.
		const moduleNav = buildNavMenuNode(
			`modules.m${mIdx}`,
			mod.icon,
			mod.audioLabel,
			assets,
			"compileCcz module menu",
		);
		Object.assign(appStrings, moduleNav.strings);

		suiteMenus.push(
			el(
				"menu",
				{
					...(moduleParent(doc, moduleUuid) !== null &&
					moduleParent(doc, moduleUuid) !== undefined
						? {
								root: `m${sortedModuleUuids.indexOf(
									moduleParent(doc, moduleUuid) as Uuid,
								)}`,
							}
						: {}),
					id: `m${mIdx}`,
					...(moduleRelevant !== undefined && { relevant: moduleRelevant }),
				},
				[moduleNav.node, ...moduleConditionInstances, ...menuCommands],
			),
		);
	}

	// HQ convention has TWO resources for the runtime default: the special
	// `default` locale used during initialization and the language's ordinary
	// named locale used by the worker-facing language picker. Every configured
	// language therefore gets its own named directory, including the first
	// language, while `default/` duplicates that first language's effective
	// table. CommCare Android removes only the literal `default` locale from its
	// picker; omitting the named copy would make it impossible to switch back to
	// the default language after choosing another one.
	const langs = localization.languages;
	const langDirs: Array<[lang: string, dir: string]> = [
		[localization.defaultLanguage, "default"],
		...langs.map((lang) => [lang, lang] as [lang: string, dir: string]),
	];

	const localeResources: Element[] = langDirs.map(([, dir]) =>
		el("locale", { language: dir }, [
			el("resource", { id: `app_strings_${dir}`, version: "1" }, [
				el("location", { authority: "local" }, [
					text(`./${dir}/app_strings.txt`),
				]),
			]),
		]),
	);

	// `<remote-request>` elements live alongside `<entry>` elements
	// in CCHQ's wire layout — both are top-level entry points the
	// runtime dispatches through. The compiler positions
	// `<remote-request>` before `<entry>` blocks so the rendered
	// suite reads "details for these cases, then the
	// remote-request that fetches them, then the form entries that
	// edit them." The conditional remote-requests block collapses to
	// an empty spread when no module carries an authored search surface.
	// Suite-embedded lookup fixtures land after `<menu>` blocks, matching
	// HQ's section order (its `FixtureContributor` runs after the module
	// entry/menu loop). `SuiteParser` dispatches on the element name at any
	// position; the placement is a pinned canonical choice, not a parse
	// requirement. The elements are the exact blocks the boundary's budget
	// measured.
	const suiteFixtures = (opts.lookup?.fixtures.fixtures ?? []).map(
		(fixture) => fixture.element,
	);
	const suiteRoot = el("suite", { version: "1" }, [
		...suiteResources,
		...localeResources,
		...suiteDetails,
		...suiteRemoteRequests,
		...suiteEntries,
		...suiteMenus,
		...suiteFixtures,
	]);
	// `dom-serializer` does not emit XML declarations — the leading
	// `<?xml version="1.0"?>` literal is the only template string in the
	// suite-XML emission path. CCHQ's `Application.create_suite` adds
	// the same declaration on the regenerated suite, so the literal
	// stays byte-equivalent across both paths.
	const suiteXml = `<?xml version="1.0"?>\n${render(suiteRoot, RENDER_OPTS)}`;

	// Suite-XML oracle gate. The oracle mirrors CommCare's suite-parse +
	// session-runtime contract — both the fatal-at-parse checks (malformed
	// XML, missing required attributes) AND the parse-clean / runtime-fatal
	// cross-reference checks (a menu command naming no entry, a datum
	// detail-select naming no detail, an `instance('foo')` reference with no
	// declaration). The device's load gate never catches that second class —
	// `Suite::getDetail` / `getEntry` are bare hashtable lookups returning null
	// on a miss — so they detonate later at session runtime. Asserting them here
	// turns a runtime crash on-device into a clear build-time error. The oracle
	// is a generator-totality oracle, not a user gate: a failing suite is a bug
	// in this compiler, never a fixable authoring state, so a non-empty result
	// throws. `appStrings` is fully populated by the module loop above, so its
	// key set is the complete locale registry the oracle resolves `<locale id>`
	// references against. (The oracle's own strict `XMLValidator.validate`
	// subsumes the well-formedness parse-check this replaced.)
	// The suite oracle's media-resolution check resolves menu-borne locales +
	// image-map XPath literals against the bundled wire paths. Threading the
	// app_strings table (key→value) AND the manifest closes the loop the
	// fuzz already exercises: a divergence between the suite emitter's jr://
	// references and what the bundler wrote into the CCZ surfaces at compile
	// time rather than as a broken-icon on device.
	const suiteErrors = validateSuite(
		suiteXml,
		new Set(Object.keys(appStrings)),
		{
			appStringValues: new Map(Object.entries(appStrings)),
			manifest: bundledWirePaths,
		},
	);
	if (suiteErrors.length > 0) {
		throw new Error(
			`Generated suite.xml failed the suite oracle:\n${suiteErrors
				.map((e) => `  - ${errorToString(e)}`)
				.join("\n")}`,
		);
	}

	// The `media_suite.xml` oracle. Catches a generator slip in the
	// `mediaSuiteXml` builder before the archive ships — duplicate resource
	// ids, missing authority, locations pointing at zip entries that aren't
	// bundled, etc. Same generator-totality posture as the suite oracle: a
	// failing media suite here is a compiler bug, never an authoring state.
	const mediaSuiteErrors = validateMediaSuite(
		mediaBundle.mediaSuiteXml,
		bundledWirePaths,
	);
	if (mediaSuiteErrors.length > 0) {
		throw new Error(
			`Generated media_suite.xml failed the media-suite oracle:\n${mediaSuiteErrors
				.map((e) => `  - ${errorToString(e)}`)
				.join("\n")}`,
		);
	}

	files["suite.xml"] = suiteXml;

	// Materialize every runtime table from the one canonical source registry.
	// A linked value resolves through the domain translation unit (including
	// stale/missing fallback); language-neutral media paths repeat unchanged.
	for (const [language, dir] of langDirs) {
		const table: Record<string, string> = {};
		for (const [localeId, source] of Object.entries(appStrings)) {
			const unitSource = appStringUnits[localeId];
			table[localeId] =
				unitSource === undefined
					? source
					: localization.wireTextFor(language, unitSource);
		}
		for (const code of localization.languages) {
			table[code] = localization.languageName(code);
		}
		table["lang.current"] = language;
		const localizedSuiteErrors = validateSuite(
			suiteXml,
			new Set(Object.keys(table)),
			{
				appStringValues: new Map(Object.entries(table)),
				manifest: bundledWirePaths,
			},
		);
		if (localizedSuiteErrors.length > 0) {
			throw new Error(
				`Generated suite.xml failed against the ${language} app-string table:\n${localizedSuiteErrors
					.map((error) => `  - ${errorToString(error)}`)
					.join("\n")}`,
			);
		}
		files[`${dir}/app_strings.txt`] = Object.entries(table)
			.map(([key, value]) => `${key}=${serializeLocaleFileValue(key, value)}`)
			.join("\n");
	}

	return packageCcz(files, mediaBundle.cczEntries);
}

/**
 * Generate the top-level profile.ccpr XML. The `uniqueid` is a fresh
 * UUID every compile — HQ treats each .ccz as a new app version, so
 * stable identity across compiles isn't required (and would defeat
 * HQ's version deduplication).
 *
 * Constructed via `domhandler` element tree + single `dom-serializer`
 * pass. The `<?xml version="1.0"?>` declaration is prepended as a
 * literal (the serializer doesn't emit declarations).
 *
 * The `appName` flows raw through the `name` attribute and the
 * `CommCare App Name` property value; the serializer XML-escapes both
 * once at render time (`&` / `<` / `>` / `"` / `'`).
 *
 * `logoProperty`, when present, is the web-apps banner
 * `<property key="brand-banner-web-apps" value="jr://file/..." force="true"/>`
 * built from `doc.logo`; it's appended to the property list. Absent =
 * no logo property (media off, or no logo set).
 *
 * `compiledAtSeq`, when present, is the blueprint's `mutation_seq` at
 * compile time; it's stamped into `cc-content-version` so the archive
 * names the exact document version it was built from. Absent (tests +
 * callers with no live seq) falls back to `"1"`.
 *
 * `derivedProperties` contains only Nova-owned profile optimizations. Each is
 * emitted with `force="true"`, matching CommCare HQ's custom-property profile
 * template. An empty record preserves the historical profile byte shape.
 */
function generateProfile(
	appName: string,
	logoProperty?: Element,
	compiledAtSeq?: number,
	derivedProperties: Readonly<Record<string, string>> = {},
): string {
	const profileEl = el(
		"profile",
		{
			xmlns: "http://cihi.commcarehq.org/jad",
			version: "1",
			uniqueid: randomUUID(),
			name: appName,
			update: "http://localhost/update",
		},
		[
			el("property", { key: "CommCare App Name", value: appName }),
			el("property", {
				key: "cc-content-version",
				value: String(compiledAtSeq ?? 1),
			}),
			el("property", { key: "cc-app-version", value: "1" }),
			...Object.entries(derivedProperties).map(([key, value]) =>
				el("property", { key, value, force: "true" }),
			),
			...(logoProperty ? [logoProperty] : []),
			el("features", {}, [el("users", { active: "true" })]),
			el("suite", {}, [
				el(
					"resource",
					{ id: "suite", version: "1", descriptor: "Suite Definition" },
					[el("location", { authority: "local" }, [text("./suite.xml")])],
				),
			]),
			el("suite", {}, [
				el(
					"resource",
					{
						id: "media-suite",
						version: "1",
						descriptor: "Media Suite Definition",
					},
					[el("location", { authority: "local" }, [text("./media_suite.xml")])],
				),
			]),
		],
	);
	return `<?xml version="1.0"?>\n${render(profileEl, RENDER_OPTS)}`;
}

/**
 * Pack the collected files into a ZIP archive and return the in-memory
 * buffer. Text files (`files`) are UTF-8 encoded; media files
 * (`mediaEntries`) are added as their raw bytes — routing binary media
 * through the UTF-8 text map would corrupt it.
 */
function packageCcz(
	files: Record<string, string>,
	mediaEntries: readonly { path: string; bytes: Buffer }[] = [],
): Buffer {
	const zip = new AdmZip();
	for (const [filePath, content] of Object.entries(files)) {
		zip.addFile(filePath, Buffer.from(content, "utf-8"));
	}
	for (const entry of mediaEntries) {
		zip.addFile(entry.path, entry.bytes);
	}
	return zip.toBuffer();
}
