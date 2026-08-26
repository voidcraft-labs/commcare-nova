/**
 * Canonical inventory of every persisted raw-XPath carrier in BlueprintDoc.
 *
 * The inventory owns two facts together: where each expression is stored and
 * which Nova runtime, if any, evaluates it. Validators, read-only fleet scans,
 * and migrations consume this walk instead of maintaining parallel slot lists.
 * Source text remains an identity-aware projection of the stored AST.
 */

import {
	type BlueprintDoc,
	CONNECT_XPATH_SLOT_IDS,
	expressionSurfaceReads,
	FORM_LINK_XPATH_SLOT_IDS,
	formExpressionSource,
	formExpressionSourceEntries,
	printXPath,
	xpathPrintContext,
} from "@/lib/domain";

/**
 * Runtime contract for one authored XPath carrier.
 *
 * - `preview-form`: evaluated in an open form by JavaRosa and Nova Preview.
 * - `preview-session`: evaluated after form completion by both runtimes.
 * - `wire-form`: emitted into an XForm, with no corresponding Preview feature.
 * - `wire-catalog`: persisted catalog metadata that is not a live Preview slot.
 */
export type XPathCarrierProfile =
	| "preview-form"
	| "preview-session"
	| "wire-form"
	| "wire-catalog";

export interface AuthoredXPathCarrier {
	/** Stable diagnostic address. It can contain authored entity identities. */
	readonly path: string;
	/** Stable semantic slot id, independent of array position and entity id. */
	readonly slot: string;
	readonly profile: XPathCarrierProfile;
	/** Current identity-aware source projection. Never persist this text. */
	readonly source: string;
}

/** Exact secondary-instance ids the owning emitter/runtime can provide. */
export function xpathCarrierAllowedInstanceIds(
	_profile?: XPathCarrierProfile,
): ReadonlySet<string> {
	/* Raw XPath has no lookup-table UUID leaf, so a mutable wire tag cannot be
	 * admitted identity-safely. Typed lookup carriers remain fully supported and
	 * resolve their stable table identities at emission/runtime. */
	return new Set(["casedb", "commcaresession"]);
}

function formLinkPath(
	formUuid: string,
	slot: (typeof FORM_LINK_XPATH_SLOT_IDS)[number],
	indices: readonly number[],
): string {
	const linkIndex = indices[0];
	if (slot === "form_link_condition") {
		return `forms.${formUuid}.formLinks[${linkIndex}].condition`;
	}
	return `forms.${formUuid}.formLinks[${linkIndex}].datums[${indices[1]}].xpath`;
}

/** Walk every stored XPath AST exactly once, including empty expressions. */
export function authoredXPathCarriers(
	doc: BlueprintDoc,
): AuthoredXPathCarrier[] {
	const carriers: AuthoredXPathCarrier[] = [];
	const add = (
		path: string,
		slot: string,
		profile: XPathCarrierProfile,
		source: string | undefined,
	): void => {
		if (source === undefined) return;
		carriers.push({ path, slot, profile, source });
	};

	for (const [fieldUuid, field] of Object.entries(doc.fields)) {
		for (const read of expressionSurfaceReads(field, "xpath", doc)) {
			add(
				`fields.${fieldUuid}.${read.slot}`,
				read.slot,
				"preview-form",
				read.text,
			);
		}
	}

	for (const [formUuid, form] of Object.entries(doc.forms)) {
		for (const slot of CONNECT_XPATH_SLOT_IDS) {
			add(
				`forms.${formUuid}.connect.${slot}`,
				slot,
				"wire-form",
				formExpressionSource(form, slot, doc),
			);
		}
		for (const slot of FORM_LINK_XPATH_SLOT_IDS) {
			for (const read of formExpressionSourceEntries(form, slot, doc)) {
				add(
					formLinkPath(formUuid, slot, read.indices),
					slot,
					"preview-session",
					read.text,
				);
			}
		}
	}

	const printContext = xpathPrintContext(doc);
	for (const [caseTypeIndex, caseType] of (doc.caseTypes ?? []).entries()) {
		for (const [propertyIndex, property] of caseType.properties.entries()) {
			for (const [slot, expression] of [
				["required", property.required],
				["validation", property.validation],
			] as const) {
				add(
					`caseTypes[${caseTypeIndex}].properties[${propertyIndex}].${slot}`,
					`case_property_${slot}`,
					"wire-catalog",
					expression === undefined
						? undefined
						: printXPath(expression, printContext),
				);
			}
		}
	}

	return carriers;
}
