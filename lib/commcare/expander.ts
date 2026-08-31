/**
 * BlueprintDoc → HqApplication expansion.
 *
 * Single entry point from the domain shape to CommCare's HQ import JSON.
 * The HQ JSON is the production export pathway: the upload route at
 * `app/api/commcare/upload/route.ts` POSTs the result of this function to
 * CCHQ's `/api/import_app/`, which wraps it as a CouchDB Application
 * document; the runtime suite.xml regenerates from that document on every
 * sync. The `.ccz` packaging (`./compiler::compileCcz`) consumes the same
 * shape but only for local diagnostics — it does not flow to CCHQ.
 *
 * Walks `doc.moduleOrder` → `doc.modules[mUuid]`, then
 * `doc.formOrder[mUuid]` → `doc.forms[fUuid]`. Each form becomes an
 * `HqForm` with the correctly-derived `FormActions`, `case_references_data`,
 * and `post_form_workflow`; the matching XForm XML goes into
 * `_attachments`. The walk preserves order exactly — module 0 in the
 * doc is module 0 in the output, and HQ's positional form links stay
 * consistent.
 *
 * Case-list HQ JSON projection (columns, sort, filter, search config) is
 * delegated to `./hqJson/caseList::projectCaseListForHq`. Both the suite-
 * XML emitter and the HQ JSON projection feed CCHQ the same authored
 * content via the same shared emitters — keeping the two surfaces in
 * lockstep keeps "Upload to CCHQ" honest against the running app.
 */

import type { HqApplication, HqFormLink } from "@/lib/commcare";
import {
	applicationShell,
	detailPair,
	formShell,
	moduleShell,
} from "@/lib/commcare";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { genHexId, genShortId } from "@/lib/commcare/ids";
import { commCareLocalization } from "@/lib/commcare/localization";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMultimediaMap } from "@/lib/commcare/multimedia/bundle";
import { buildLogoRefs } from "@/lib/commcare/multimedia/logoEntry";
import { buildNavMediaDicts } from "@/lib/commcare/multimedia/navMenuMedia";
import { toHqWorkflow } from "@/lib/commcare/session";
import {
	emitFormDisplayConditionForHq,
	emitModuleDisplayCondition,
} from "@/lib/commcare/suite/displayConditions";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	defaultPostSubmit,
	makeTranslationUnitId,
	moduleParent,
	projectedModulePreorder,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/predicate";
import { buildConnectSlugMap } from "./connectSlugs";
import { buildCaseReferencesLoad } from "./formActions";
import {
	formLinkProjectionContext,
	moduleCaseTypeForActions,
	type ProjectedFormLink,
	projectFormLinks,
	selectedCaseSessionDatum,
} from "./formLinkProjection";
import { projectCaseListForHq } from "./hqJson/caseList";
import { buildXForm } from "./xform/builder";

/**
 * One projected link in HQ's `FormLink` shape. `xpath` carries the
 * exclusive guard the local suite emits (the empty string is HQ's
 * "unconditional"); a form target names the form AND its module because
 * HQ's `workflow.py::_get_link_frame` resolves `form_module_id` first; a
 * module target names the module alone. A dangling target is an invariant
 * violation and aborts projection — silently dropping authored navigation
 * would turn a bad Blueprint into a different app.
 */
function toHqFormLink(
	link: ProjectedFormLink,
	moduleUniqueIdOf: ReadonlyMap<Uuid, string>,
	formUniqueIdOf: ReadonlyMap<Uuid, string>,
): HqFormLink {
	const target = link.target;
	const moduleId = moduleUniqueIdOf.get(target.moduleUuid);
	if (moduleId === undefined) {
		throw new Error(
			`Cannot emit form link: target module ${target.moduleUuid} is missing`,
		);
	}
	const datums = link.datums.map((datum) => ({
		name: datum.name,
		xpath: datum.xpath,
	}));
	const xpath = link.guard ?? "";
	if (target.type === "form") {
		const formId = formUniqueIdOf.get(target.formUuid);
		if (formId === undefined) {
			throw new Error(
				`Cannot emit form link: target form ${target.formUuid} is missing from module ${target.moduleUuid}`,
			);
		}
		return { xpath, form_id: formId, form_module_id: moduleId, datums };
	}
	return { xpath, module_unique_id: moduleId, datums };
}

