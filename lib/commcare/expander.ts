import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
/**
 * BlueprintDoc → HqApplication expansion.
 *
 * Single entry point from the domain shape to CommCare's HQ import JSON.
 * The HQ JSON is the production export pathway: the upload route at
 * `app/api/commcare/upload/route.ts` POSTs the result of this function to
 * CCHQ's `/api/import_app/`, which wraps it as a CouchDB Application
 * document; the runtime suite.xml regenerates from that document on every
 * sync. The `.ccz` packaging (`./compiler::compileCcz`) consumes the same
 * shape to produce a downloadable on-device app; that archive does not flow
 * through the HQ import API.
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

import type { HqApplication } from "@/lib/commcare";
import {
	applicationShell,
	DERIVED_WIRE_IDENTITY,
	detailPair,
	formShell,
	moduleShell,
	type WireIdentity,
} from "@/lib/commcare";
import { addOnsNeededBy } from "@/lib/commcare/addOns";
import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import {
	moduleExpressionContexts,
	requireExpressionContext,
} from "@/lib/commcare/expressionContext";
import {
	type CommCareLocalization,
	commCareLocalization,
	repeatForLanguages,
} from "@/lib/commcare/localization";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildNavMediaDicts } from "@/lib/commcare/multimedia/navMenuMedia";
import { toHqWorkflow } from "@/lib/commcare/session";
import { hqCaseActions } from "@/lib/commcare/subcaseWire";
import { EMPTY_CASE_LIST_TEXT } from "@/lib/commcare/suite/case-list/detailTexts";
import {
	NEVER_RELEVANT,
	NO_MATCHES_RELEVANCY,
} from "@/lib/commcare/suite/case-search/noMatches";
import {
	emitFormDisplayConditionForHq,
	emitModuleDisplayCondition,
} from "@/lib/commcare/suite/displayConditions";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	effectivePostSubmit,
	makeTranslationUnitId,
	moduleParent,
	projectedModulePreorder,
	type Uuid,
} from "@/lib/domain";
import { buildConnectSlugMap } from "./connectSlugs";
import {
	caseListFormLabelUnit,
	emissionPlan,
	searchAnswersOf,
} from "./emissionPlan";
import {
	buildCaseReferencesLoad,
	buildPrimaryCaseUpdateMap,
} from "./formActions";
import {
	entryDatumIdResolver,
	entryDatumIds,
	formLinkProjectionContext,
	moduleCaseTypeForActions,
	type ProjectedFormLink,
	projectFormLinks,
	selectedCaseSessionDatum,
	sessionDataRef,
} from "./formLinkProjection";
import { emptyShortListColumns, projectCaseListForHq } from "./hqJson/caseList";
import {
	type HqFormLinkTree,
	hqXPath,
	serializeHqApplication,
} from "./hqJson/xpath";
import { buildXFormSource } from "./xform/builder";
import { formUpdatesSelectedCasesInSource } from "./xform/sourceCaseWrites";

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
): HqFormLinkTree {
	const target = link.target;
	const moduleId = moduleUniqueIdOf.get(target.moduleUuid);
	if (moduleId === undefined) {
		throw new Error(
			`Cannot emit form link: target module ${target.moduleUuid} is missing`,
		);
	}
	const datums = link.datums.map((datum) => ({
		name: datum.name,
		xpath: hqXPath(datum.xpath),
	}));
	const xpath = link.guard === undefined ? "" : hqXPath(link.guard);
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
 * Every menu's and form's HQ `unique_id` and every form's `xmlns` come from
 * `opts.identity` (`./wireIdentity.ts`): derived from the entity's UUID, or
 * a target's recorded override. They are stable across exports and are what
 * HQ stores, since an update writes the ids it is sent. Case types, case
 * details, case list columns, and `parent_select` wiring are derived from
 * module metadata + `doc.caseTypes`. Connect content and app mode must
 * agree at admission; the projection never hides dormant Connect
 * configuration.
 *
 * `opts.assets` is the resolved media manifest. When present, the
 * emitted XForms gain media itext values and the module/form/case-list
 * shells gain `media_image` / `media_audio` dicts: everything CCHQ needs
 * to regenerate a media-bearing suite once the media upload maps the
 * files. When absent, media emission is off (validation loop, asset-free
 * preview): the output is structurally identical to the with-manifest
 * shape but carries empty `media_image` / `media_audio`. No mode writes a
 * `multimedia_map`, which HQ's media upload writes, or a `logo_refs`: a
 * logo reaches an app built on CommCare HQ when a person adds it there.
 */
