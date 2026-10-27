import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import {
	profileServerProperties,
	profileUniqueId,
	type RuntimeTarget,
} from "@/lib/commcare/runtimeTarget";
import { buildEntryPointSuite } from "./entryPointSuite";
import { COMMCARE_VERSION_FLOOR } from "./versionFloor";
import { assertXml } from "./xmlParse";
// lib/commcare/compiler.ts
//
// HqApplication + BlueprintDoc → .ccz Buffer.
//
// The compile pipeline takes the expanded HQ JSON (produced by
// `expandDoc`) and the source `BlueprintDoc`, and produces a .ccz ZIP
// archive ready for CommCare Mobile. The archive contains:
//
//   - profile.ccpr                : app profile (identity, versions, settings, suite descriptors, logo)
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
// trees and serialized once via `serializeXml`. There is NO
// template-literal XML in this file: every attribute value flows through
// `setAttribute` (the `attribs` object literal); every text value flows
// through a `Text` node; the serializer is the single, exclusive
// escaping authority. The `<?xml version="1.0"?>` declaration is the
// only literal — `serializeXml` does not emit XML declarations, so
// the compiler prepends one before each rendered tree.

import AdmZip from "adm-zip";
import type { Element } from "domhandler";
import type { FormActions, HqApplication } from "@/lib/commcare";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { el, text, xel } from "@/lib/commcare/elementBuilders";
import {
	moduleExpressionContexts,
	requireExpressionContext,
} from "@/lib/commcare/expressionContext";
import {
	caseListFormReturnFrame,
	caseListSessionDatums,
	caseListStepDatumId,
	entryDatumIdResolver,
	entryDatumIds,
	entryFrameDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
	inlineSearchFor,
	moduleCaseTypeForActions,
	moduleDestinationFrameChildren,
	moduleIndexOf,
	parentMenuDestinationFrameChildren,
	parentSelectModuleUuid,
	previousFrameChildren,
	projectFormLinks,
	selectedCaseSessionDatum,
	sessionDataRef,
} from "@/lib/commcare/formLinkProjection";
import { serializeLocaleFileValue } from "@/lib/commcare/localeFile";
import { commCareLocalization } from "@/lib/commcare/localization";
import type { PreparedLookupWire } from "@/lib/commcare/lookup/fixtures";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBundle } from "@/lib/commcare/multimedia/bundle";
import { buildLogoProfileProperty } from "@/lib/commcare/multimedia/logoEntry";
import { buildNavMenuNode } from "@/lib/commcare/multimedia/navMenuMedia";
import { serializeXml } from "@/lib/commcare/serializeXml";
import {
	buildEntryElement,
	deriveCaseListEntryDefinition,
	deriveEntryDefinition,
	type EntryDefinition,
	type SessionDatum,
} from "@/lib/commcare/session";
import { buildLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import {
	buildShortDetail,
	type RegisterActionContext,
} from "@/lib/commcare/suite/case-list/shortDetail";
import { buildInlineClaimPost } from "@/lib/commcare/suite/case-search/claim";
import { moduleIsSearchFirst } from "@/lib/commcare/suite/case-search/inlineSearch";
import {
	NEVER_RELEVANT,
	NO_MATCHES_RELEVANCY,
} from "@/lib/commcare/suite/case-search/noMatches";
import { buildRemoteRequest } from "@/lib/commcare/suite/case-search/remoteRequest";
import {
	emitFormDisplayConditionForSuite,
	emitModuleDisplayCondition,
} from "@/lib/commcare/suite/displayConditions";
import {
	FORM_SUBMIT_LABEL,
	formSubmitLabelLocaleId,
} from "@/lib/commcare/suite/formStrings";
import {
	USERCASE_MISSING_LOCALE_ID,
	USERCASE_MISSING_MESSAGE,
} from "@/lib/commcare/usercaseWire";
import { errorToString } from "@/lib/commcare/validator/errors";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { stripVellumAttributes } from "@/lib/commcare/xform/deviceForm";
import { setFormVersion } from "@/lib/commcare/xform/formVersion";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	effectivePostSubmit,
	makeTranslationUnitId,
	moduleParent,
	projectedModulePreorder,
	type Uuid,
	type WireStringSource,
} from "@/lib/domain";
import {
	caseListFormLabelUnit,
	emissionPlan,
	type SyntheticModule,
} from "./emissionPlan";
import { type InstanceDecl, InstanceSink } from "./xpath/wire/instances";