/**
 * Expand a `BlueprintDoc` into an `HqApplication`.
 *
 * Every form gets a fresh HQ unique_id (hex) and xmlns (formdesigner
 * URI) generated on the fly; case types, case details, case list
 * columns, and `parent_select` wiring are derived from module metadata
 * + `doc.caseTypes`. Connect config is stripped from each form unless
 * the app-level `connectType` is set — preserves the "connect mode
 * stash" semantics the SA relies on.
 *
 * `opts.assets` is the resolved media manifest. When present, the
 * emitted XForms gain media itext values, the module/form/case-list
 * shells gain `media_image` / `media_audio` dicts, and the application
 * gains its `multimedia_map` + `logo_refs` — everything CCHQ needs to
 * regenerate a media-bearing suite on import. When absent, media
 * emission is off (validation loop, asset-free preview): the output
 * is structurally identical to the with-manifest shape but carries
 * empty `media_image` / `media_audio` / `multimedia_map` and no
 * `logo_refs` (absent, not empty — see the assignment below).
 */
export interface ExpandOptions {
	assets?: AssetManifest;
	/**
	 * Lookup wire naming from the validated definitions snapshot. Present
	 * only on the local-CCZ path — HQ JSON rejects lookup carriers at the
	 * export boundary before expansion, so its expansion never needs it.
	 */
	lookupNaming?: LookupWireNaming;
	/**
	 * The CommCare HQ origin and project space a capture's case-bound URL
	 * resolves against, when the caller has resolved one.
	 *
	 * `null` and absent both mean no target is known, so a URL-mode capture
	 * emits its question and nothing else — no address node, no bind, and no
	 * case update. The caller reports that at export time rather than writing
	 * an address that resolves nowhere.
	 *
	 * `null` is admitted, not just `undefined`, because every caller reads
	 * this off `PreparedExportBoundary`, where "no honest target" IS `null`.
	 * Requiring each of them to spread the value away conditionally is how a
	 * caller silently forgets to forward it at all, and a forgotten target
	 * drops a case write from a valid app with nothing to show for it.
	 */
	attachmentTarget?: AttachmentUrlTarget | null;
}

