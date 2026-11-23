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
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc } from "@/lib/domain";
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
	return sourceFromBaseline(parseHqJsonText(canonicalJsonText(source.raw)));
}

/**
 * The normalized baseline has replaced every form id with a positional token.
 * A shared entry has no namespace that distinguishes it from its siblings.
 * Restore its real id from the deployment's reference revision, walking the
 * entries of that parent in their exact saved menu order. A live HQ reading
 * always obtains its ids from HQ's own application resource instead.
 */
export function alignedFromSource(
	source: HqAppSource,
	reference?: { doc: BlueprintDoc; identity: WireIdentity },
): readonly HqAlignedModule[] {
	const xmlnsOf = expectedXmlnsOf(source);
	const entries = new Map<string, string[]>();
	if (reference) {
		const { doc, identity } = reference;
		for (const module of doc.moduleOrder) {
			for (const uuid of doc.formOrder[module] ?? []) {
				const shared = doc.forms[uuid]?.shadowOf;
				const content = shared && doc.forms[shared.form];
				if (!content) continue;
				const key = JSON.stringify([
					identity.moduleUniqueId(module),
					identity.formXmlns(content),
				]);
				let siblings = entries.get(key);
				if (!siblings) {
					siblings = [];
					entries.set(key, siblings);
				}
				siblings.push(identity.formUniqueId(uuid));
			}
		}
	}
	const positions = new Map<string, number>();
	return source.modules.map((menu) => ({
		kind: "aligned",
		uniqueId: menu.uniqueId,
		docType: menu.docType,
		forms: menu.forms.map((form) => {
			const xmlns = xmlnsOf(form);
			let uniqueId = form.readUniqueId;
			if (reference && form.docType === "ShadowForm") {
				const key = JSON.stringify([menu.uniqueId, xmlns]);
				const index = positions.get(key) ?? 0;
				uniqueId = entries.get(key)?.[index] ?? uniqueId;
				positions.set(key, index + 1);
			}
			return { uniqueId, xmlns, source: form, questions: [] };
		}),
	}));
}
