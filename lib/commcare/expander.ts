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
import { genHexId, genShortId } from "@/lib/commcare/ids";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { buildMultimediaMap } from "@/lib/commcare/multimedia/bundle";
import { buildLogoRefs } from "@/lib/commcare/multimedia/logoEntry";
import { buildNavMediaDicts } from "@/lib/commcare/multimedia/navMenuMedia";
import { toHqWorkflow } from "@/lib/commcare/session";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	defaultPostSubmit,
	type FormLink,
	type Uuid,
} from "@/lib/domain";
import { buildConnectSlugMap } from "./connectSlugs";
import { buildCaseReferencesLoad, buildFormActions } from "./formActions";
import { projectCaseListForHq } from "./hqJson/caseList";
import { buildXForm } from "./xform/builder";

/**
 * Translate a domain form-link list into the HQ wire shape.
 *
 * Domain `FormLink.target` speaks uuids; HQ's JSON speaks 0-based
 * module/form indices. The expander is the one place that has both
 * pieces of information (it's walking `doc.moduleOrder` / `doc.formOrder`
 * to generate the output), so index resolution happens here rather than
 * being duplicated downstream. Links whose target uuid can't be resolved
 * (dangling references) are dropped silently — the validator catches
 * dangling targets with a specific error code before this runs in
 * production, and dropping in emit is safer than emitting an HQ JSON
 * that fails upload.
 */
