/**
 * CommCare HQ's build reads a form as one string for instance reads.
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
 * These read literal VALUES, never XPath structure: what is matched here is
 * text an author wrote, as HQ's pattern sees it.
 */

// The whitespace class HQ's Python pattern reads between `instance(` and the
// quote mark: JavaScript's `\s` lacks four information separators and U+0085,
// which Python's `str.isspace` holds; JavaScript's also holds U+FEFF, which
// Python's does not, so this class is HQ's or wider.
const HQ_WHITESPACE = "[\\s\\u001c-\\u001f\\u0085]*";

/** The head of HQ's pattern: where a match could start. */
const INSTANCE_CALL_HEAD = new RegExp(`instance\\(${HQ_WHITESPACE}['"]`, "gu");

/**
 * HQ's whole pattern, with the name written as any run of characters that
 * holds no quote mark. HQ's name class (`[\w\-:]+`) holds no quote mark, so
 * every text HQ's pattern matches this one matches at the same place; it is
 * wider only where a closed call's name holds a character outside HQ's
 * class.
 */
const INSTANCE_CALL = new RegExp(
	`instance\\(${HQ_WHITESPACE}['"][^'"]+['"]${HQ_WHITESPACE}\\)`,
	"u",
);

/**
 * The offsets just after each `instance` in `value` at which HQ's pattern
 * could start a match: `instance(`, whitespace, a quote mark. A writer that
 * puts something other than a character between the word and its bracket at
 * each offset leaves HQ's pattern nothing to match there.
 */
export function instanceScanCuts(value: string): number[] {
	const cuts: number[] = [];
	for (const match of value.matchAll(INSTANCE_CALL_HEAD))
		cuts.push(match.index + "instance".length);
	return cuts;
}

/** The first text in `value` that CommCare HQ's build reads as an instance, or `undefined`. */
export function instanceScanRead(value: string): string | undefined {
	return INSTANCE_CALL.exec(value)?.[0];
}
