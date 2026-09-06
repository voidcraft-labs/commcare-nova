import { expect, it } from "vitest";
import { mediaObjectLockIdentity } from "../mediaObjectIdentity";

it("uses one identity for final objects and extracts of the same Project and content", () => {
	const hash = "a".repeat(64);
	for (const extension of [".txt", ".md", ".extract.v2.md", ".png"])
		expect(
			mediaObjectLockIdentity(`projects/program/${hash}${extension}`),
		).toBe(`projects/program/${hash}`);
	expect(mediaObjectLockIdentity(`projects/other/${hash}.txt`)).toBe(
		`projects/other/${hash}`,
	);
	expect(
		mediaObjectLockIdentity(`projects/program/${"b".repeat(64)}.txt`),
	).not.toBe(`projects/program/${hash}`);
});

it("preserves exact pending and noncanonical keys rather than accidentally sharing a content identity", () => {
	for (const key of [
		"pending/program/attempt.txt",
		"projects/program/hash.png",
		`projects/program/${"a".repeat(64)}`,
		`projects/program/${"A".repeat(64)}.png`,
		"arbitrary-key",
	])
		expect(mediaObjectLockIdentity(key)).toBe(key);
});
