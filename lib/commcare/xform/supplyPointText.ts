/**
 * Whether a form's source holds the text CommCare HQ reads as the session's
 * supply point.
 *
 * Where the project space has CommCare Supply on, HQ's build gives a form's
 * entry a `supply_point_id` datum from the worker's `commtrack-supply-point`
 * user data, with assertions, when the stored source contains
 * `session_var('supply_point_id')` as a substring
 * (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`;
 * `xpath.py::session_var` spells it
 * `instance('commcaresession')/session/data/supply_point_id`). The test is a
 * substring test over the source text, so this reads text too, never XPath.
 *
 * Nova's serializer writes every `'` as `&apos;` (`serializeXml.ts`), and a
 * save in HQ's form builder writes the apostrophes plainly, so this reads
 * every attribute value, text node and comment as the parser decodes it,
 * which holds whatever text a save can leave. No admitted document's source
 * holds the text even decoded: an itext text's `instance(` is written with
 * its bracket as an output (`builder.ts::literalLabelNodes`), a literal is
 * split there (`xpath/wire/serialize.ts::literalPieces`), and a form's name
 * and Connect texts holding it are refused at the gate
 * (`FORM_TEXT_READ_AS_INSTANCE`). `planPrivileges.ts::commtrackReasons` reads
 * the emission through this as a guard.
 */

import { type AnyNode, isComment, isTag, isText } from "domhandler";
import { parseXml } from "../xmlParse";

/** The text HQ's `session_var('supply_point_id')` prints. */
export const SUPPLY_POINT_SESSION_TEXT =
	"instance('commcaresession')/session/data/supply_point_id";

/** Whether one node, or any node beneath it, holds the text. */
function holdsText(node: AnyNode): boolean {
	if (isText(node) || isComment(node))
		return node.data.includes(SUPPLY_POINT_SESSION_TEXT);
	if (!isTag(node)) return false;
	return (
		Object.values(node.attribs).some((value) =>
			value.includes(SUPPLY_POINT_SESSION_TEXT),
		) || node.children.some(holdsText)
	);
}

/**
 * Whether some decoded attribute value, text node or comment of `source`, an
 * XForm, holds `SUPPLY_POINT_SESSION_TEXT`. Text split across two nodes is
 * not held, because no single stretch of the source holds it.
 */
export function formSourceHoldsSupplyPointText(source: string): boolean {
	return parseXml(source).children.some(holdsText);
}