export function expandDoc(
	doc: BlueprintDoc,
	opts: ExpandOptions = {},
): HqApplication {
	const attachments: Record<string, string> = {};
	const assets = opts.assets;
	const userPropertySlugs = userPropertySlugsByUuid(doc);
	const localization = commCareLocalization(doc);

	// Child case type map: child_case_type → parent module index. Derived
	// from `case_types[].parent_type` + matching module case types. The
	// expander uses this to activate `parent_select` on the child
	// module so CommCare prompts for a parent case before creating the
	// child. Case list columns never affect this — they're presentation.
	// `moduleOrder` and each `formOrder` array are the canonical display
	// sequences. Every index this expander assigns (`mIdx`, menu/command order,
	// form-link target `m{i}-f{j}`) addresses those arrays; the compiler walks
	// the same sequences in lockstep.
	const sortedModuleUuids = projectedModulePreorder(doc);
	const sortedFormOrder: Record<string, Uuid[]> = {};
	for (const moduleUuid of sortedModuleUuids) {
		sortedFormOrder[moduleUuid] = orderedFormUuids(doc, moduleUuid);
	}

	const childCaseParents = new Map<string, number>();
	if (doc.caseTypes) {
		for (const ct of doc.caseTypes) {
			if (!ct.parent_type) continue;
			const parentIdx = sortedModuleUuids.findIndex(
				(mUuid) => moduleCaseTypeForActions(doc, mUuid) === ct.parent_type,
			);
			if (parentIdx !== -1) childCaseParents.set(ct.name, parentIdx);
		}
	}

	// Pre-generate each module's HQ `unique_id` up front. `parent_select`
	// on a child module references its parent module's id, so building
	// every module in a single pass requires the id table before the
	// `.map()` runs. Generating here also keeps id allocation ordered
	// with the sorted module sequence so reads into this array by `parentIdx`
	// are always consistent with the module we're currently emitting.
	const moduleUniqueIds = sortedModuleUuids.map(() => genHexId());
	const moduleUniqueIdOf = new Map<Uuid, string>(
		sortedModuleUuids.map((moduleUuid, index) => [
			moduleUuid,
			moduleUniqueIds[index],
		]),
	);
	// Every form's HQ `unique_id` is allocated before the module map for the
	// same reason: a form link names its target form by id, and the target
	// may sit in a later module. HQ re-ids forms on import
	// (`Application.scrub_source` → `update_form_unique_ids`) and rewrites
	// `form_links[*].form_id` with them, so the one requirement is that the
	// ids be consistent inside this document.
	const formUniqueIdOf = new Map<Uuid, string>();
	for (const moduleUuid of sortedModuleUuids) {
		for (const formUuid of sortedFormOrder[moduleUuid] ?? []) {
			formUniqueIdOf.set(formUuid, genHexId());
		}
	}

	// The after-submit link projection reads every form's actions, so the
	// context builds them once (cached) and the shells below consume the
	// same objects — the projection and the emitted `actions` cannot drift.
	const linkContext = formLinkProjectionContext(doc, {
		attachmentTarget: opts.attachmentTarget ?? null,
		...(opts.lookupNaming && { lookupNaming: opts.lookupNaming }),
	});

	// Resolve the per-form Connect configs for emission. `buildConnectSlugMap`
	// is a typed pass-through — connect ids are already valid + unique + ≤50
	// by construction (creation autofill + the UI/tool guards), so it asserts
	// each id is present and narrows the type without transforming. Both the XForm
	// builder and the case-references load map below read the same per-form
	// config so their data paths agree. Empty for non-Connect apps.
	const connectSlugs = buildConnectSlugMap(doc);

	const modules = sortedModuleUuids.map((moduleUuid, mIdx) => {
		const mod = doc.modules[moduleUuid];
		const formUuids = sortedFormOrder[moduleUuid] ?? [];

		// A module "has cases" when it owns a case type AND either runs as
		// a case-list-only module (no forms) or carries at least one
		// non-survey form. Surveys are the only form type that never
		// touches case state. `moduleCaseTypeForActions` is that rule's one
		// home; the link projection gates the same way.
		const caseType = moduleCaseTypeForActions(doc, moduleUuid);
		const hasCases = caseType !== "";

		const forms = formUuids.map((formUuid) => {
			const form = doc.forms[formUuid];
			const formUniqueId = formUniqueIdOf.get(formUuid);
			if (formUniqueId === undefined) {
				throw new Error(`Cannot emit form ${formUuid}: no unique id allocated`);
			}
			const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`;

			// The resolved Connect config for this form, or `undefined` when
			// there's nothing to emit. The map already encodes the "only when
			// `connectType` is set" rule — off-mode the map is empty — so this
			// lookup also enforces the connect-mode stash: per-form configs
			// stashed across mode toggles never leak into a mode-off export.
			const effectiveConnect = connectSlugs.get(formUuid);
			const ownCaseDatum = selectedCaseSessionDatum(
				doc,
				linkContext,
				moduleUuid,
				formUuid,
			);
			const ownCaseDatumId = ownCaseDatum?.id;
			const formActions = linkContext.formActions(formUuid);

			attachments[`${formUniqueId}.xml`] = buildXForm(doc, formUuid, {
				xmlns,
				// Raw `mod.caseType` (not the case-activity-gated `caseType`) so the
				// reachable-case-type depth map matches the deep validator's accept
				// map, which builds from `mod.caseType` directly.
				...(mod.caseType && { moduleCaseType: mod.caseType }),
				...(ownCaseDatumId !== undefined &&
					ownCaseDatum?.maxSelectValue === undefined && {
						selectedCaseIdRef: `instance('commcaresession')/session/data/${ownCaseDatumId}`,
					}),
				...(ownCaseDatumId !== undefined &&
					ownCaseDatum?.maxSelectValue !== undefined && {
						selectedCasesInstanceId: ownCaseDatumId,
						...(form.type === "close" && {
							multiSelectCloseCondition: formActions.close_case.condition,
						}),
						...(formActions.subcases.length > 0 && {
							multiSelectSubcases: formActions.subcases,
						}),
					}),
				...(effectiveConnect && { connect: effectiveConnect }),
				...(assets && { assets }),
				...(opts.lookupNaming && { lookupNaming: opts.lookupNaming }),
				...(opts.attachmentTarget && {
					attachmentTarget: opts.attachmentTarget,
				}),
			});

			// After-submit navigation. With links, HQ reads `form_links` only
			// under `post_form_workflow = "form"`, and the authored
			// `postSubmit` becomes the FALLBACK workflow — emitted only when
			// the projection says a fallback frame is needed (the last link is
			// conditional); a terminal unconditional link is the exhaustive
			// else, and HQ's `_get_fallback_frame` is skipped with a `null`.
			// Without links, `postSubmit` is the workflow itself, as before.
			const workflow = toHqWorkflow(
				form.postSubmit ?? defaultPostSubmit(form.type),
			);
			const projectedLinks = projectFormLinks(doc, linkContext, formUuid);
			const hqFormLinks =
				projectedLinks === undefined
					? []
					: projectedLinks.links.map((link) =>
							toHqFormLink(link, moduleUniqueIdOf, formUniqueIdOf),
						);

			const formShellObj = formShell(
				formUniqueId,
				localization.textMap(makeTranslationUnitId("form", formUuid, "name")),
				xmlns,
				CASE_LOADING_FORM_TYPES.has(form.type) ? "case" : "none",
				formActions,
				// Raw `mod.caseType` for the same reason as `buildXForm`'s
				// `moduleCaseType` above: the depth map must match the deep
				// validator's accept map.
				buildCaseReferencesLoad(doc, formUuid, effectiveConnect, mod.caseType),
				projectedLinks === undefined ? workflow : "form",
				projectedLinks?.fallback.kind === "guarded" ? workflow : null,
				hqFormLinks,
			);
			formShellObj.form_filter =
				emitFormDisplayConditionForHq(
					form.displayCondition,
					mod.caseType,
					opts.lookupNaming,
					userPropertySlugs,
				) ?? null;

			// Stamp the form's menu-command media (icon + audio label) onto
			// the shell. CCHQ reads these `media_image` / `media_audio` dicts
			// to regenerate the suite command's `<display>` on import.
			const formMedia = buildNavMediaDicts(
				form.icon,
				form.audioLabel,
				assets,
				"expandDoc form media",
				localization.languages,
			);
			formShellObj.media_image = formMedia.media_image;
			formShellObj.media_audio = formMedia.media_audio;
			return formShellObj;
		});

		// Case-list HQ JSON projection: columns (with per-kind format
		// dispatch + per-surface visibility), sort directives, the
		// always-on filter, and the `search_config` document
		// (search-screen chrome + per-input prompts + AND-composed
		// `_xpath_query`). The shared projection in `./hqJson/caseList`
		// keeps drift between the suite-XML and HQ-JSON paths
		// structurally impossible: both consume the same emitters.
		//
		// `hasCases` controls only WHETHER the projected case detail
		// lands — survey-only modules and modules with no case type
		// fall back to the empty-detail pair; their `search_config`
		// stays at the shell defaults regardless of authored content.
		const projection = projectCaseListForHq(
			mod,
			doc,
			assets,
			opts.lookupNaming,
		);
		const caseDetails = hasCases ? projection.caseDetails : detailPair([]);

		const shell = moduleShell(
			moduleUniqueIds[mIdx],
			localization.textMap(makeTranslationUnitId("module", moduleUuid, "name")),
			caseType,
			forms,
			caseDetails,
		);
		const rootModuleUuid = moduleParent(doc, moduleUuid);
		if (rootModuleUuid !== undefined && rootModuleUuid !== null) {
			const rootModuleId = moduleUniqueIdOf.get(rootModuleUuid);
			if (rootModuleId === undefined) {
				throw new Error(
					`Cannot emit child module ${moduleUuid}: root module ${rootModuleUuid} is missing`,
				);
			}
			shell.root_module_id = rootModuleId;
		}
		shell.module_filter =
			emitModuleDisplayCondition(
				mod.displayCondition,
				mod.caseType,
				opts.lookupNaming,
				userPropertySlugs,
			) ?? null;

		// Stamp the module's home-tile media (icon + audio label) and the
		// case-list link's media onto the shell + its `case_list` block.
		// CCHQ reads these dicts to regenerate the suite `<menu>` /
		// case-list-command `<display>` on import.
		const moduleMedia = buildNavMediaDicts(
			mod.icon,
			mod.audioLabel,
			assets,
			"expandDoc module media",
			localization.languages,
		);
		shell.media_image = moduleMedia.media_image;
		shell.media_audio = moduleMedia.media_audio;
		// `case_list.media_image` / `media_audio` are stamped below, inside
		// the `caseListOnly` block — that's the only shape where CCHQ emits
		// a case-list menu command for the icon to land on.

		// Overlay the projected `search_config` onto the shell. The
		// shell carries CCHQ defaults; the projection brings authored
		// chrome + inputs + AND-composed `_xpath_query`. Modules
		// without a case type collapse to the shell defaults
		// (`hasCases === false` blocks the case-detail projection, but
		// CCHQ's `CaseSearch` schema accepts the shell's defaults on
		// any module).
		if (hasCases) {
			shell.search_config = projection.searchConfig;
		}

		// `case_list_only` modules need `case_list.show = true` so HQ
		// doesn't reject them with "no forms or case list" — CommCare
		// requires either forms or a visible case list per module.
		if (mod.caseListOnly) {
			shell.case_list.show = true;
			shell.case_list.label = localization.textMap(
				makeTranslationUnitId("module", moduleUuid, "name"),
			);
			// Case-list-link menu media — same dict shape as the module
			// home-tile media above. CCHQ renders it on the case-list
			// command that `case_list.show = true` produces, and the local
			// `.ccz` compiler reads the same shell, so both artifacts agree.
			// Empty dicts on the media-OFF path (`assets` undefined), so
			// byte-free output is unchanged.
			const caseListMedia = buildNavMediaDicts(
				mod.caseListConfig?.icon,
				mod.caseListConfig?.audioLabel,
				assets,
				"expandDoc case-list media",
				localization.languages,
			);
			shell.case_list.media_image = caseListMedia.media_image;
			shell.case_list.media_audio = caseListMedia.media_audio;
		}

		// Activate `parent_select` when this module's case type appears
		// as a child elsewhere — CommCare walks up to the parent module
		// to prompt for a parent case before creating/editing the child.
		// Reading the parent's id from `moduleUniqueIds` (not from a
		// sibling `modules[parentIdx]` entry that might not exist yet in
		// the mid-map state) keeps this a single-pass derivation.
		if (mod.caseType) {
			const parentIdx = childCaseParents.get(mod.caseType);
			if (parentIdx !== undefined && parentIdx !== mIdx) {
				shell.parent_select = {
					active: true,
					relationship: "parent",
					module_id: moduleUniqueIds[parentIdx],
				};
			}
		}

		return shell;
	});

	const appNameUnit = makeTranslationUnitId("app", "name");
	const appNameByLanguage = localization.textMap(appNameUnit);
	const derivedProfile = derivedProfileProperties(doc);
	const app = applicationShell(doc.appName, modules, attachments, {
		...(doc.connectType && { autoGpsCapture: true }),
		...(Object.keys(derivedProfile).length > 0 && {
			profileCustomProperties: derivedProfile,
		}),
		langs: [...localization.languages],
		translations: Object.fromEntries(
			localization.languages.map((language) => [
				language,
				{
					"homescreen.title": appNameByLanguage[language],
					"app.display.name": appNameByLanguage[language],
					...Object.fromEntries(
						localization.languages.map((code) => [
							code,
							localization.languageName(code),
						]),
					),
				},
			]),
		),
	});

	// Application-level media registry. `multimedia_map` declares every
	// referenced file (keyed by wire path) so CCHQ can reconcile the
	// step-2 multimedia upload by path; it stays empty when media emission
	// is off. `logo_refs` (the web-apps banner) is assigned only when the
	// app actually has a Nova-authored logo: CCHQ's in-place update is an
	// overlay merge, so an emitted empty dict would remove a logo uploaded
	// on CommCare HQ, while an absent field is retained.
	app.multimedia_map = assets ? buildMultimediaMap(assets.values()) : {};
	const logoRefs = buildLogoRefs(doc.logo, assets, "expandDoc logo");
	if (Object.keys(logoRefs).length > 0) app.logo_refs = logoRefs;

	/* Same conditional-assignment rule as `logo_refs`, for the same
	 * reason: only an app that actually reads `instance('locations')`
	 * gets an opinion, so a republish never overwrites a fixture choice
	 * somebody made on CommCare HQ for an app that has no place rule. */
	if (readsLocationsFixture(doc)) {
		app.location_fixture_restore = "both_fixtures";
	}

	return app;
}

/**
 * Whether this app's wire reads `jr://fixture/locations`.
 *
 * Exactly one term does: `owner-location-at-level`, which
 * `predicate/termEmitter.ts::emitTerm` lowers to an
 * `instance('locations')` path, and which
 * `predicate/instances.ts::collectAstInstances` is the accumulator for.
 * `fixed-location` reads no instance — it prints a literal — so an app
 * whose only place rule is that one needs nothing from the restore.
 *
 * Read off the owner slots directly rather than off the instance
 * accumulator because this runs on the whole document at shell-assembly
 * time, before any per-expression emission context exists.
 */
function readsLocationsFixture(doc: BlueprintDoc): boolean {
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			if (operation.owner === undefined) continue;
			let found = false;
			walkExpressionTerms(operation.owner, (term) => {
				if (term.kind === "owner-location-at-level") found = true;
			});
			if (found) return true;
		}
	}
	return false;
}
