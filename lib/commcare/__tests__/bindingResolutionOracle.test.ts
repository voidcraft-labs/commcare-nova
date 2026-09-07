import { describe, expect, it } from "vitest";
import { validateBindingResolution } from "../validator/bindingResolutionOracle";
import { wireForm } from "./xformOracleCorpus";

const data = "<instance><data><q/></data></instance>";
const session = '<instance id="commcaresession" src="jr://instance/session"/>';
const expression = "instance('commcaresession')/session/data/case_id";
const codes = (xml: string, datums: readonly string[] = []) =>
	validateBindingResolution(xml, "F", "M", new Set(datums)).map(
		(error) => error.code,
	);

describe("static form and suite reference joins", () => {
	for (const attr of [
		"calculate",
		"relevant",
		"required",
		"constraint",
		"readonly",
	])
		it(`joins the ${attr} expression to its actual entry datum`, () => {
			const xml = wireForm(
				`${data + session}<bind nodeset="/data/q" ${attr}="${expression}"/>`,
			);
			expect(codes(xml, ["case_id"])).toEqual([]);
			expect(codes(xml)).toEqual([
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			]);
		});
	for (const surface of ["setvalue", "output"])
		it(`joins ${surface} references`, () => {
			const xml =
				surface === "setvalue"
					? wireForm(
							data +
								session +
								`<setvalue event="xforms-ready" ref="/data/q" value="${expression}"/>`,
						)
					: wireForm(
							data + session,
							`<input ref="/data/q"><label>Case <output value="${expression}"/></label></input>`,
						);
			expect(codes(xml, ["case_id"])).toEqual([]);
			expect(codes(xml)).toEqual([
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			]);
		});
	it("joins output ref and ignores the value shadowed by it", () => {
		const body = `<input ref="/data/q"><label><output ref="${expression}" value="instance('ghost')/x"/></label></input>`;
		expect(codes(wireForm(data + session, body), ["case_id"])).toEqual([]);
		expect(codes(wireForm(data + session, body))).toEqual([
			"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
		]);
	});
	it("requires the session instance declaration even when the suite declares its datum", () => {
		expect(
			codes(
				wireForm(`${data}<bind nodeset="/data/q" calculate="${expression}"/>`),
				["case_id"],
			),
		).toEqual(["BINDING_RESOLUTION_INSTANCE_UNDECLARED"]);
	});
	it("accepts closed session metadata and flags a missing name as a static join defect", () => {
		for (const name of [
			"deviceid",
			"appversion",
			"username",
			"userid",
			"drift",
			"window_width",
			"applanguage",
		])
			expect(
				codes(
					wireForm(
						data +
							session +
							`<bind nodeset="/data/q" calculate="instance('commcaresession')/session/context/${name}"/>`,
					),
				),
			).toEqual([]);
		expect(
			codes(
				wireForm(
					data +
						session +
						`<bind nodeset="/data/q" calculate="instance('commcaresession')/session/context/absent"/>`,
				),
			),
		).toEqual(["BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN"]);
	});
	it("requires external declarations in model scope and reports independent misses", () => {
		const bind = `<bind nodeset="/data/q" calculate="instance('casedb')/casedb/case[@case_id = ${expression}]/name"/>`;
		expect(codes(wireForm(data + session + bind))).toEqual([
			"BINDING_RESOLUTION_INSTANCE_UNDECLARED",
			"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
		]);
		expect(
			codes(
				wireForm(
					data +
						session +
						'<instance id="casedb" src="jr://instance/casedb"/>' +
						bind,
				),
				["case_id"],
			),
		).toEqual([]);
		expect(
			codes(
				wireForm(
					data.replace("<q/>", '<q/><instance id="casedb"/>') + session + bind,
				),
				["case_id"],
			),
		).toEqual(["BINDING_RESOLUTION_INSTANCE_UNDECLARED"]);
	});
	it("ignores XPath-looking literal text and leaves missing local leaves to runtime semantics", () => {
		expect(
			codes(
				wireForm(
					data +
						`<bind nodeset="/data/q" calculate="&quot;instance('ghost')/session/data/absent&quot;"/>`,
				),
			),
		).toEqual([]);
		expect(
			codes(
				wireForm(`${data}<bind nodeset="/data/q" calculate="/data/absent"/>`),
			),
		).toEqual([]);
	});
	it("returns exact XML fatal errors before examining references", () => {
		expect(codes("<broken")).toEqual(["XFORM_PARSE_ERROR"]);
		expect(codes(wireForm('<bind nodeset="/data/q"/>'))).toEqual([
			"XFORM_NO_INSTANCE",
		]);
	});
});
