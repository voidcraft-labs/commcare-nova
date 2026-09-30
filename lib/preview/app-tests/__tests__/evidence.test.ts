import { expect, it } from "vitest";
import { evidenceBytes, inspectAppTestEvidence } from "../evidence";

it("reconstructs large Unicode strings and arrays through explicit bounded evidence parts", () => {
	const text = '🌍"\n漢字'.repeat(6000);
	const record = {
		questions: Array.from({ length: 43 }, (_, index) => ({ index, text })),
	};
	const root = inspectAppTestEvidence(record);
	expect(root).toMatchObject({
		kind: "object",
		entries: [{ key: "questions", kind: "array", path: ["questions"] }],
	});
	const rows: number[] = [];
	let offset = 0;
	for (;;) {
		const part = inspectAppTestEvidence(record, ["questions"], offset);
		expect(evidenceBytes(part)).toBeLessThan(64 * 1024);
		if (part.kind !== "array") throw new Error("Expected array projection");
		rows.push(...part.entries.map((entry) => Number(entry.key)));
		if (part.nextOffset === null) break;
		offset = part.nextOffset;
	}
	expect(rows).toEqual(Array.from({ length: 43 }, (_, index) => index));
	let rebuilt = "";
	offset = 0;
	for (;;) {
		const part = inspectAppTestEvidence(
			record,
			["questions", 3, "text"],
			offset,
		);
		if (part.kind !== "string") throw new Error("Expected string projection");
		expect(evidenceBytes(part)).toBeLessThan(64 * 1024);
		expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
		rebuilt += part.text;
		if (part.nextOffset === null) break;
		offset = part.nextOffset;
	}
	expect(rebuilt).toBe(text);
});
