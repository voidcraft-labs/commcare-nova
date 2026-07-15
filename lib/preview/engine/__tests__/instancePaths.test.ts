import { describe, expect, it } from "vitest";
import { rebaseOntoContext, stripIndices } from "../instancePaths";

describe("stripIndices", () => {
	it("removes every instance segment", () => {
		expect(stripIndices("/data/orders[1]/name")).toBe("/data/orders/name");
		expect(stripIndices("/data/a[0]/b[12]/c")).toBe("/data/a/b/c");
	});

	it("leaves index-free paths untouched", () => {
		expect(stripIndices("/data/group/name")).toBe("/data/group/name");
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
