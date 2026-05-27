/**
 * Escape special regex characters in a string for use in `new RegExp()`.
 *
 * NOTE: There is intentionally no `escapeXml` helper here. Every XML
 * emitter in this package CONSTRUCTS via `domhandler` element trees and
 * serializes through `dom-serializer` (see `elementBuilders.ts`); the
 * serializer is the single, exclusive escaping authority. Hand-escaping
 * a value and then handing it to the serializer would double-encode it
 * (`&` → `&amp;` → `&amp;amp;`), which is exactly the bug class the DOM
 * migration eliminated.
 */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
