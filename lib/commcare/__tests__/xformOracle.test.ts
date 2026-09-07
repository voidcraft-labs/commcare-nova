import { describe, expect, it } from "vitest";
import { validateXForm } from "../validator/xformOracle";
import { wireForm, xformOracleCases } from "./xformOracleCorpus";

describe("XForm oracle wire corpus", () => {
	it.each(xformOracleCases)("$name", ({ xml, codes, manifest }) => {
		expect(
			validateXForm(
				xml,
				"F",
				"M",
				manifest ? new Set(manifest) : undefined,
			).map((error) => error.code),
		).toEqual(codes);
	});
	it("owns exact itext media joins independently of XPath symbol resolution", () => {
		const text = (value: string, form = "image") =>
			wireForm(
				`<instance><data><q/></data></instance><bind nodeset="/data/q"/><itext><translation lang="en" default=""><text id="q"><value>Q</value><value form="${form}">${value}</value></text></translation></itext>`,
			);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png"),
				"F",
				"M",
				new Set(["commcare/a.png"]),
			),
		).toEqual([]);
		expect(
			validateXForm(text("jr://file/commcare/a.png"), "F", "M", new Set()).map(
				(error) => error.code,
			),
		).toEqual(["XFORM_DANGLING_MEDIA_REF"]);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png "),
				"F",
				"M",
				new Set(["commcare/a.png"]),
			).map((error) => error.code),
		).toEqual(["XFORM_DANGLING_MEDIA_REF"]);
		expect(validateXForm(text("jr://file/commcare/a.png"), "F", "M")).toEqual(
			[],
		);
		expect(
			validateXForm(
				text("jr://file/commcare/a.png", "markdown"),
				"F",
				"M",
				new Set(),
			),
		).toEqual([]);
	});
});
