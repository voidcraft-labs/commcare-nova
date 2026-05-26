/**
 * Unit coverage for the binding-resolution oracle.
 *
 * Each test pairs a synthetic XForm + session-datum set with the expected
 * `ValidationError[]` shape. The XForm strings are minimal — just enough
 * `<model>`/`<instance>`/`<bind>`/`<setvalue>` to exercise one rule per
 * test. Acceptance for the oracle is "every install-time-evaluable XPath
 * surface gets resolved against the right symbol set"; the rules covered
 * here are:
 *
 *   - BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED (rule 1)
 *   - BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN  (rule 2)
 *   - BINDING_RESOLUTION_INSTANCE_UNDECLARED      (rule 3)
 *   - BINDING_RESOLUTION_FORM_PATH_MISSING        (rule 4)
 *
 * The fuzz test in `bindingResolutionOracle.fuzz.test.ts` proves emitter
 * totality across schema-valid blueprints; this file proves each rule's
 * positive AND negative cases stay stable as the oracle evolves.
 */

import { describe, expect, it } from "vitest";
import { validateBindingResolution } from "../validator/bindingResolutionOracle";

/**
 * Wrap a `<model>` body in the minimal well-formed XForm shell the oracle
 * needs (the parser locates the main `<instance>` and the model walks).
 * Body content goes verbatim — most tests only need the `<bind>` /
 * `<setvalue>` elements and rely on the empty data element / no controls.
 */
