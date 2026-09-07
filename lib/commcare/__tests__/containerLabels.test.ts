import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { containerXml } from "./containerWireFixture";

describe("container labels and their itext references", () => {
	it.each(["transparent", "user", "labelled"] as const)(
		"coordinates data, label, appearance and children for %s",
		(scenario) => {
			const { elements } = containerXml(scenario);
			const id = scenario === "user" ? "items" : "page";
			const groups = elements("group");
			expect(groups).toHaveLength(1);
			expect(groups[0].attribs).toEqual(
				scenario === "labelled"
					? { ref: `/data/${id}`, appearance: "field-list" }
					: { ref: `/data/${id}` },
			);
			const labels = groups[0].children.filter(
				(n) => isTag(n) && n.name === "label",
			);
			expect(labels.map((n) => isTag(n) && n.attribs.ref)).toEqual(
				scenario === "labelled" ? ["jr:itext('page-label')"] : [],
			);
			expect(
				elements("text").filter((n) => n.attribs.id === `${id}-label`).length,
			).toBe(scenario === "labelled" ? 1 : 0);
			expect(elements("input").map((n) => n.attribs.ref)).toEqual([
				`/data/${id}/answer`,
			]);
			if (scenario === "user")
				expect(elements("repeat").map((n) => n.attribs)).toEqual([
					{ nodeset: "/data/items" },
				]);
		},
	);
});
