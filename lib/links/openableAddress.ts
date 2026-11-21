/**
 * Is this address something the builder may turn into an `href`?
 *
 * Only `http:` and `https:`. A case list's link column takes the address
 * from a case property, and a label's formatting can take it from a value
 * substituted into the label (a case property, a lookup cell, an answer),
 * so the text can hold `javascript:`, a `data:text/html` payload or a handler
 * scheme such as `intent:` or `file:`, and neither `target="_blank"` nor
 * `rel="noopener noreferrer"` defends against a scheme: they govern the new
 * context, not what runs in it. Web Apps' own renderer refuses `javascript:`,
 * `vbscript:` and `file:` addresses (markdown-it's `validateLink`) and
 * sanitizes the rendered markdown through DOMPurify; this guard is the
 * builder's narrower footing, and the one both the link column and a label
 * link stand on.
 *
 * Parsed rather than prefix-matched: `URL` resolves the escapes and
 * whitespace that make `java\tscript:` read as `http` to a `startsWith`, and
 * a relative address, which has no scheme to judge, is refused.
 */
export function isOpenableAddress(value: string): boolean {
	if (value === "") return false;
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