/** Compile-time options. `assets` is the resolved media manifest; when
 *  present the archive bundles the referenced files + media_suite.xml +
 *  logo property + menu/command media. Absent = media-free archive
 *  (empty `media_suite.xml`, no logo property, no bundled media bytes,
 *  bare `<text>` nav nodes — the same archive shape with no media
 *  artifacts). */
export interface CompileOptions {
	/** The deployment the archive is made for: no archive is compiled without one. */
	readonly runtimeTarget: RuntimeTarget;
	assets?: AssetManifest;
	/**
	 * Prepared lookup wire from the export boundary: identity naming plus
	 * the budget-checked fixture blocks built from the one validated
	 * snapshot. Present only when the doc references lookup tables on the
	 * local-CCZ path.
	 */
	lookup?: PreparedLookupWire;
	/**
	 * The blueprint's `mutation_seq` at compile time: the sequence. It is
	 * `cc-content-version`, `cc-app-version`, every form and locale
	 * resource's version and every form's data `version`, so a later
	 * download is newer in every resource the document changed. Absent reads
	 * 1, for a caller that holds no app row.
	 */
	compiledAtSeq?: number;
	/**
	 * How many HQ apps the target's deployment held before the one it holds
	 * now. The archive's version, which the profile, its two suite resources
	 * and `<suite>` carry, is the sequence plus this, so a file made after the
	 * target's HQ app was made afresh is newer to a phone at an unchanged
	 * sequence. Absent reads 0.
	 */
	earlierHqApps?: number;
	/**
	 * The target project space holds `USH_EMPTY_CASE_LIST_TEXT`, so every
	 * short detail carries the empty-list text, as HQ's build there does.
	 * Absent reads false.
	 */
	emptyCaseListText?: boolean;
}

/** The entry's new-case datum for `caseType` (`case_id_new_<type>_0`). */
function newCaseDatumId(
	datums: readonly SessionDatum[],
	caseType: string,
): string {
	const datum = datums.find(
		(candidate) =>
			candidate.nodeset === undefined &&
			candidate.caseType === caseType &&
			candidate.id.startsWith("case_id_new_"),
	);
	if (datum === undefined) {
		throw new Error(
			`Cannot build the no-matches return frame: the registration entry has no new-case datum for "${caseType}"`,
		);
	}
	return datum.id;
}

/**
 * The Register action of a host module, HQ's
 * `DetailContributor.get_datums_for_action`: every datum of the target
 * entry in order, a function datum as its function and a selection datum
 * as the session value of the host's FIRST menu form's datum of the same
 * case type (`case-list-form-suite-parent-child-basic.xml`). HQ matches
 * against that one form and drops a selection datum it cannot match, so a
 * host without menu forms offers function datums alone; the validator
 * refuses a no-matches form on such a host when its case type selects a
 * parent first (`SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM`).
 */