function translateFormLinks(
	links: FormLink[],
	moduleOrder: Uuid[],
	formOrder: Record<Uuid, Uuid[]>,
): HqFormLink[] {
	const out: HqFormLink[] = [];
	for (const link of links) {
		const target = link.target;
		if (target.type === "form") {
			const moduleIndex = moduleOrder.indexOf(target.moduleUuid);
			if (moduleIndex < 0) continue;
			const formIndex = (formOrder[target.moduleUuid] ?? []).indexOf(
				target.formUuid,
			);
			if (formIndex < 0) continue;
			out.push({
				...(link.condition !== undefined && { condition: link.condition }),
				target: { type: "form", moduleIndex, formIndex },
				...(link.datums !== undefined && { datums: link.datums }),
			});
		} else {
			const moduleIndex = moduleOrder.indexOf(target.moduleUuid);
			if (moduleIndex < 0) continue;
			out.push({
				...(link.condition !== undefined && { condition: link.condition }),
				target: { type: "module", moduleIndex },
				...(link.datums !== undefined && { datums: link.datums }),
			});
		}
	}
	return out;
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
 * empty `media_image` / `media_audio` / `multimedia_map` / `logo_refs`.
 */
export interface ExpandOptions {
	assets?: AssetManifest;
}

export function expandDoc(
	doc: BlueprintDoc,
	opts: ExpandOptions = {},
): HqApplication {
	const attachments: Record<string, string> = {};
	const assets = opts.assets;

	// Child case type map: child_case_type → parent module index. Derived
	// from `case_types[].parent_type` + matching module case types. The
	// expander uses this to activate `parent_select` on the child
	// module so CommCare prompts for a parent case before creating the
	// child. Case list columns never affect this — they're presentation.
	const childCaseParents = new Map<string, number>();
	if (doc.caseTypes) {
		for (const ct of doc.caseTypes) {
			if (!ct.parent_type) continue;
			const parentIdx = doc.moduleOrder.findIndex(
				(mUuid) => doc.modules[mUuid].caseType === ct.parent_type,
			);
			if (parentIdx !== -1) childCaseParents.set(ct.name, parentIdx);
		}
	}

	// Pre-generate each module's HQ `unique_id` up front. `parent_select`
	// on a child module references its parent module's id, so building
	// every module in a single pass requires the id table before the
	// `.map()` runs. Generating here also keeps id allocation ordered
	// with `doc.moduleOrder` so reads into this array by `parentIdx` are
	// always consistent with the module we're currently emitting.
	const moduleUniqueIds = doc.moduleOrder.map(() => genHexId());

	// Resolve the per-form Connect configs for emission. `buildConnectSlugMap`
	// is a typed pass-through — connect ids are already valid + unique + ≤50
	// by construction (creation autofill + the UI/tool guards), so it asserts
	// each id is present and narrows the type without transforming. Both the XForm
	// builder and the case-references load map below read the same per-form
	// config so their data paths agree. Empty for non-Connect apps.
	const connectSlugs = buildConnectSlugMap(doc);

	const modules = doc.moduleOrder.map((moduleUuid, mIdx) => {
		const mod = doc.modules[moduleUuid];
		const formUuids = doc.formOrder[moduleUuid] ?? [];

		// A module "has cases" when it owns a case type AND either runs as
		// a case-list-only module (no forms) or carries at least one
		// non-survey form. Surveys are the only form type that never
		// touches case state.
		const hasCases =
			!!mod.caseType &&
			(mod.caseListOnly ||
				formUuids.some((fUuid) => doc.forms[fUuid].type !== "survey"));
		const caseType = hasCases ? (mod.caseType ?? "") : "";

		const forms = formUuids.map((formUuid) => {
			const form = doc.forms[formUuid];
			const formUniqueId = genHexId();
			const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`;

			// The resolved Connect config for this form, or `undefined` when
			// there's nothing to emit. The map already encodes the "only when
			// `connectType` is set" rule — off-mode the map is empty — so this
			// lookup also enforces the connect-mode stash: per-form configs
			// stashed across mode toggles never leak into a mode-off export.
			const effectiveConnect = connectSlugs.get(formUuid);

			attachments[`${formUniqueId}.xml`] = buildXForm(doc, formUuid, {
				xmlns,
				...(effectiveConnect && { connect: effectiveConnect }),
				...(assets && { assets }),
			});

			// Resolve form-link uuids to the 0-based indices HQ expects.
			// Dangling targets are dropped (validator catches them with a
			// `FORM_LINK_TARGET_NOT_FOUND` before production runs get
			// here).
			const hqFormLinks = form.formLinks?.length
				? translateFormLinks(form.formLinks, doc.moduleOrder, doc.formOrder)
				: [];

			const formShellObj = formShell(
				formUniqueId,
				form.name,
				xmlns,
				CASE_LOADING_FORM_TYPES.has(form.type) ? "case" : "none",
				buildFormActions(doc, formUuid, caseType),
				buildCaseReferencesLoad(doc, formUuid, effectiveConnect),
				toHqWorkflow(form.postSubmit ?? defaultPostSubmit(form.type)),
				hqFormLinks,
			);

			// Stamp the form's menu-command media (icon + audio label) onto
			// the shell. CCHQ reads these `media_image` / `media_audio` dicts
			// to regenerate the suite command's `<display>` on import.
			const formMedia = buildNavMediaDicts(
				form.icon,
				form.audioLabel,
				assets,
				"expandDoc form media",
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
		const projection = projectCaseListForHq(mod, doc, assets);
		const caseDetails = hasCases ? projection.caseDetails : detailPair([]);

		const shell = moduleShell(
			moduleUniqueIds[mIdx],
			mod.name,
			caseType,
			forms,
			caseDetails,
		);

		// Stamp the module's home-tile media (icon + audio label) and the
		// case-list link's media onto the shell + its `case_list` block.
		// CCHQ reads these dicts to regenerate the suite `<menu>` /
		// case-list-command `<display>` on import.
		const moduleMedia = buildNavMediaDicts(
			mod.icon,
			mod.audioLabel,
			assets,
			"expandDoc module media",
		);
		shell.media_image = moduleMedia.media_image;
		shell.media_audio = moduleMedia.media_audio;
		// `case_list.media_image` / `media_audio` are NOT stamped from
		// `mod.caseListConfig?.icon` / `audioLabel`. The schema reserves
		// those slots but no wire path emits them: Nova's compiler emits
		// no standalone case-list-link command in suite.xml, and the
		// HQ-bound JSON path emits media-free. Stamping a non-empty dict
		// here would also produce orphan bytes in the `.ccz` (the bytes
		// are not collected by `collectAssetRefs` either — see
		// `lib/domain/mediaRefs.ts`).

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
			shell.case_list.label = { en: mod.name };
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

	const app = applicationShell(doc.appName, modules, attachments, {
		...(doc.connectType && { autoGpsCapture: true }),
	});

	// Application-level media registry. `multimedia_map` declares every
	// referenced file (keyed by wire path) so CCHQ can reconcile the
	// step-2 multimedia upload by path; `logo_refs` carries the web-apps
	// banner. Both stay empty when media emission is off.
	app.multimedia_map = assets ? buildMultimediaMap(assets.values()) : {};
	app.logo_refs = buildLogoRefs(doc.logo, assets, "expandDoc logo");

	return app;
}