export interface ExpandOptions {
	readonly runtimeTarget?: RuntimeTarget;
	/**
	 * The ids every menu and form takes. Absent means the derivation; a
	 * publish to a target that holds other ids passes
	 * `targetWireIdentity(overrides)`.
	 */
	readonly identity?: WireIdentity;
	assets?: AssetManifest;
	/**
	 * Lookup wire naming from the validated definitions snapshot. Every export
	 * mode resolves the same identities; HQ modes also deliver the workbook.
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
	authoredDoc: BlueprintDoc,
	opts: ExpandOptions = {},
): HqApplication {
	// The wire's module sequence: authored modules with their menu forms,
	// then one hidden module per no-matches registration form
	// (`emissionPlan.ts`). Translation units are read off the authored
	// document, whose ownership they describe.
	const plan = emissionPlan(authoredDoc);
	const doc = plan.doc;
	const attachments: Record<string, string> = {};
	const assets = opts.assets;
	const localization = commCareLocalization(authoredDoc);
	const identity = opts.identity ?? DERIVED_WIRE_IDENTITY;

	// `moduleOrder` and each `formOrder` array are the canonical display
	// sequences. Every index this expander assigns (`mIdx`, menu/command order,
	// form-link target `m{i}-f{j}`) addresses those arrays; the compiler walks
	// the same sequences in lockstep.
	const sortedModuleUuids = projectedModulePreorder(doc);
	const sortedFormOrder: Record<string, Uuid[]> = {};
	for (const moduleUuid of sortedModuleUuids) {
		sortedFormOrder[moduleUuid] = orderedFormUuids(doc, moduleUuid);
	}

	// Each module's HQ `unique_id`, read from the identity up front.
	// `parent_select` and `root_module_id` on a child module reference
	// another module's id, so the table exists before the `.map()` runs.
	// The hidden module of a no-matches registration form is in this
	// sequence under its synthetic UUID, so its id follows its form's UUID.
	const moduleUniqueIds = sortedModuleUuids.map((moduleUuid) =>
		identity.moduleUniqueId(moduleUuid),
	);
	const moduleUniqueIdOf = new Map<Uuid, string>(
		sortedModuleUuids.map((moduleUuid, index) => [
			moduleUuid,
			moduleUniqueIds[index],
		]),
	);
	// Every form's HQ `unique_id` is read before the module map for the same
	// reason: a form link and a case list form name their target form by id,
	// and the target may sit in a later module. The ids come from the
	// identity, so they are stable across exports and are what HQ stores: an
	// update writes them as sent. HQ re-mints form ids only when it creates
	// an app from a body that holds forms, which a publish's create never
	// does; a manual import of the HQ import file is such a create, and HQ
	// rewrites `form_links[*].form_id` with the ids it mints there.
	const formUniqueIdOf = new Map<Uuid, string>();
	for (const moduleUuid of sortedModuleUuids) {
		for (const formUuid of sortedFormOrder[moduleUuid] ?? []) {
			formUniqueIdOf.set(formUuid, identity.formUniqueId(formUuid));
		}
	}

	// The after-submit link projection reads every form's actions, so the
	// context builds them once (cached) and the shells below consume the
	// same objects — the projection and the emitted `actions` cannot drift.
	const linkContext = formLinkProjectionContext(doc, {
		expressionDoc: authoredDoc,
		runtimeTarget: opts.runtimeTarget,
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
		const expressions = moduleExpressionContexts(
			doc,
			moduleUuid,
			opts.lookupNaming,
		);
		const formUuids = sortedFormOrder[moduleUuid] ?? [];
		const synthetic = plan.synthetic.get(moduleUuid);
		const noMatches = plan.noMatchesFormOf.get(moduleUuid);

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
			const xmlns = identity.formXmlns(form);

			// The admitted Connect config for this form. buildConnectSlugMap
			// checks mode/config agreement and preserves authored identities.
			const effectiveConnect = connectSlugs.get(formUuid);
			const ownCaseDatum = selectedCaseSessionDatum(
				doc,
				linkContext,
				moduleUuid,
				formUuid,
			);
			const ownCaseDatumId = ownCaseDatum?.id;
			const formActions = linkContext.formActions(formUuid);
			const multipleCaseDatum = formUpdatesSelectedCasesInSource(ownCaseDatum)
				? ownCaseDatum
				: undefined;
			const multiSelectPrimaryUpdate =
				multipleCaseDatum === undefined
					? {}
					: buildPrimaryCaseUpdateMap(
							doc,
							formUuid,
							mod.caseType,
							opts.attachmentTarget ?? null,
						);

			const source = buildXFormSource(doc, formUuid, {
				xmlns,
				expressionDoc: authoredDoc,
				datumId: entryDatumIdResolver(
					entryDatumIds(doc, linkContext, moduleUuid, formUuid),
				),
				// Raw `mod.caseType` (not the case-activity-gated `caseType`) so the
				// reachable-case-type depth map matches the deep validator's accept
				// map, which builds from `mod.caseType` directly.
				...(mod.caseType && { moduleCaseType: mod.caseType }),
				...(synthetic !== undefined && {
					searchAnswers: searchAnswersOf(authoredDoc, synthetic.hostModuleUuid),
				}),
				...(ownCaseDatumId !== undefined &&
					multipleCaseDatum === undefined && {
						selectedCaseIdRef: sessionDataRef(ownCaseDatumId),
					}),
				...(multipleCaseDatum !== undefined && {
					selectedCasesInstanceId: multipleCaseDatum.id,
					...(Object.keys(multiSelectPrimaryUpdate).length > 0 && {
						multiSelectPrimaryUpdate,
					}),
				}),
				ordinarySubcases: formActions.subcases,
				...(effectiveConnect && { connect: effectiveConnect }),
				...(assets && { assets }),
				...(opts.lookupNaming && { lookupNaming: opts.lookupNaming }),
				...(opts.attachmentTarget && {
					attachmentTarget: opts.attachmentTarget,
				}),
			});
			attachments[`${formUniqueId}.xml`] = source.xml;

			// After-submit navigation. With links, HQ reads `form_links` only
			// under `post_form_workflow = "form"`, and the authored
			// `postSubmit` becomes the FALLBACK workflow — emitted only when
			// the projection says a fallback frame is needed (the last link is
			// conditional); a terminal unconditional link is the exhaustive
			// else, and HQ's `_get_fallback_frame` is skipped with a `null`.
			// Without links, `postSubmit` is the workflow itself, as before.
			const workflow = toHqWorkflow(
				effectivePostSubmit(doc, formUuid) ?? "app_home",
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
				hqCaseActions(formActions),
				// Raw `mod.caseType` for the same reason as `buildXFormSource`'s
				// `moduleCaseType` above: the depth map must match the deep
				// validator's accept map.
				buildCaseReferencesLoad(doc, formUuid, effectiveConnect, mod.caseType),
				source.caseSaveReferences,
				projectedLinks === undefined ? workflow : "form",
				projectedLinks?.fallback.kind === "guarded" ? workflow : null,
				hqFormLinks,
			);
			formShellObj.session_endpoint_id = form.entryPoint?.id ?? "";
			formShellObj.respect_relevancy =
				form.entryPoint?.ignoreDisplayConditions !== true;
			const formFilter = emitFormDisplayConditionForHq(
				form,
				requireExpressionContext(
					authoredDoc,
					{ entity: "form", uuid: formUuid, slot: "form_display_condition" },
					opts.lookupNaming,
				),
				opts.lookupNaming,
				ownCaseDatumId,
			);
			formShellObj.form_filter =
				formFilter === undefined
					? null
					: hqXPath(
							formFilter,
							formShellObj.requires === "case" ? "case" : "no-case",
						);

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
		// shares authoring projection with the local suite. Native HQ/Core
		// proofs verify the resulting wire contracts independently.
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
		// A menu with no case list of its own (a survey menu, the hidden menu
		// of a no-matches form) still holds the one `name` column every new
		// menu gets in HQ, so its Case List page has a column to save from.
		const caseDetails = hasCases
			? projection.caseDetails
			: detailPair(emptyShortListColumns(localization.languages));
		// Every menu's empty-list text, in every app language: HQ's model
		// default holds `en` alone, and its module settings save writes the
		// page's language as an empty text, which reads blank in an app with
		// no English. Written on both pairs a menu can take, because the save
		// writes into a survey menu's short detail too.
		caseDetails.short.no_items_text = repeatForLanguages(
			localization.languages,
			EMPTY_CASE_LIST_TEXT,
		);

		// A menu uploads its own case type, a survey-only menu's included: HQ
		// builds nothing from it, and with it HQ's page offers the menu's
		// case list settings. `caseType` above, the gate, decides everything
		// built from the type. The hidden menu of a no-matches form holds its
		// host's type.
		const shell = moduleShell(
			moduleUniqueIds[mIdx],
			localization.textMap(
				synthetic === undefined
					? makeTranslationUnitId("module", moduleUuid, "name")
					: makeTranslationUnitId("form", synthetic.formUuid, "name"),
			),
			mod.caseType ?? "",
			forms,
			caseDetails,
			localization.languages,
		);
		shell.session_endpoint_id = mod.entryPoint?.id ?? "";
		shell.case_list_session_endpoint_id = mod.caseListEntryPoint?.id ?? "";
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
		// A hidden module is never on a menu (`menus.py::_generate_menu`
		// lowers the filter to `<menu relevant>`); the Register action reaches
		// it through a stack push, which ignores relevance.
		const moduleFilter =
			synthetic !== undefined
				? NEVER_RELEVANT
				: emitModuleDisplayCondition(
						mod,
						expressions({ slot: "module_display_condition" }),
						opts.lookupNaming,
					);
		shell.module_filter =
			moduleFilter === undefined ? null : hqXPath(moduleFilter, "no-case");

		if (noMatches !== undefined) {
			const formId = formUniqueIdOf.get(noMatches.formUuid);
			if (formId === undefined) {
				throw new Error(
					`Cannot emit case_list_form for module ${moduleUuid}: form ${noMatches.formUuid} has no unique id`,
				);
			}
			shell.case_list_form = {
				doc_type: "CaseListForm",
				form_id: formId,
				label: localization.textMap(
					caseListFormLabelUnit(authoredDoc, noMatches.formUuid),
				),
				post_form_workflow: "case_list",
				relevancy_expression: hqXPath(NO_MATCHES_RELEVANCY),
			};
		}

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

		if (mod.parentCaseModuleUuid !== undefined) {
			const parentId = moduleUniqueIdOf.get(mod.parentCaseModuleUuid);
			if (parentId === undefined)
				throw new Error(`Missing parent selector for module ${moduleUuid}.`);
			shell.parent_select = {
				active: true,
				relationship: "parent",
				module_id: parentId,
			};
		}

		return shell;
	});

	const derivedProfile = derivedProfileProperties(doc);
	const serialized = serializeHqApplication(
		applicationShell(doc.appName, modules, attachments, {
			...appLevelValues(doc, localization),
			profileProperties: appProfileProperties(authoredDoc),
			...(Object.keys(derivedProfile).length > 0 && {
				profileCustomProperties: derivedProfile,
			}),
		}),
	);
	const addOns = addOnsNeededBy(serialized);
	const {
		modules: printedModules,
		_attachments: printedAttachments,
		...app
	} = serialized;
	return {
		...app,
		...(addOns.length === 0
			? {}
			: { add_ons: Object.fromEntries(addOns.map((slug) => [slug, true])) }),
		modules: printedModules,
		_attachments: printedAttachments,
	};
}

/**
 * The app-level values `expandDoc` and `expandAppShell` both write: the
 * languages, each language's strings, and GPS capture for a Connect app.
 * One helper feeds both, so the shell and the update a first publish sends
 * never disagree on them.
 *
 * A language's strings are its language names, and `app.display.name` and
 * `homescreen.title` only where that language localizes the app's name:
 * HQ's build writes both at the app's name for a language that stores
 * neither, so writing them there changes no built string and leaves none
 * stale after a rename. Every other key of HQ's `translations` is the
 * target's (`appStringKeys.ts`), and the update carries it from HQ's read.
 */
function appLevelValues(
	doc: BlueprintDoc,
	localization: CommCareLocalization,
): {
	readonly autoGpsCapture?: boolean;
	readonly langs: string[];
	readonly translations: Record<string, Record<string, string>>;
} {
	const appNameByLanguage = localization.textMap(
		makeTranslationUnitId("app", "name"),
	);
	return {
		...(doc.connectType && { autoGpsCapture: true }),
		langs: [...localization.languages],
		translations: Object.fromEntries(
			localization.languages.map((language) => {
				const appName = appNameByLanguage[language];
				return [
					language,
					{
						...(appName !== undefined &&
							appName !== doc.appName && {
								"homescreen.title": appName,
								"app.display.name": appName,
							}),
						...Object.fromEntries(
							localization.languages.map((code) => [
								code,
								localization.languageName(code),
							]),
						),
					},
				];
			}),
		),
	};
}

/**
 * The keys of the empty app a first publish creates, in the order the body
 * writes them. The list is its own, and does not follow what
 * `applicationShell` writes: the shell is the one body that meets no source
 * read and no overlay, and the create baseline's ownership and the capture
 * peer's assumed source are both stated over these exact keys, so a key
 * reaches the shell only where this list names it.
 */
export const APP_SHELL_KEYS = [
	"doc_type",
	"application_version",
	"name",
	"langs",
	"translations",
	"auto_gps_capture",
	"modules",
	"_attachments",
] as const satisfies readonly (keyof HqApplication)[];

export type AppShellKey = (typeof APP_SHELL_KEYS)[number];

/** The body of the empty app a first publish creates. */
export type HqAppShell = Pick<HqApplication, AppShellKey>;

/**
 * The empty app a first publish creates before the ordinary in-place update
 * fills it: no menus, no attachments, no `add_ons`, no `profile` and no
 * `location_fixture_restore`, which the update writes over the shell's
 * source read, and no `build_spec`, `logo_refs` or `multimedia_map`, which
 * Nova never sends. `auto_gps_capture` is there only
 * for a Connect app. With no form there is
 * no form id for HQ to re-mint, and HQ refuses to build an app with no menus
 * (`helpers/validators.py::ApplicationValidator._check_modules`), so no
 * build can hold an id the update did not write.
 */
export function expandAppShell(doc: BlueprintDoc): HqAppShell {
	const app = serializeHqApplication(
		applicationShell(
			doc.appName,
			[],
			{},
			appLevelValues(doc, commCareLocalization(doc)),
		),
	);
	const shell: Partial<Record<AppShellKey, unknown>> = {};
	for (const key of APP_SHELL_KEYS) {
		if (Object.hasOwn(app, key)) shell[key] = app[key];
	}
	return shell as HqAppShell;
}