function registerActionFor(
	doc: BlueprintDoc,
	linkContext: FormLinkProjectionContext,
	noMatches: SyntheticModule,
): RegisterActionContext {
	const target = entryFrameDatums(
		doc,
		linkContext,
		noMatches.moduleUuid,
		noMatches.formUuid,
	);
	const [firstMenuForm] = linkContext.formOrder[noMatches.hostModuleUuid] ?? [];
	const source =
		firstMenuForm === undefined
			? []
			: entryFrameDatums(
					doc,
					linkContext,
					noMatches.hostModuleUuid,
					firstMenuForm,
				);
	return {
		commandId: `m${moduleIndexOf(linkContext, noMatches.moduleUuid)}-f0`,
		datums: target.flatMap((datum) => {
			if (!datum.requiresSelection) {
				return datum.function === undefined
					? []
					: [{ id: datum.id, value: datum.function }];
			}
			const matches = source.filter(
				(candidate) =>
					candidate.requiresSelection && candidate.caseType === datum.caseType,
			);
			return matches.length === 1
				? [{ id: datum.id, value: sessionDataRef(matches[0].id) }]
				: [];
		}),
		relevant: NO_MATCHES_RELEVANCY,
	};
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
	authoredDoc: BlueprintDoc,
	opts: CompileOptions,
): Buffer {
	// The same derived module sequence the expander walked
	// (`emissionPlan.ts`): authored modules with their menu forms, then the
	// hidden module of each no-matches registration form.
	const plan = emissionPlan(authoredDoc);
	const doc = plan.doc;
	const hqModules = hqJson.modules;
	const attachments = hqJson._attachments;
	const assets = opts.assets;
	const lookupNaming = opts.lookup?.naming;
	const localization = commCareLocalization(authoredDoc);
	const sequence = opts.compiledAtSeq ?? 1;
	const archiveVersion = sequence + (opts.earlierHqApps ?? 0);
	const emptyCaseListText = opts.emptyCaseListText === true;

	// Output file map — each entry becomes a zip entry at the end.
	const files: Record<string, string> = {};

	// Media bundle: media_suite.xml descriptor and the CCZ byte entries. With no
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

	files["profile.ccpr"] = generateProfile({
		doc: authoredDoc,
		appName,
		runtimeTarget: opts.runtimeTarget,
		firstLanguage: localization.languages[0],
		sequence,
		archiveVersion,
		logoProperty: buildLogoProfileProperty(doc.logo, assets, "compileCcz logo"),
		derivedProperties: derivedProfileProperties(doc),
	});
	assertXml(files["profile.ccpr"]);
	files["media_suite.xml"] = mediaBundle.mediaSuiteXml;

	// `appStrings` is populated as we walk modules/forms; flushed once
	// per language at the end.
	const appStrings: Record<string, string> = {
		"homescreen.title": appName,
		"app.display.name": appName,
		"cchq.case": "Case",
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
	// end and serializes via `serializeXml` exactly once. The spread
	// order into `<suite>.children` below pins the canonical wire layout
	// (resources → locales → details → remote-requests → entries →
	// menus) — the serializer preserves child insertion order, so the
	// rendered bytes match CCHQ's reference suite shape.
	const suiteEntryDefinitions: Array<{
		definition: EntryDefinition;
		commandDisplay: Element;
	}> = [];
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
	const detailInstances = new Map<string, readonly InstanceDecl[]>();
	const rememberDetail = (emission: {
		element: Element;
		instances: readonly InstanceDecl[];
	}): void => {
		const id = emission.element.attribs.id;
		if (id === undefined)
			throw new Error("A rendered case detail needs its wire id.");
		detailInstances.set(id, emission.instances);
	};
	const instancesForDatums = (
		datums: readonly SessionDatum[],
	): readonly InstanceDecl[] => {
		const sink = new InstanceSink();
		for (const datum of datums) {
			for (const id of [
				datum.detailSelect,
				datum.detailConfirm,
				datum.detailPersistent,
			]) {
				if (id === undefined) continue;
				const declarations = detailInstances.get(id);
				if (declarations === undefined)
					throw new Error(
						`A session datum names detail '${id}', but the suite contains no such detail.`,
					);
				sink.add(declarations);
			}
		}
		return sink.declarations();
	};

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
		expressionDoc: authoredDoc,
		runtimeTarget: opts.runtimeTarget,
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
		const expressions = moduleExpressionContexts(doc, moduleUuid, lookupNaming);
		const modName = mod.name;
		// The hidden module of a no-matches form, or the host that offers one.
		const synthetic = plan.synthetic.get(moduleUuid);
		// What the local suite builds from a case type follows the gate, not
		// the uploaded `case_type`, which a survey-only menu writes as its own
		// type. The hidden menu of a no-matches form reads the uploaded type,
		// its host's.
		const caseType =
			synthetic === undefined
				? moduleCaseTypeForActions(doc, moduleUuid)
				: hqMod.case_type;
		const hqForms = hqMod.forms;
		const caseSearchConfig = effectiveCaseSearchConfig(mod);
		const noMatches = plan.noMatchesFormOf.get(moduleUuid);
		// Owner exclusion belongs to case availability, not to the presence of
		// a remote Search action. Read the raw authored slot so an owner-only
		// module still narrows its ordinary `casedb` list even when
		// `effectiveCaseSearchConfig` intentionally disables remote Search.
		const excludedOwnerIds = mod.caseSearchConfig?.excludedOwnerIds;
		// A search-first module runs its search inside each entry: no
		// `<remote-request>`, no Search action on the list (so no display
		// condition to emit), no `m{N}_search_*` details, and every
		// case-loading datum reads `results:inline`.
		const searchFirst = moduleIsSearchFirst(mod);
		const searchButtonDisplayCondition = searchFirst
			? undefined
			: caseSearchConfig?.searchButtonDisplayCondition;
		const caseSource = searchFirst ? ("results:inline" as const) : undefined;
		// A no-matches form's synthetic module is never relevant; the Register
		// action's push reaches its entry regardless
		// (`CommCareSession.performPushInner`).
		const moduleRelevant =
			synthetic !== undefined
				? NEVER_RELEVANT
				: emitModuleDisplayCondition(
						mod,
						expressions({ slot: "module_display_condition" }),
						lookupNaming,
					);

		appStrings[`modules.m${mIdx}`] = modName;
		// A hidden module is named for its one form; it has no unit of its own.
		appStringUnits[`modules.m${mIdx}`] =
			synthetic === undefined
				? makeTranslationUnitId("module", moduleUuid, "name")
				: makeTranslationUnitId("form", synthetic.formUuid, "name");

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
		// Both detail titles reference cchq.case. The compiler registers the
		// value in every locale table; Core has no built-in mapping for this id.
		// The Register action a search-first host mounts on its case list
		// (`DetailContributor.add_register_action`): the no-matches form's
		// command in its hidden module, the target entry's computed datums,
		// and `return_to`, relevant only when the inline search found nothing.
		const registerAction =
			noMatches === undefined
				? undefined
				: registerActionFor(doc, linkContext, noMatches);
		if (noMatches !== undefined) {
			const label = doc.forms[noMatches.formUuid];
			appStrings[`case_list_form.m${mIdx}`] =
				label?.entry?.label ?? label?.name ?? "";
			appStringUnits[`case_list_form.m${mIdx}`] = caseListFormLabelUnit(
				authoredDoc,
				noMatches.formUuid,
			);
		}

		// A hidden module has no case list: its one entry is reached by the
		// Register action, and HQ regenerates no detail for a module whose
		// forms never select a case.
		if (caseType && synthetic === undefined) {
			const searchShort =
				caseSearchConfig !== undefined && !searchFirst
					? buildShortDetail({
							module: mod,
							moduleIndex: mIdx,
							doc,
							target: "search",
							emptyCaseListText,
							...(assets && { assets }),
							...(lookupNaming && { lookupNaming }),
						})
					: undefined;
			const searchLong =
				caseSearchConfig !== undefined && !searchFirst
					? buildLongDetail({
							module: mod,
							moduleIndex: mIdx,
							doc,
							target: "search",
							...(assets && { assets }),
							...(lookupNaming && { lookupNaming }),
						})
					: undefined;

			// `<remote-request>` orchestrator. Computes the
			// `WireShape` for this module via `searchWireShape`
			// and emits the full
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
			const remoteRequestEmission =
				caseSearchConfig && !searchFirst
					? buildRemoteRequest({
							runtimeTarget: opts.runtimeTarget,
							module: { ...mod, caseSearchConfig },
							moduleIndex: mIdx,
							expressions,
							lookupNaming,
							datumId: caseListStepDatumId(doc, moduleUuid),
							detailInstances: [
								...(searchShort?.instances ?? []),
								...(searchLong?.instances ?? []),
							],
						})
					: undefined;
			if (remoteRequestEmission !== undefined) {
				suiteRemoteRequests.push(remoteRequestEmission.element);
				mergeLocalizedStrings(remoteRequestEmission);
			}
			// The inline `<query>` sits in each entry's session (placed by
			// the datum projection); its title, description, and prompt
			// labels still need their app strings.
			const inlineSearch = inlineSearchFor(doc, linkContext, moduleUuid);
			if (inlineSearch !== undefined) mergeLocalizedStrings(inlineSearch);

			const shortEmission = buildShortDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
				...(caseSource !== undefined && { caseSource }),
				...(assets && { assets }),
				...(lookupNaming && { lookupNaming }),
				...(registerAction !== undefined && { registerAction }),
				emptyCaseListText,
				...(remoteRequestEmission !== undefined && {
					searchAction: {
						autoLaunch: remoteRequestEmission.wire.autoLaunch,
						...(searchButtonDisplayCondition !== undefined && {
							displayCondition: searchButtonDisplayCondition,
						}),
					},
				}),
			});
			rememberDetail(shortEmission);
			suiteDetails.push(shortEmission.element);
			mergeLocalizedStrings(shortEmission);

			const longEmission = buildLongDetail({
				module: mod,
				moduleIndex: mIdx,
				doc,
				...(caseSource !== undefined && { caseSource }),
				...(assets && { assets }),
				...(lookupNaming && { lookupNaming }),
			});
			rememberDetail(longEmission);
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
			// action's destination. A search-first module has no separate
			// results screen: its case details ARE the results.
			if (searchShort !== undefined && searchLong !== undefined) {
				rememberDetail(searchShort);
				rememberDetail(searchLong);
				suiteDetails.push(searchShort.element, searchLong.element);
				mergeLocalizedStrings(searchShort);
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
			// fidelity. The default is the one the expander reads,
			// `effectivePostSubmit`, from the form type and its module's shape.
			const form = doc.forms[formUuid];
			const formType = form.type;
			const postSubmit = effectivePostSubmit(doc, formUuid) ?? "app_home";
			const ownCaseDatum = selectedCaseSessionDatum(
				doc,
				linkContext,
				moduleUuid,
				formUuid,
			);
			const ownCaseDatumId = ownCaseDatum?.id;
			const formRelevant = emitFormDisplayConditionForSuite(
				form,
				requireExpressionContext(
					authoredDoc,
					{ entity: "form", uuid: formUuid, slot: "form_display_condition" },
					lookupNaming,
				),
				lookupNaming,
				ownCaseDatumId,
				entryDatumIdResolver(
					entryDatumIds(doc, linkContext, moduleUuid, formUuid),
				),
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
			// HQ's build writes every form's submit label, "Submit" where none
			// is set, which Nova never sets. Nova's own system copy, so every
			// language takes it verbatim.
			appStrings[formSubmitLabelLocaleId(mIdx, fIdx)] = FORM_SUBMIT_LABEL;

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
			// the assertion for a write the form never makes. A Connect app's
			// meta block captures the worker's location, as HQ's build does from
			// the `auto_gps_capture` `expandDoc` writes under the same condition,
			// and the form's data node carries the sequence as its version, as
			// HQ's build stamps its own form version (`FormBase.add_stuff_to_xform`).
			let xform = attachments[`${uniqueId}.xml`];
			if (xform) {
				xform = addCaseBlocks(
					xform,
					hqForm.actions,
					caseType || undefined,
					ownCaseDatumId === undefined
						? undefined
						: sessionDataRef(ownCaseDatumId),
					ownCaseDatum?.maxSelectValue === undefined,
				);
			}
			if (xform) {
				xform = setFormVersion(
					stripVellumAttributes(
						addMetaBlock(xform, {
							captureLocation: authoredDoc.connectType !== null,
						}),
					),
					sequence,
				);
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
			// Dependency declarations come from the exact rendered datum, stack,
			// command, and referenced detail trees. The independent suite oracle
			// checks their final XML scopes after the entry has been assembled.
			const projectedLinks = projectFormLinks(doc, linkContext, formUuid);
			const projectedSessionDatums = entrySessionDatums(
				doc,
				linkContext,
				moduleUuid,
				formUuid,
			);
			// The claim `<post>` of a search-first module's case-requiring
			// entry (`EntriesHelper.include_post_in_entry`): a picked case
			// the device does not hold yet is claimed before the form opens.
			// Under a selected parent every other case datum is offered too.
			const post =
				searchFirst && ownCaseDatumId !== undefined
					? buildInlineClaimPost({
							runtimeTarget: opts.runtimeTarget,
							sessionVar: ownCaseDatumId,
							collection: ownCaseDatum?.maxSelectValue !== undefined,
							...(parentSelectModuleUuid(doc, moduleUuid) !== undefined && {
								parentSelect: {
									otherSessionVars: projectedSessionDatums
										.filter(
											(datum) =>
												datum.query === undefined &&
												datum.id !== ownCaseDatumId &&
												!datum.id.startsWith("case_id_new_"),
										)
										.map((datum) => datum.id),
								},
							}),
						})
					: undefined;
			// The no-matches form's return frame: after submit, back to the
			// host's Results showing the case it registered. An explicit
			// `firstMenu` returns to the app's first menu instead.
			const returnFrame =
				synthetic === undefined || form.postSubmit === "firstMenu"
					? undefined
					: caseListFormReturnFrame(
							doc,
							linkContext,
							synthetic.hostModuleUuid,
							newCaseDatumId(projectedSessionDatums, synthetic.caseType),
							synthetic.caseType,
						);
			const commandInstances = new InstanceSink();
			const menuCommand = xel(
				"command",
				{
					attributes: { id: cmdId },
					xpath: formRelevant === undefined ? {} : { relevant: formRelevant },
				},
				{ mode: { target: "suite" }, instances: commandInstances },
			);
			const entryDef = deriveEntryDefinition({
				formXmlns: xmlns,
				moduleIndex: mIdx,
				formIndex: fIdx,
				formType,
				postSubmit,
				caseType: caseType || undefined,
				...(post !== undefined && { post }),
				...(returnFrame !== undefined && { returnFrame }),
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
				parentFrame:
					postSubmit === "parentMenu"
						? parentMenuDestinationFrameChildren(doc, linkContext, moduleUuid)
						: [],
				projectedSessionDatums,
				caseListFilter: mod.caseListConfig?.filter,
				additionalInstances: commandInstances.declarations(),
				actions: hqForm.actions,
				excludedOwnerIds,
				expressions,
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
					el("resource", { id: filePath, version: String(sequence) }, [
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
			suiteEntryDefinitions.push({
				definition: entryDef,
				commandDisplay: formNav.node,
			});
			menuCommands.push(menuCommand);
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
			const browseDatums = caseListSessionDatums(doc, linkContext, moduleUuid);
			const caseListEntryDef = deriveCaseListEntryDefinition(
				mIdx,
				caseType,
				mod.caseListConfig?.filter,
				(mod.caseListConfig?.columns ?? []).some(
					(column) => column.visibleInDetail !== false,
				),
				excludedOwnerIds,
				expressions,
				lookupNaming,
				persistentTileDetailId,
				browseDatums,
			);
			suiteEntryDefinitions.push({
				definition: caseListEntryDef,
				commandDisplay: caseListNav.node,
			});
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

		const moduleInstances = new InstanceSink();
		const moduleMenu = xel(
			"menu",
			{
				attributes: {
					...(moduleParent(doc, moduleUuid) !== null &&
					moduleParent(doc, moduleUuid) !== undefined
						? {
								root: `m${sortedModuleUuids.indexOf(moduleParent(doc, moduleUuid) as Uuid)}`,
							}
						: {}),
					id: `m${mIdx}`,
				},
				xpath: moduleRelevant === undefined ? {} : { relevant: moduleRelevant },
			},
			{ mode: { target: "suite" }, instances: moduleInstances },
			[moduleNav.node],
		);
		moduleMenu.children.push(
			...moduleInstances
				.declarations()
				.map((instance) =>
					el("instance", { id: instance.id, src: instance.src }),
				),
			...menuCommands,
		);
		suiteMenus.push(moduleMenu);
	}

	// A projected session can select a detail belonging to a later module.
	// Resolve dependencies after all details have actually been printed, while
	// retaining the module/form order in which the entries were derived.
	const suiteEntries = suiteEntryDefinitions.map(
		({ definition, commandDisplay }) => {
			const instances = new InstanceSink(definition.instances);
			instances.add(instancesForDatums(definition.session?.datums ?? []));
			return buildEntryElement(
				{ ...definition, instances: instances.declarations() },
				commandDisplay,
			);
		},
	);

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
			el("resource", { id: `app_strings_${dir}`, version: String(sequence) }, [
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
	const entryPointSuite = buildEntryPointSuite(doc, linkContext);
	const suiteRoot = el("suite", { version: String(archiveVersion) }, [
		...suiteResources,
		...localeResources,
		...suiteDetails,
		...suiteRemoteRequests,
		...entryPointSuite.remoteRequests,
		...suiteEntries,
		...suiteMenus,
		...suiteFixtures,
		...entryPointSuite.endpoints,
	]);
	// `serializeXml` does not emit XML declarations — the leading
	// `<?xml version="1.0"?>` literal is the only template string in the
	// suite-XML emission path. CCHQ's `Application.create_suite` adds
	// the same declaration on the regenerated suite, so the literal
	// stays byte-equivalent across both paths.
	const suiteXml = `<?xml version="1.0"?>\n${serializeXml(suiteRoot)}`;

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
	// references against. (The oracle's own namespace-aware XML 1.0 gate
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
 * Generate the top-level profile.ccpr XML, in this order:
 *
 * - `<profile>`: `uniqueid` is Nova's own id for the app on the target's
 *   project space (`profileUniqueId`), so every archive of one app for one
 *   project space is one app on a phone; `version` is the archive's
 *   version; `requiredMajor`, `requiredMinor` and `requiredMinimal` state
 *   the version floor, the oldest CommCare the content needs, in HQ's own
 *   spelling.
 * - `CommCare App Name`, then `cc-content-version` and `cc-app-version`,
 *   both the sequence.
 * - The four server properties (`profileServerProperties`), each forced,
 *   so a worker signs in, syncs and sends forms to the project space the
 *   archive is made for.
 * - `cur_locale`, the first language's wire code, unforced, as HQ writes
 *   it, so the app starts in its first language.
 * - The seventeen settings (`appProfileSettings.ts`), each with HQ's own
 *   `force`.
 * - The derived properties, each forced as HQ's custom-property template
 *   writes them, and the logo's web-apps banner where the app has a logo.
 * - `<features>`: `<checkoff active="true"/>`, as HQ's `profile.ccpr` has
 *   it, with which Android keeps a sent form as saved and offers the Saved
 *   button where `cc-show-saved` allows it; then `<users active="true"/>`.
 * - The suite and the media suite, each at the archive's version.
 *
 * Constructed via `domhandler` element tree + single `serializeXml`
 * pass. The `<?xml version="1.0"?>` declaration is prepended as a
 * literal (the serializer doesn't emit declarations). The `appName` flows
 * raw through the `name` attribute and the `CommCare App Name` property
 * value; the serializer XML-escapes both once at render time.
 */
function generateProfile(input: {
	readonly doc: BlueprintDoc;
	readonly appName: string;
	readonly runtimeTarget: RuntimeTarget;
	readonly firstLanguage: string | undefined;
	readonly sequence: number;
	readonly archiveVersion: number;
	readonly logoProperty?: Element;
	readonly derivedProperties: Readonly<Record<string, string>>;
}): string {
	const { appName, runtimeTarget } = input;
	const archiveVersion = String(input.archiveVersion);
	const profileEl = el(
		"profile",
		{
			xmlns: "http://cihi.commcarehq.org/jad",
			version: archiveVersion,
			uniqueid: profileUniqueId(input.doc.appId, runtimeTarget),
			requiredMajor: String(COMMCARE_VERSION_FLOOR.major),
			requiredMinor: String(COMMCARE_VERSION_FLOOR.minor),
			requiredMinimal: "0",
			name: appName,
			update: "http://localhost/update",
		},
		[
			el("property", { key: "CommCare App Name", value: appName }),
			el("property", {
				key: "cc-content-version",
				value: String(input.sequence),
			}),
			el("property", { key: "cc-app-version", value: String(input.sequence) }),
			...profileServerProperties(runtimeTarget).map(({ key, value }) =>
				el("property", { key, value, force: "true" }),
			),
			...(input.firstLanguage === undefined
				? []
				: [
						el("property", {
							key: "cur_locale",
							value: input.firstLanguage,
							force: "false",
						}),
					]),
			...appProfileProperties(input.doc).map(({ key, value, force }) =>
				el("property", { key, value, ...(force && { force: "true" }) }),
			),
			...Object.entries(input.derivedProperties).map(([key, value]) =>
				el("property", { key, value, force: "true" }),
			),
			...(input.logoProperty ? [input.logoProperty] : []),
			el("features", {}, [
				el("checkoff", { active: "true" }),
				el("users", { active: "true" }),
			]),
			el("suite", {}, [
				el(
					"resource",
					{
						id: "suite",
						version: archiveVersion,
						descriptor: "Suite Definition",
					},
					[el("location", { authority: "local" }, [text("./suite.xml")])],
				),
			]),
			el("suite", {}, [
				el(
					"resource",
					{
						id: "media-suite",
						version: archiveVersion,
						descriptor: "Media Suite Definition",
					},
					[el("location", { authority: "local" }, [text("./media_suite.xml")])],
				),
			]),
		],
	);
	return `<?xml version="1.0"?>\n${serializeXml(profileEl)}`;
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
