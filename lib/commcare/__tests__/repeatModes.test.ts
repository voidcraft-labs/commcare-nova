import { describe, expect, it } from "vitest";
import { containerXml } from "./containerWireFixture";

describe("repeat wire structure (actual entry and row identities checked by ContainerRuntimeTest)", () => {
	it("emits a user-controlled repeat without count bookkeeping", () => {
		const { elements } = containerXml("user");
		expect(elements("repeat").map((e) => e.attribs)).toEqual([
			{ nodeset: "/data/items" },
		]);
		expect(
			elements("setvalue").filter((e) =>
				e.attribs.ref.startsWith("/data/items"),
			),
		).toEqual([]);
	});
	it.each(["path", "literal", "expression", "cousins"] as const)(
		"emits live count locations for %s",
		(scenario) => {
			const { elements } = containerXml(scenario);
			const counts =
				scenario === "path"
					? ["/data/size"]
					: scenario === "cousins"
						? ["/data/one/nova_count_items", "/data/two/nova_count_items"]
						: ["/data/nova_count_items"];
			expect(elements("repeat").map((e) => e.attribs["jr:count"])).toEqual(
				counts,
			);
			expect(
				elements("repeat").map((e) => e.attribs["jr:noAddRemove"]),
			).toEqual(counts.map(() => "true()"));
			expect(
				elements("repeat").map((e) => e.attribs["vellum:jr__count"]),
			).toEqual(counts.map((path) => path.replace("/data/", "#form/")));
			expect(
				elements("setvalue").filter((e) => counts.includes(e.attribs.ref)),
			).toEqual(
				scenario === "path"
					? [
							expect.objectContaining({
								attribs: expect.objectContaining({ ref: "/data/size" }),
							}),
						]
					: [],
			);
			expect(
				elements("bind").filter((e) =>
					e.attribs.nodeset.includes("__nova_count_"),
				),
			).toEqual([]);
			if (scenario !== "path")
				for (const [index, path] of counts.entries()) {
					expect(
						elements("bind").find((e) => e.attribs.nodeset === path)?.attribs,
					).toMatchObject({
						type: "xsd:int",
						calculate:
							scenario === "expression"
								? "/data/size + 2"
								: scenario === "cousins" && index === 1
									? "5"
									: "3",
					});
				}
		},
	);
	it("allocates around all authored sibling names, including later fields", () => {
		const { elements } = containerXml("count-collision");
		expect(elements("repeat")[0].attribs["jr:count"]).toBe(
			"/data/nova_count_items_2",
		);
		expect(
			elements("bind").find(
				(e) => e.attribs.nodeset === "/data/nova_count_items",
			)?.attribs.calculate,
		).toBe("'authored'");
		expect(
			elements("bind").find(
				(e) => e.attribs.nodeset === "/data/nova_count_items_1",
			)?.attribs.calculate,
		).toBe("'also authored'");
		expect(
			elements("bind").find(
				(e) => e.attribs.nodeset === "/data/nova_count_items_2",
			)?.attribs.calculate,
		).toBe("3");
	});
});
