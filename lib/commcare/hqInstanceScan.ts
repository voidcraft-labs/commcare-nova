/**
 * Where a writer of a form's source cuts a literal so CommCare HQ's build
 * reads no instance in it.
 *
 * HQ's build reads the whole rendered form for `instance('…')`
 * (`lib/domain/hqInstanceRead.ts`, which holds the pattern and the reading
 * the gate refuses by, `instanceScanRead`). A literal a writer may spell
 * another way, a label's text or a string in a formula, is cut instead,
 * wherever a match could start.
 *
 * These read literal VALUES, never XPath structure: what is matched here is
 * text an author wrote, as HQ's pattern sees it.
 */
import { HQ_INSTANCE_WHITESPACE } from "@/lib/domain/hqInstanceRead";

export { instanceScanRead } from "@/lib/domain/hqInstanceRead";

/** The head of HQ's pattern: where a match could start. */
const INSTANCE_CALL_HEAD = new RegExp(
	`instance\\(${HQ_INSTANCE_WHITESPACE}['"]`,
	"gu",
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
