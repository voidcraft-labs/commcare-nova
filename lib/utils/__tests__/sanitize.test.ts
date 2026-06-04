/**
 * `sanitizeFilename` — the guard that lets user-controlled app names flow into
 * a `Content-Disposition` response header (the `.ccz` / JSON export routes).
 *
 * The load-bearing case is CR/LF removal: a name carrying a newline that reached
 * the header would make the platform's `Headers` constructor throw and turn an
 * export into an opaque 500. These tests pin that the sanitizer strips interior
 * CR/LF/tabs (not just edge whitespace) while preserving ordinary names.
 */

import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../sanitize";

describe("sanitizeFilename", () => {
	it("preserves ordinary names (letters, digits, spaces, dots, parens, hyphens)", () => {
		expect(sanitizeFilename("Vaccine Tracker")).toBe("Vaccine Tracker");
		expect(sanitizeFilename("Survey (2024) - v2.1")).toBe(
			"Survey (2024) - v2.1",
		);
	});

	it("strips interior CR/LF/tabs, not just edge whitespace", () => {
		// `\s` would have kept these — the whole point of the literal-space class.
		expect(sanitizeFilename("My\nApp")).toBe("MyApp");
		expect(sanitizeFilename("My\r\nApp")).toBe("MyApp");
		expect(sanitizeFilename("My\tApp")).toBe("MyApp");
	});

	it("neutralizes a header-injection attempt (no CR/LF survives)", () => {
		const out = sanitizeFilename('evil"\r\nSet-Cookie: x=1');
		expect(out).not.toMatch(/[\r\n]/);
		expect(out).not.toContain('"');
	});

	it("the sanitized value is a valid HTTP header value", () => {
		// The real failure mode: an unsanitized CR/LF makes the `Headers`
		// constructor throw, which the export route surfaces as a 500. Build
		// `Headers` directly (not a `Response`) — that's where the validation
		// throw originates, and it leaves no unconsumed response body stream open
		// for the async-leak gate to flag.
		expect(
			() =>
				new Headers({
					"Content-Disposition": `attachment; filename="${sanitizeFilename("My\nApp")}.ccz"`,
				}),
		).not.toThrow();
	});

	it("falls back to 'app' when sanitization empties the string", () => {
		expect(sanitizeFilename("   ")).toBe("app");
		expect(sanitizeFilename("\n\t")).toBe("app");
		expect(sanitizeFilename("日本語")).toBe("app"); // \w is ASCII-only; non-Latin drops
	});
});
