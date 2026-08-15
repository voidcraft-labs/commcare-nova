import {
	inspectXPathFunctionCalls,
	type XPathFunctionCallCapability,
} from "@/lib/commcare/xpath/functionCapabilities";
import {
	type BlueprintDoc,
	CONNECT_XPATH_SLOT_IDS,
	expressionSurfaceReads,
	formExpressionSource,
	printXPath,
	xpathPrintContext,
} from "@/lib/domain";

export interface XPathCarrierOccurrence {
	readonly path: string;
	readonly source: string;
	readonly calls: readonly XPathFunctionCallCapability[];
}

/** Every persisted raw-XPath carrier in a hydrated blueprint. */
export function scanBlueprintXPathCarriers(
	doc: BlueprintDoc,
): XPathCarrierOccurrence[] {
	const occurrences: XPathCarrierOccurrence[] = [];
	const add = (path: string, source: string | undefined) => {
		if (source === undefined || source.trim().length === 0) return;
		occurrences.push({
			path,
			source,
			calls: inspectXPathFunctionCalls(source),
		});
	};

	for (const [fieldUuid, field] of Object.entries(doc.fields)) {
		for (const read of expressionSurfaceReads(field, "xpath", doc)) {
			add(`fields.${fieldUuid}.${read.slot}`, read.text);
		}
	}

	const printContext = xpathPrintContext(doc);
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		for (const slot of CONNECT_XPATH_SLOT_IDS) {
			add(
				`forms.${formUuid}.connect.${slot}`,
				formExpressionSource(form, slot, doc),
			);
		}
		for (const [linkIndex, link] of (form.formLinks ?? []).entries()) {
			if (link.condition !== undefined) {
				add(
					`forms.${formUuid}.formLinks[${linkIndex}].condition`,
					printXPath(link.condition, printContext),
				);
			}
			for (const [datumIndex, datum] of (link.datums ?? []).entries()) {
				add(
					`forms.${formUuid}.formLinks[${linkIndex}].datums[${datumIndex}].xpath`,
					printXPath(datum.xpath, printContext),
				);
			}
		}
	}

	return occurrences;
}
