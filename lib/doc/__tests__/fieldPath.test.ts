import { describe, expect, it } from "vitest";
import { fpath, fpathId, fpathParent } from "../fieldPath";

describe("fieldPath", () => {
	it("fpath creates top-level path", () => {
		expect(fpath("my_question")).toBe("my_question");
	});

	it("fpath creates nested path", () => {
		const parent = fpath("group1");
		expect(fpath("child_q", parent)).toBe("group1/child_q");
	});

	it("fpath creates deeply nested path", () => {
		const l1 = fpath("group1");
		const l2 = fpath("group2", l1);
		expect(fpath("deep_q", l2)).toBe("group1/group2/deep_q");
	});

	it("fpathId extracts bare ID from top-level", () => {
		expect(fpathId(fpath("my_question"))).toBe("my_question");
	});

	it("fpathId extracts bare ID from nested path", () => {
		expect(fpathId(fpath("child_q", fpath("group1")))).toBe("child_q");
	});

	it("fpathParent returns undefined for top-level", () => {
		expect(fpathParent(fpath("my_question"))).toBeUndefined();
	});

	it("fpathParent returns parent for nested path", () => {
		const parent = fpath("group1");
		const child = fpath("child_q", parent);
		expect(fpathParent(child)).toBe("group1");
	});

	it("fpathParent returns parent for deeply nested path", () => {
		const l1 = fpath("group1");
		const l2 = fpath("group2", l1);
		const deep = fpath("deep_q", l2);
		expect(fpathParent(deep)).toBe("group1/group2");
	});
});
