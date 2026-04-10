import { describe, expect, it } from "vitest";
import { isValidDomainSlug } from "../client";

describe("isValidDomainSlug", () => {
	// ── Valid slugs ─────────────────────────────────────────────────
	describe("accepts valid domain slugs", () => {
		it("simple alphanumeric", () => {
			expect(isValidDomainSlug("myproject")).toBe(true);
		});

		it("with hyphens (new-style domains)", () => {
			expect(isValidDomainSlug("my-project")).toBe(true);
		});

		it("with dots (grandfathered domains)", () => {
			expect(isValidDomainSlug("my.project")).toBe(true);
		});

		it("with colons (grandfathered domains)", () => {
			expect(isValidDomainSlug("my:project")).toBe(true);
		});

		it("with underscores (legacy domains)", () => {
			expect(isValidDomainSlug("my_project")).toBe(true);
		});

		it("all digit domain", () => {
			expect(isValidDomainSlug("12345")).toBe(true);
		});

		it("mixed legacy characters", () => {
			expect(isValidDomainSlug("org.project_v2:staging")).toBe(true);
		});

		it("single character", () => {
			expect(isValidDomainSlug("a")).toBe(true);
		});
	});

	// ── Path traversal prevention ───────────────────────────────────
	// The primary threat is slash-based traversal — slashes are never valid
	// in HQ domain slugs. Dots ARE valid (grandfathered domains), so ".."
	// passes validation, but the hardcoded HQ host means the worst case is
	// hitting a 404 on the same server. No SSRF risk.
	describe("rejects path traversal attempts", () => {
		it("forward slash", () => {
			expect(isValidDomainSlug("../etc/passwd")).toBe(false);
		});

		it("nested traversal", () => {
			expect(isValidDomainSlug("domain/../../secret")).toBe(false);
		});

		it("URL-encoded slash (literal percent)", () => {
			expect(isValidDomainSlug("domain%2F..")).toBe(false);
		});

		it("dots are valid (grandfathered domains)", () => {
			expect(isValidDomainSlug("..")).toBe(true);
			expect(isValidDomainSlug("my.org.domain")).toBe(true);
		});
	});

	// ── Other invalid inputs ────────────────────────────────────────
	describe("rejects invalid inputs", () => {
		it("empty string", () => {
			expect(isValidDomainSlug("")).toBe(false);
		});

		it("spaces", () => {
			expect(isValidDomainSlug("my project")).toBe(false);
		});

		it("newlines", () => {
			expect(isValidDomainSlug("domain\n")).toBe(false);
		});

		it("null bytes", () => {
			expect(isValidDomainSlug("domain\0")).toBe(false);
		});

		it("angle brackets (XSS)", () => {
			expect(isValidDomainSlug("<script>")).toBe(false);
		});

		it("query string injection", () => {
			expect(isValidDomainSlug("domain?admin=true")).toBe(false);
		});

		it("hash fragment injection", () => {
			expect(isValidDomainSlug("domain#fragment")).toBe(false);
		});

		it("backslash (Windows path)", () => {
			expect(isValidDomainSlug("domain\\secret")).toBe(false);
		});
	});
});
