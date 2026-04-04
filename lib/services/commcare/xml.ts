/** Escape special XML characters for attribute values and text content.
 *  All our attributes are double-quoted, so single quotes are left as-is —
 *  HQ/CommCare expects literal ' in XPath expressions (e.g. instance('casedb')). */
export function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Escape special regex characters in a string for use in `new RegExp()`. */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
