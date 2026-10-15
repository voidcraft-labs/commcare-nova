/** HQ's name for an enum key's variable, and the digest under it. Pure. */
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { keyAsVariable, md5Hex } from "../keyVariable";

it("digests every length and script as node's MD5 does", () => {
	for (const text of [
		"",
		"a",
		"selected(., 'active')",
		"x".repeat(55),
		"x".repeat(56),
		"x".repeat(64),
		"héllo 字",
	])
		expect(md5Hex(text)).toBe(createHash("md5").update(text).digest("hex"));
});

it("names a word key `k` and the key, and any other `h` and its digest", () => {
	expect(keyAsVariable("active")).toBe("kactive");
	expect(keyAsVariable("état_2")).toBe("kétat_2");
	for (const key of ["selected(., 'active')", "two words", "a.b", "x=y"])
		expect(keyAsVariable(key)).toBe(
			`h${createHash("md5").update(key).digest("hex").slice(0, 8)}`,
		);
});
