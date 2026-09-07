import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { expandDoc } from "../expander";
import { containerWireFixture, containerXml } from "./containerWireFixture";

describe("section XForm structure (native metadata checked by ContainerRuntimeTest)", () => {
	it.each(["titled", "untitled", "empty", "nested", "registration"] as const)(
		"preserves section data and controls for %s",
		(scenario) => {
			const { elements } = containerXml(scenario);
			const groups = elements("group");
			const page = groups.find((g) => g.attribs.ref === "/data/page");
			expect(page?.attribs).toEqual({
				ref: "/data/page",
				appearance: "field-list",
			});
			expect(elements("page")).toHaveLength(1);
			expect(
				elements("bind").filter((b) => b.attribs.nodeset === "/data/page"),
			).toEqual([]);
			const labels = page?.children.filter(
				(n) => isTag(n) && n.name === "label",
			);
			expect(labels?.map((n) => isTag(n) && n.attribs.ref)).toEqual(
				scenario === "untitled" || scenario === "empty"
					? []
					: ["jr:itext('page-label')"],
			);
			expect(elements("input").map((n) => n.attribs.ref)).toEqual(
				scenario === "nested"
					? ["/data/page/named/answer", "/data/page/plain/answer"]
					: ["/data/page/answer"],
			);
			if (scenario === "nested")
				expect(groups.map((g) => g.attribs)).toEqual([
					{ ref: "/data/page", appearance: "field-list" },
					{ ref: "/data/page/named", appearance: "field-list" },
					{ ref: "/data/page/plain" },
				]);
			if (scenario === "empty") {
				expect(
					groups.find((g) => g.attribs.ref === "/data/empty")?.attribs,
				).toEqual({ ref: "/data/empty", appearance: "field-list" });
				expect(elements("empty")[0].children).toEqual([]);
			}
			if (scenario === "registration")
				expect(
					expandDoc(containerWireFixture(scenario)).modules[0].forms[0].actions
						.open_case.name_update,
				).toEqual({ question_path: "/data/page/answer" });
		},
	);
});
