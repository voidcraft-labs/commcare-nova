/**
 * The builder turns an address into an `href` only for the web: a case
 * list's link column and a label's formatting both stand on this guard, and
 * the text they judge can come from a case, a lookup row or an answer.
 */
import { describe, expect, it } from "vitest";
import { isOpenableAddress } from "../openableAddress";

describe("an address the builder opens", () => {
	it("is a web address", () => {
		expect(isOpenableAddress("https://example.org/a?b=c")).toBe(true);
		expect(isOpenableAddress("http://example.org")).toBe(true);
		expect(isOpenableAddress("HTTPS://EXAMPLE.ORG")).toBe(true);
	});

	it("is never another scheme, a relative path or nothing", () => {
		for (const address of [
			"javascript:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,<p>x</p>",
			"data:image/png;base64,AAAA",
			"file:///etc/hosts",
			"intent://scan/#Intent;scheme=zxing;end",
			"tel:+15555550123",
			"mailto:someone@example.org",
			"/build/app",
			"example.org",
			"",
		])
			expect(isOpenableAddress(address)).toBe(false);
	});
});
