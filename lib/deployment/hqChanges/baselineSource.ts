/**
 * A stored baseline as the source a reader takes. A baseline is CommCare
 * HQ's whole answer, each form's XForm under `_attachments` included, with
 * each form id replaced by its position token and every reference to a form
 * rewritten to the same token (`hqSourceBaseline.ts::normalizeHqAppSource`),
 * stored as canonical JSON text, every object's keys sorted. A form id in a source is a key into that read only, and the tokens are
 * consistent keys, so the reader resolves a link or a case list form through
 * them as through a read's own ids.
 *
 * Pure.
 */

import {
	expectedXmlnsOf,
	type HqAlignedModule,
} from "@/lib/commcare/hq/appReading";
import {
	type HqAppSource,
	parseHqAppSource,
} from "@/lib/commcare/hq/appSource";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

function notASource(key: string): string {
	return `Nova tried to read a stored baseline as an app source and it is not one (missing ${key}). \`readAppBaseline\` verifies a baseline before it is read; this value did not come from it.`;
}

/** The parse of a source CommCare HQ serves, over a baseline's stored value. A bring-in's
 *  reading admits what a publish's does and more, so the baseline is parsed as a bring-in reads. */
export function sourceFromBaseline(normalized: unknown): HqAppSource {
	if (
		typeof normalized !== "object" ||
		normalized === null ||
		Array.isArray(normalized)
	)
		throw new Error(notASource("doc_type"));
	const parsed = parseHqAppSource(normalized as Record<string, unknown>, {
		admit: "any",
	});
	if (parsed.kind === "malformed") throw new Error(notASource(parsed.key));
	return parsed.source;
}

/**
 * `source` with every object's keys in the order a stored baseline holds
 * them: sorted by code unit, as `canonicalJsonText` writes the stored text.
 * The reader reads some maps in their key order (an operation's writes from
 * HQ's `update` map), so a source read beside a baseline is read in this
 * order, and the two readings of one app are one document.
 */
export function inStoredKeyOrder(source: HqAppSource): HqAppSource {
	return sourceFromBaseline(JSON.parse(canonicalJsonText(source.raw)));
}

/**
 * One aligned menu per menu of `source`, each form keyed by its own token,
 * with the `xmlns` the application resource would report for it (a shadow
 * form's, its parent's) and no question summary: the reader reads nothing
 * of a form's questions, and a form's real id is read by the deployment's
 * identity rows, never by the reader.
 */
export function alignedFromSource(
	source: HqAppSource,
): readonly HqAlignedModule[] {
	const xmlnsOf = expectedXmlnsOf(source);
	return source.modules.map((menu) => ({
		kind: "aligned",
		uniqueId: menu.uniqueId,
		docType: menu.docType,
		forms: menu.forms.map((form) => ({
			uniqueId: form.readUniqueId,
			xmlns: xmlnsOf(form),
			source: form,
			questions: [],
		})),
	}));
}
