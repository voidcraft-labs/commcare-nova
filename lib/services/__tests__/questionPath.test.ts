import { describe, expect, it } from "vitest";
import { qpath, qpathId, qpathParent } from "../questionPath";

describe("questionPath", () => {
	it("qpath creates top-level path", () => {
		expect(qpath("my_question")).toBe("my_question");
	});

	it("qpath creates nested path", () => {
		const parent = qpath("group1");
		expect(qpath("child_q", parent)).toBe("group1/child_q");
	});

	it("qpath creates deeply nested path", () => {
		const l1 = qpath("group1");
		const l2 = qpath("group2", l1);
		expect(qpath("deep_q", l2)).toBe("group1/group2/deep_q");
	});

	it("qpathId extracts bare ID from top-level", () => {
		expect(qpathId(qpath("my_question"))).toBe("my_question");
	});

	it("qpathId extracts bare ID from nested path", () => {
		expect(qpathId(qpath("child_q", qpath("group1")))).toBe("child_q");
	});

	it("qpathParent returns undefined for top-level", () => {
		expect(qpathParent(qpath("my_question"))).toBeUndefined();
	});

	it("qpathParent returns parent for nested path", () => {
		const parent = qpath("group1");
		const child = qpath("child_q", parent);
		expect(qpathParent(child)).toBe("group1");
	});

	it("qpathParent returns parent for deeply nested path", () => {
		const l1 = qpath("group1");
		const l2 = qpath("group2", l1);
		const deep = qpath("deep_q", l2);
		expect(qpathParent(deep)).toBe("group1/group2");
	});
});
