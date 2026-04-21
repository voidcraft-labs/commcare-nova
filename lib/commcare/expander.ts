/**
 * BlueprintDoc → HqApplication expansion.
 *
 * Single entry point from the domain shape to CommCare's HQ import JSON.
 * Consumed by the CCZ compiler (for .ccz packaging), the HQ upload proxy
 * (direct import), the JSON-export endpoint (download button), and the
 * agent's validation loop (post-expansion XForm validation).
 *
 * Walks `doc.moduleOrder` → `doc.modules[mUuid]`, then
 * `doc.formOrder[mUuid]` → `doc.forms[fUuid]`. Each form becomes an
 * `HqForm` with the correctly-derived `FormActions`, `case_references_data`,
 * and `post_form_workflow`; the matching XForm XML goes into
 * `_attachments`. The walk preserves order exactly — module 0 in the
 * doc is module 0 in the output, and HQ's positional form links stay
 * consistent.
 */

import type { HqApplication, HqFormLink } from "@/lib/commcare";
import {
	applicationShell,
	detailColumn,
	detailPair,
	formShell,
	moduleShell,
} from "@/lib/commcare";
import { genHexId, genShortId } from "@/lib/commcare/ids";
import { toHqWorkflow } from "@/lib/commcare/session";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	defaultPostSubmit,
	type FormLink,
	type Uuid,
} from "@/lib/domain";
import { buildCaseReferencesLoad, buildFormActions } from "./formActions";
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
 */
export function expandDoc(doc: BlueprintDoc): HqApplication {
	const attachments: Record<string, string> = {};

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

			// Only include Connect config in export when the app-level
			// `connectType` is set. The builder UI stashes per-form connect
			// configs across mode toggles; stripping them at emit time is
			// what preserves that stash without leaking into a mode-off
			// export.
			const effectiveConnect = doc.connectType ? form.connect : undefined;

			attachments[`${formUniqueId}.xml`] = buildXForm(doc, formUuid, {
				xmlns,
				...(effectiveConnect && { connect: effectiveConnect }),
			});

			// Resolve form-link uuids to the 0-based indices HQ expects.
			// Dangling targets are dropped (validator catches them with a
			// `FORM_LINK_TARGET_NOT_FOUND` before production runs get
			// here).
			const hqFormLinks = form.formLinks?.length
				? translateFormLinks(form.formLinks, doc.moduleOrder, doc.formOrder)
				: [];

			return formShell(
				formUniqueId,
				form.name,
				xmlns,
				CASE_LOADING_FORM_TYPES.has(form.type) ? "case" : "none",
				buildFormActions(doc, formUuid, caseType),
				buildCaseReferencesLoad(doc, formUuid, effectiveConnect ?? undefined),
				toHqWorkflow(form.postSubmit ?? defaultPostSubmit(form.type)),
				hqFormLinks,
			);
		});

		// Case detail columns: short (case list) + long (detail view).
		// When an explicit long column set is absent AND short columns
		// exist, the long view mirrors the short view — CommCare requires
		// at least one long column for modules with cases. Without any
		// short columns either, produce an empty detail pair.
		const shortColumns = (mod.caseListColumns ?? []).map((col) =>
			detailColumn(col.field, col.header),
		);
		const longColumns = mod.caseDetailColumns
			? mod.caseDetailColumns.map((col) => detailColumn(col.field, col.header))
			: mod.caseListColumns
				? shortColumns
				: undefined;
		const caseDetails = hasCases
			? detailPair(shortColumns, longColumns)
			: detailPair([]);

		const shell = moduleShell(
			moduleUniqueIds[mIdx],
			mod.name,
			caseType,
			forms,
			caseDetails,
		);

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

	return applicationShell(doc.appName, modules, attachments, {
		...(doc.connectType && { autoGpsCapture: true }),
	});
}
