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
		"emits independently addressed count nodes for %s",
		(scenario) => {
			const { elements } = containerXml(scenario);
			const repeats = elements("repeat");
			const counts =
				scenario === "cousins"
					? ["/data/__nova_count_items", "/data/__nova_count_items_1"]
					: ["/data/__nova_count_items"];
			expect(repeats.map((e) => e.attribs["jr:count"])).toEqual(counts);
			expect(repeats.map((e) => e.attribs["jr:noAddRemove"])).toEqual(
				counts.map(() => "true()"),
			);
			expect(repeats.map((e) => e.attribs.nodeset)).toEqual(
				scenario === "cousins"
					? ["/data/one/items", "/data/two/items"]
					: ["/data/items"],
			);
			expect(repeats.map((e) => e.attribs["vellum:jr__count"])).toEqual(
				counts.map(() => undefined),
			);
			expect(
				elements("setvalue")
					.filter((e) => counts.includes(e.attribs.ref))
					.map((e) => e.attribs),
			).toEqual(
				counts.map((ref, i) => ({
					event: "xforms-ready",
					ref,
					value:
						scenario === "path"
							? "string(/data/size)"
							: scenario === "expression"
								? "/data/size + 2"
								: scenario === "cousins" && i === 1
									? "5"
									: "3",
				})),
			);
			for (const path of counts) {
				const node = elements(path.slice(6))[0];
				expect(node.parent).toMatchObject({ type: "tag", name: "data" });
				expect(
					elements("bind").find((e) => e.attribs.nodeset === path)?.attribs,
				).toEqual({
					nodeset: path,
					type: scenario === "path" ? "xsd:string" : "xsd:int",
				});
			}
			if (scenario === "cousins")
				expect(
					elements("text")
						.filter((e) => e.attribs.id.endsWith("items-label"))
						.map((e) => e.attribs.id),
				).toEqual(["one-items-label", "two-items-label"]);
		},
	);
});
