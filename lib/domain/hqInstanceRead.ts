/**
 * What CommCare HQ's build reads as an instance in a form's text.
 *
 * `models/forms.py::FormBase.add_stuff_to_xform` calls
 * `xform.py::XForm.add_missing_instances`, which renders the whole form
 * (`WrappedNode.render`: `ET.indent`, then `ET.tostring`), runs
 * `html.unescape` over it and matches
 * `instance\(\s*['"]([\w\-:]+)['"]\s*\)` anywhere in it
 * (`suite_xml/post_process/instances.py::get_instance_names`). The pattern
 * does not tell an expression from a label, a title, an attribute or a data
 * node. For each name the form does not declare, the build adds the
 * instance where it knows a source for the name and refuses the form
 * otherwise.
 *
 * This is the domain's because two grammars of the document read it: a
 * choice's stored value (`selectOptionValue.ts`), which the builder's editor
 * applies too, and the plain texts of a form's source
 * (`lib/commcare/xform/sourceTexts.ts`). It reads literal VALUES, never XPath
 * structure: what is matched here is text an author wrote, as HQ's pattern
 * sees it.
 */

/**
 * The whitespace class HQ's Python pattern reads between `instance(` and the
 * quote mark: JavaScript's `\s` lacks four information separators and U+0085,
 * which Python's `str.isspace` holds; JavaScript's also holds U+FEFF, which
 * Python's does not, so this class is HQ's or wider.
 */
export const HQ_INSTANCE_WHITESPACE = "[\\s\\u001c-\\u001f\\u0085]*";

/**
 * HQ's whole pattern, with the name written as any run of characters that
 * holds no quote mark. HQ's name class (`[\w\-:]+`) holds no quote mark, so
 * every text HQ's pattern matches this one matches at the same place; it is
 * wider only where a closed call's name holds a character outside HQ's
 * class.
 */
const INSTANCE_CALL = new RegExp(
	`instance\\(${HQ_INSTANCE_WHITESPACE}['"][^'"]+['"]${HQ_INSTANCE_WHITESPACE}\\)`,
	"u",
);

/** The first text in `value` that CommCare HQ's build reads as an instance, or `undefined`. */
export function instanceScanRead(value: string): string | undefined {
	return INSTANCE_CALL.exec(value)?.[0];
}