function makeForm(modelBody: string, dataBody: string = ""): string {
	return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:jr="http://openrosa.org/javarosa">
<h:head><h:title>t</h:title><model>
<instance><data xmlns="" id="t">${dataBody}</data></instance>
<instance src="jr://instance/session" id="commcaresession"/>
${modelBody}
</model></h:head><h:body/></h:html>`;
}

describe("validateBindingResolution", () => {
	describe("rule 1 — session-data refs must declare a matching datum", () => {
		it("accepts a session-data ref when the datum is declared", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('commcaresession')/session/data/case_id"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(
				xml,
				"f",
				"m",
				new Set(["case_id"]),
			);
			expect(errors).toEqual([]);
		});

		it("rejects a session-data ref when the datum is missing", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('commcaresession')/session/data/case_id_new_visit_0"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe(
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			);
			expect(errors[0].message).toContain("case_id_new_visit_0");
		});

		it("walks setvalue value attributes alongside bind expressions", () => {
			const xml = makeForm(`<bind nodeset="/data/x"/>`, `<x/>`).replace(
				"</model>",
				`<setvalue ref="/data/x" event="xforms-ready" value="instance('commcaresession')/session/data/missing_datum"/></model>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe(
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			);
			expect(errors[0].message).toContain("missing_datum");
		});

		it("walks bind readonly expressions alongside the other ANY-expression slots", () => {
			// `readonly` is one of the five ANY-expression bind attributes
			// JavaRosa evaluates at form-init (parsed via buildCondition);
			// references inside it resolve like calculate / relevant.
			const xml = makeForm(
				`<bind nodeset="/data/x" readonly="instance('commcaresession')/session/data/ghost_datum"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe(
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			);
			expect(errors[0].message).toContain("ghost_datum");
		});

		it("walks output value in body alongside model expressions", () => {
			const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><h:title>t</h:title><model>
<instance><data xmlns="" id="t"><x/></data></instance>
<instance src="jr://instance/session" id="commcaresession"/>
<bind nodeset="/data/x"/>
</model></h:head><h:body>
<input ref="/data/x"><label>hi <output value="instance('commcaresession')/session/data/ghost"/></label></input>
</h:body></h:html>`;
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe(
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			);
			expect(errors[0].message).toContain("ghost");
		});
	});

	describe("rule 2 — session-context refs must be in the closed CommCare set", () => {
		it("accepts every documented session-context field", () => {
			const fields = [
				"deviceid",
				"appversion",
				"username",
				"userid",
				"drift",
				"window_width",
				"applanguage",
			];
			for (const field of fields) {
				const xml = makeForm(
					`<bind nodeset="/data/x" calculate="instance('commcaresession')/session/context/${field}"/>`,
					`<x/>`,
				);
				const errors = validateBindingResolution(xml, "f", "m", new Set());
				expect(errors, `field ${field}`).toEqual([]);
			}
		});

		it("rejects an unknown session-context field", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('commcaresession')/session/context/madeup_field"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("BINDING_RESOLUTION_SESSION_CONTEXT_UNKNOWN");
			expect(errors[0].message).toContain("madeup_field");
		});
	});

	describe("rule 3 — non-commcaresession instance refs must be declared", () => {
		it("accepts a casedb ref when the instance is declared on the form", () => {
			const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><h:title>t</h:title><model>
<instance><data xmlns="" id="t"><x/></data></instance>
<instance src="jr://instance/casedb" id="casedb"/>
<instance src="jr://instance/session" id="commcaresession"/>
<bind nodeset="/data/x" calculate="instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/foo"/>
</model></h:head><h:body/></h:html>`;
			const errors = validateBindingResolution(
				xml,
				"f",
				"m",
				new Set(["case_id"]),
			);
			expect(errors).toEqual([]);
		});

		it("rejects a casedb ref when the instance is undeclared", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/foo"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(
				xml,
				"f",
				"m",
				new Set(["case_id"]),
			);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("BINDING_RESOLUTION_INSTANCE_UNDECLARED");
			expect(errors[0].message).toContain('instance("casedb")');
		});

		it("only counts <instance> declarations under <model>, not nodes named 'instance' deeper in the data tree", () => {
			// A data-tree node named `<instance>` (with an id attribute) is
			// a data node, not a declaration — the spec scopes <instance>
			// declarations to <model>. The oracle must not be fooled into
			// treating it as a declared external instance.
			const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><h:title>t</h:title><model>
<instance><data xmlns="" id="t"><x/><instance id="not_a_real_instance"/></data></instance>
<instance src="jr://instance/session" id="commcaresession"/>
<bind nodeset="/data/x" calculate="instance('not_a_real_instance')/items"/>
</model></h:head><h:body/></h:html>`;
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			const codes = errors.map((e) => e.code);
			expect(codes).toContain("BINDING_RESOLUTION_INSTANCE_UNDECLARED");
		});

		it("ignores instance('commcaresession') — that's the session and always available", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('commcaresession')/session/data/case_id"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(
				xml,
				"f",
				"m",
				new Set(["case_id"]),
			);
			expect(errors).toEqual([]);
		});
	});

	describe("rule 4 — absolute /<root>/... refs must resolve to a data-tree node or attribute", () => {
		it("accepts a ref that resolves to an existing path", () => {
			const xml = makeForm(
				`<bind nodeset="/data/result" calculate="/data/source"/>`,
				`<source/><result/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toEqual([]);
		});

		it("rejects a ref to a path that doesn't exist", () => {
			const xml = makeForm(
				`<bind nodeset="/data/result" calculate="/data/no_such_field"/>`,
				`<result/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("BINDING_RESOLUTION_FORM_PATH_MISSING");
			expect(errors[0].message).toContain("/data/no_such_field");
		});

		it("accepts an attribute ref when the @attr exists on the target element", () => {
			const xml = makeForm(
				`<bind nodeset="/data/result" calculate="/data/case/@case_id"/>`,
				`<case case_id=""/><result/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toEqual([]);
		});

		it("rejects an @attr ref when the attribute doesn't exist on the target element", () => {
			const xml = makeForm(
				`<bind nodeset="/data/result" calculate="/data/case/@nonexistent_attr"/>`,
				`<case case_id=""/><result/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("BINDING_RESOLUTION_FORM_PATH_MISSING");
			expect(errors[0].message).toContain("/data/case/@nonexistent_attr");
		});

		it("does not raise for the descendant axis (//) — the oracle can't pin a single resolvable path", () => {
			// `/data//foo` matches any descendant named foo at any depth.
			// Collapsing `//` to `/` would false-positive or false-reject;
			// the oracle bails on this shape and lets the path through
			// silently. JavaRosa resolves it at runtime against the data
			// tree; we don't second-guess that here.
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="/data//foo"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toEqual([]);
		});

		it("resolves a path that terminates in a predicate (no trailing step)", () => {
			// `/data/items[count(.) > 0]` — the path ends at the predicate.
			// The outermost AST node is Filtered, not Child. The oracle
			// still resolves the path to `/data/items` and checks the
			// data tree.
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="/data/nonexistent_items[count(.) > 0]"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("BINDING_RESOLUTION_FORM_PATH_MISSING");
			expect(errors[0].message).toContain("/data/nonexistent_items");
		});

		it("resolves segments past a predicate (path continues through Filtered)", () => {
			// `/data/items[count(.) > 0]/x` — the predicate is walked
			// independently; the path the oracle resolves is `/data/items/x`.
			// Without Filtered descent, only `/data/items` would resolve and
			// the typo on the post-predicate segment would slip through.
			const xml = makeForm(
				`<bind nodeset="/data/result" calculate="/data/items[count(.) > 0]/nonexistent_step"/>`,
				`<items><x/></items><result/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			const codes = errors.map((e) => e.code);
			expect(codes).toContain("BINDING_RESOLUTION_FORM_PATH_MISSING");
			expect(
				errors.some((e) => e.message.includes("/data/items/nonexistent_step")),
			).toBe(true);
		});
	});

	describe("integration — multiple rules in one expression", () => {
		it("flags each independent failure separately", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/missing_datum]/foo + /data/no_such_field"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			const codes = errors.map((e) => e.code).sort();
			expect(codes).toEqual([
				"BINDING_RESOLUTION_FORM_PATH_MISSING",
				"BINDING_RESOLUTION_INSTANCE_UNDECLARED",
				"BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
			]);
		});

		it("returns no errors when every reference resolves cleanly", () => {
			const xml = `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">
<h:head><h:title>t</h:title><model>
<instance><data xmlns="" id="t"><x/><y/></data></instance>
<instance src="jr://instance/casedb" id="casedb"/>
<instance src="jr://instance/session" id="commcaresession"/>
<bind nodeset="/data/x" calculate="instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/foo"/>
<bind nodeset="/data/y" calculate="/data/x + instance('commcaresession')/session/context/username"/>
</model></h:head><h:body/></h:html>`;
			const errors = validateBindingResolution(
				xml,
				"f",
				"m",
				new Set(["case_id"]),
			);
			expect(errors).toEqual([]);
		});
	});

	describe("graceful handling", () => {
		it("returns the parse-error fatal when the XML is malformed", () => {
			const errors = validateBindingResolution(
				"<not-xform",
				"f",
				"m",
				new Set(),
			);
			expect(errors).toHaveLength(1);
			expect(errors[0].code).toBe("XFORM_PARSE_ERROR");
		});

		it("returns no errors for an XForm with no expression surfaces", () => {
			const xml = makeForm(``, `<x/>`);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			expect(errors).toEqual([]);
		});

		it("contributes nothing for an unparseable expression — the parse-time oracle owns that failure mode", () => {
			const xml = makeForm(
				`<bind nodeset="/data/x" calculate="this is not valid xpath !!!"/>`,
				`<x/>`,
			);
			const errors = validateBindingResolution(xml, "f", "m", new Set());
			// We don't flag bad XPath here (that's xformOracle's job). Any
			// references the Lezer parser CAN extract still get checked.
			expect(
				errors.every(
					(e) => e.code !== "BINDING_RESOLUTION_SESSION_DATUM_UNDECLARED",
				),
			).toBe(true);
		});
	});
});
