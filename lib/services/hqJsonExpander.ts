import { NameTest, parser } from "@/lib/commcare/xpath";
import { defaultPostSubmit } from "@/lib/domain";
import type { AppBlueprint } from "../doc/legacyTypes";
import type { HqApplication } from "./commcare";
import {
	applicationShell,
	detailColumn,
	detailPair,
	formShell,
	genHexId,
	genShortId,
	moduleShell,
} from "./commcare";
import { toHqWorkflow } from "./commcare/session";
import { buildCaseReferencesLoad, buildFormActions } from "./formActions";
import { buildXForm } from "./xformBuilder";

/**
 * Detect unquoted string literals in XPath expressions using the Lezer parser.
 * A bare word like "no" parses as a single NameTest — almost always an error
 * where the author forgot to quote a string literal.
 */
export function detectUnquotedStringLiteral(expr: string): string | null {
	const trimmed = expr.trim();
	if (!trimmed) return null;

	const tree = parser.parse(trimmed);
	const top = tree.topNode;
	const child = top.firstChild;
	if (!child || child.nextSibling) return null;
	if (child.type.id !== NameTest) return null;

	// Verify no error nodes
	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	if (hasError) return null;

	return trimmed;
}

/**
 * Expand an AppBlueprint into the full HQ import JSON.
 *
 * Generates all boilerplate that CommCare HQ expects: doc_types, unique_ids,
 * xmlns, XForm XML with itext/binds/body, form actions, case details, etc.
 * The output can be imported directly into HQ or compiled into a .ccz.
 */
export function expandBlueprint(blueprint: AppBlueprint): HqApplication {
	const attachments: Record<string, string> = {};

	// Build child case type map: child_case_type → parent module index
	// Derived from case_types[].parent_type — no form-level child_cases needed.
	const childCaseParents = new Map<string, number>();
	if (blueprint.case_types) {
		for (const ct of blueprint.case_types) {
			if (ct.parent_type) {
				const parentIdx = blueprint.modules.findIndex(
					(m) => m.case_type === ct.parent_type,
				);
				if (parentIdx !== -1) childCaseParents.set(ct.name, parentIdx);
			}
		}
	}

	const modules = blueprint.modules.map((bm) => {
		const hasCases =
			bm.case_type &&
			(bm.case_list_only || bm.forms.some((f) => f.type !== "survey"));
		const caseType = hasCases ? (bm.case_type ?? "") : "";

		const forms = bm.forms.map((bf) => {
			const formUniqueId = genHexId();
			const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`;

			// Only include Connect config in export when app-level connect_type is set
			const effectiveConnect = blueprint.connect_type ? bf.connect : undefined;
			const exportForm =
				effectiveConnect === bf.connect
					? bf
					: { ...bf, connect: effectiveConnect };

			attachments[`${formUniqueId}.xml`] = buildXForm(exportForm, xmlns);

			return formShell(
				formUniqueId,
				bf.name,
				xmlns,
				bf.type === "followup" || bf.type === "close" ? "case" : "none",
				buildFormActions(bf, caseType, blueprint.case_types),
				buildCaseReferencesLoad(bf.questions || [], effectiveConnect),
				toHqWorkflow(bf.post_submit ?? defaultPostSubmit(bf.type)),
			);
		});

		const shortColumns = (bm.case_list_columns || []).map((col) =>
			detailColumn(col.field, col.header),
		);
		const longColumns = bm.case_detail_columns
			? bm.case_detail_columns.map((col) => detailColumn(col.field, col.header))
			: bm.case_list_columns
				? shortColumns // mirror short columns when no explicit long columns
				: undefined;
		const caseDetails = hasCases
			? detailPair(shortColumns, longColumns)
			: detailPair([]);

		return moduleShell(genHexId(), bm.name, caseType, forms, caseDetails);
	});

	// case_list_only modules need case_list.show so HQ doesn't reject them
	// with "no forms or case list" (CommCare requires either forms or a visible case list)
	for (let mIdx = 0; mIdx < modules.length; mIdx++) {
		if (blueprint.modules[mIdx].case_list_only) {
			modules[mIdx].case_list.show = true;
			modules[mIdx].case_list.label = { en: blueprint.modules[mIdx].name };
		}
	}

	// Activate parent_select on modules whose case_type is created as a child case elsewhere
	for (let mIdx = 0; mIdx < modules.length; mIdx++) {
		const bm = blueprint.modules[mIdx];
		if (bm.case_type) {
			const parentIdx = childCaseParents.get(bm.case_type);
			if (parentIdx !== undefined && parentIdx !== mIdx) {
				modules[mIdx].parent_select = {
					active: true,
					relationship: "parent",
					module_id: modules[parentIdx].unique_id,
				};
			}
		}
	}

	return applicationShell(blueprint.app_name, modules, attachments, {
		...(blueprint.connect_type && { autoGpsCapture: true }),
	});
}
