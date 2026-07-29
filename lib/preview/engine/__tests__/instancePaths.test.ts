import { describe, expect, it } from "vitest";
import {
	projectInstancePath,
	rebaseOntoContext,
	remapInstancePath,
	stripIndices,
} from "../instancePaths";

describe("stripIndices", () => {
	it("removes every instance segment", () => {
		expect(stripIndices("/data/orders[1]/name")).toBe("/data/orders/name");
		expect(stripIndices("/data/a[0]/b[12]/c")).toBe("/data/a/b/c");
	});

	it("leaves index-free paths untouched", () => {
		expect(stripIndices("/data/group/name")).toBe("/data/group/name");
	});
});

describe("projectInstancePath", () => {
	it("maps index zero but removes higher instances when moving between distinct repeats", () => {
		const identity = {
			oldSegmentKeys: ["$data", "left-repeat", "photo"],
			newSegmentKeys: ["$data", "right-repeat", "photo"],
		};
		expect(
			projectInstancePath(
				"/data/left[0]/photo",
				"/data/left[0]/photo",
				"/data/right[0]/photo",
				identity,
			),
		).toEqual({ kind: "mapped", path: "/data/right[0]/photo" });
		expect(
			projectInstancePath(
				"/data/left[2]/photo",
				"/data/left[0]/photo",
				"/data/right[0]/photo",
				identity,
			),
		).toEqual({ kind: "removed" });
	});

	it("carries retained nested repeat indices through a depth-changing move", () => {
		expect(
			projectInstancePath(
				"/data/households[2]/members[3]/photo",
				"/data/households[0]/members[0]/photo",
				"/data/visit/households[0]/members[0]/photo",
				{
					oldSegmentKeys: ["$data", "households", "members", "photo"],
					newSegmentKeys: ["$data", "visit", "households", "members", "photo"],
				},
			),
		).toEqual({
			kind: "mapped",
			path: "/data/visit/households[2]/members[3]/photo",
		});
	});

	it("fails closed for malformed paths, mismatches, and missing stable identities", () => {
		expect(
			projectInstancePath(
				"/data/orders[1]/photo",
				"/data/visits[0]/photo",
				"/data/archive/photo",
				{
					oldSegmentKeys: ["$data", "visits", "photo"],
					newSegmentKeys: ["$data", "archive", "photo"],
				},
			),
		).toMatchObject({ kind: "invalid" });
		expect(
			projectInstancePath(
				"/data/orders[1]//photo",
				"/data/orders[0]/photo",
				"/data/archive/photo",
			),
		).toMatchObject({ kind: "invalid" });
		expect(
			projectInstancePath(
				"/data/orders[1]/photo",
				"/data/orders[0]/photo",
				"/data/archive/photo",
				{
					oldSegmentKeys: ["$data", "orders", "photo"],
					newSegmentKeys: ["$data", "archive"],
				},
			),
		).toMatchObject({ kind: "invalid" });
	});
});

describe("rebaseOntoContext", () => {
	it("binds a repeat-sibling reference to the context's instance", () => {
		expect(
			rebaseOntoContext(
				"/data/orders/medication_name",
				"/data/orders[1]/case_name",
			),
		).toBe("/data/orders[1]/medication_name");
	});

	it("binds the repeat container path itself", () => {
		expect(rebaseOntoContext("/data/orders", "/data/orders[2]/name")).toBe(
			"/data/orders[2]",
		);
	});

	it("leaves references outside the context's repeats untouched", () => {
		expect(
			rebaseOntoContext("/data/patient_name", "/data/orders[1]/case_name"),
		).toBe("/data/patient_name");
	});

	it("is a no-op for a context outside every repeat", () => {
		expect(
			rebaseOntoContext("/data/orders/medication_name", "/data/summary"),
		).toBe("/data/orders/medication_name");
	});

	it("binds the deepest shared repeat in nested contexts", () => {
		expect(rebaseOntoContext("/data/a/b/c", "/data/a[1]/b[0]/d")).toBe(
			"/data/a[1]/b[0]/c",
		);
		expect(rebaseOntoContext("/data/a/x", "/data/a[1]/b[0]/d")).toBe(
			"/data/a[1]/x",
		);
	});

	it("passes explicitly indexed references through unchanged", () => {
		expect(
			rebaseOntoContext("/data/orders[0]/name", "/data/orders[1]/other"),
		).toBe("/data/orders[0]/name");
	});
});

describe("remapInstancePath", () => {
	it("renames a leaf across instances, carrying the index", () => {
		expect(
			remapInstancePath(
				"/data/orders[2]/name",
				"/data/orders[0]/name",
				"/data/orders[0]/med",
			),
		).toBe("/data/orders[2]/med");
	});

	it("renames a container, carrying descendant indices", () => {
		expect(
			remapInstancePath(
				"/data/orders[1]/name",
				"/data/orders[0]/name",
				"/data/meds[0]/name",
			),
		).toBe("/data/meds[1]/name");
		expect(
			remapInstancePath("/data/orders", "/data/orders", "/data/meds"),
		).toBe("/data/meds");
	});

	it("group→repeat gains the new template's index", () => {
		expect(
			remapInstancePath("/data/c/child", "/data/c/child", "/data/c[0]/child"),
		).toBe("/data/c[0]/child");
	});

	it("repeat→group keeps instance 0 and drops the rest", () => {
		expect(
			remapInstancePath(
				"/data/c[0]/child",
				"/data/c[0]/child",
				"/data/c/child",
			),
		).toBe("/data/c/child");
		expect(
			remapInstancePath(
				"/data/c[1]/child",
				"/data/c[0]/child",
				"/data/c/child",
			),
		).toBeNull();
	});

	it("uses stable segment identity across a cross-parent repeat move", () => {
		const identity = {
			oldSegmentKeys: ["$data", "visit", "photo"],
			newSegmentKeys: ["$data", "rounds", "visit", "photo"],
		};
		expect(
			remapInstancePath(
				"/data/visit/photo",
				"/data/visit/photo",
				"/data/rounds[0]/visit/photo",
				identity,
			),
		).toBe("/data/rounds[0]/visit/photo");

		const reverseIdentity = {
			oldSegmentKeys: identity.newSegmentKeys,
			newSegmentKeys: identity.oldSegmentKeys,
		};
		expect(
			remapInstancePath(
				"/data/rounds[0]/visit/photo",
				"/data/rounds[0]/visit/photo",
				"/data/visit/photo",
				reverseIdentity,
			),
		).toBe("/data/visit/photo");
		expect(
			remapInstancePath(
				"/data/rounds[1]/visit/photo",
				"/data/rounds[0]/visit/photo",
				"/data/visit/photo",
				reverseIdentity,
			),
		).toBeNull();
	});

	it("returns null on segment-count mismatch", () => {
		expect(remapInstancePath("/data/a/b", "/data/a", "/data/z")).toBeNull();
	});
});
