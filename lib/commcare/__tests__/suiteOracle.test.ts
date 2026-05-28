/**
 * Unit tests for the suite.xml oracle (`validator/suiteOracle.ts`).
 *
 * Each test pins one invariant against a hand-built suite-XML fragment — a
 * minimal clean suite that the corresponding check passes, and a mutated copy
 * that trips exactly the check under test. The fragments are deliberately small
 * (not full compiler output) so a failing assertion points at one check, not a
 * tangle. The property fuzzer (`suiteOracle.fuzz.test.ts`) covers the
 * emitter-output side; these cover the oracle's own logic.
 *
 * The Core contract each check mirrors is cited in `suiteOracle.ts` by
 * `file::symbol`; the test names restate the device-visible symptom.
 */

import { describe, expect, it } from "vitest";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";

// ── Fixture builder ────────────────────────────────────────────────

/**
 * Wrap suite body fragments in a minimal `<suite version="1">` shell. Each test
 * passes only the elements it exercises, keeping fixtures tight.
 */
function suite(body: string): string {
	return `<?xml version="1.0"?>\n<suite version="1">\n${body}\n</suite>`;
}

/** The locale ids a canonical minimal suite registers. */
const BASE_LOCALES = new Set([
	"forms.m0f0",
	"modules.m0",
	"m0.case_short.case_name_1.header",
]);

/** Pull just the error codes for terse assertions. */
function codes(
	errors: ReturnType<typeof validateSuite>,
): ValidationErrorCode[] {
	return errors.map((e) => e.code);
}

// A clean, fully-resolved minimal suite: one module, one case-loading entry,
// one detail it references, one menu pointing at the entry's command. Every
// cross-reference resolves; every locale is registered. This is the baseline
// the failing fixtures mutate.
const CLEAN_SUITE = suite(`  <detail id="m0_case_short">
    <title><text><locale id="cchq.case"/></text></title>
    <field>
      <header><text><locale id="m0.case_short.case_name_1.header"/></text></header>
      <template><text><xpath function="name"/></text></template>
      <sort type="string" order="1" direction="ascending"><text><xpath function="name"/></text></sort>
    </field>
  </detail>
  <entry>
    <form>http://example.org/form</form>
    <command id="m0-f0"><text><locale id="forms.m0f0"/></text></command>
    <instance id="casedb" src="jr://instance/casedb"/>
    <session>
      <datum id="case_id" nodeset="instance('casedb')/casedb/case[@case_type='patient']" value="./@case_id" detail-select="m0_case_short"/>
    </session>
  </entry>
  <menu id="m0"><text><locale id="modules.m0"/></text><command id="m0-f0"/></menu>`);

describe("suite oracle — clean baseline", () => {
	it("a fully-resolved minimal suite passes clean", () => {
		expect(validateSuite(CLEAN_SUITE, BASE_LOCALES)).toEqual([]);
	});
});

// ── Strict XML / root gates ────────────────────────────────────────

describe("suite oracle — structural gates", () => {
	it("flags malformed XML", () => {
		expect(codes(validateSuite("<suite><detail></suite>", new Set()))).toEqual([
			"SUITE_PARSE_ERROR",
		]);
	});

	it("flags a document with no <suite> root", () => {
		expect(
			codes(validateSuite('<?xml version="1.0"?>\n<other/>', new Set())),
		).toEqual(["SUITE_NO_SUITE_ELEMENT"]);
	});

	it("flags a non-integer suite version", () => {
		const xml = '<?xml version="1.0"?>\n<suite version="1.5"></suite>';
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_VERSION_NOT_INTEGER",
		);
	});
});

// ── Category 1 — datum value/nodeset ───────────────────────────────

describe("suite oracle — datum value/nodeset (C1-1/C1-2/C2-8)", () => {
	// SESSION entity datum: nodeset REQUIRED (SessionDatumParser throws
	// "Expected @nodeset…" when absent); value OPTIONAL but PATH-when-present.
	it("flags a session entity datum with no nodeset", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" value="./@case_id"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DATUM_NO_NODESET",
		);
	});

	it("does NOT require a value on a session entity datum (value is optional in Core)", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="instance('casedb')/casedb/case"/></session></entry>`,
		);
		const result = codes(validateSuite(xml, BASE_LOCALES));
		expect(result).not.toContain("SUITE_DATUM_NO_VALUE");
		expect(result).not.toContain("SUITE_DATUM_NO_NODESET");
	});

	it("flags a non-path session datum value (PATH when present)", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="instance('casedb')/casedb/case" value="count(/x)"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DATUM_NON_PATH_VALUE",
		);
	});

	it("flags a non-path session datum nodeset", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="1 + 1" value="./@x"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DATUM_NON_PATH_NODESET",
		);
	});

	it("accepts a path session datum value + nodeset", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="instance('casedb')/casedb/case" value="./@case_id"/></session></entry>`,
		);
		expect(validateSuite(xml, BASE_LOCALES)).toEqual([]);
	});

	// A `<datum function=…>` (ComputedDatum) requires neither nodeset nor value.
	it("accepts a computed datum with neither nodeset nor value", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" function="concat('a','b')"/></session></entry>`,
		);
		const result = codes(validateSuite(xml, BASE_LOCALES));
		expect(result).not.toContain("SUITE_DATUM_NO_NODESET");
		expect(result).not.toContain("SUITE_DATUM_NO_VALUE");
	});

	// STACK-FRAME datum (inside <create>/<push>): value REQUIRED, ANY-XPath
	// (StackFrameStepParser parses through XPathParseTool, not getPathExpr).
	it("flags a stack-frame datum with no value", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><create><command value="'m0'"/><datum id="case_id"/></create></stack></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DATUM_NO_VALUE",
		);
	});

	it("accepts a stack-frame datum whose value is any (non-path) XPath", () => {
		// A stack datum's value is parsed as any XPath, so a non-path expression
		// is fine here (unlike a session entity datum's value).
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><create><command value="'m0'"/><datum id="case_id" value="instance('commcaresession')/session/data/case_id"/></create></stack></entry>`,
		);
		const result = codes(validateSuite(xml, BASE_LOCALES));
		expect(result).not.toContain("SUITE_DATUM_NO_VALUE");
		expect(result).not.toContain("SUITE_DATUM_NON_PATH_VALUE");
	});

	it("flags an unparseable stack-frame datum value", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><create><command value="'m0'"/><datum id="case_id" value="not(broken("/></create></stack></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DATUM_NON_PATH_VALUE",
		);
	});
});

// ── Category 1 — detail structure ──────────────────────────────────

describe("suite oracle — detail structure (C1-8/9/10)", () => {
	it("flags a detail with no <title>", () => {
		const xml = suite(
			`  <detail id="d"><field><header><text/></header><template><text/></template></field></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_DETAIL_NO_TITLE",
		);
	});

	it("flags a field with no <header>", () => {
		const xml = suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title><field><template><text/></template></field></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_FIELD_NO_HEADER",
		);
	});

	it("flags a field with no <template>", () => {
		const xml = suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header></field></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_FIELD_NO_TEMPLATE",
		);
	});

	it("accepts a complete detail", () => {
		const xml = suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text/></template></field></detail>`,
		);
		expect(validateSuite(xml, new Set())).toEqual([]);
	});
});

// ── Category 1 — entry / remote-request / query / post ─────────────

describe("suite oracle — entry/remote-request/query/post (C1-3..7/16)", () => {
	it("flags an entry with no display text", () => {
		const xml = suite(`  <entry><form>x</form></entry>`);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_ENTRY_NO_DISPLAY",
		);
	});

	it("flags a remote-request with no <post>", () => {
		const xml = suite(
			`  <remote-request><command id="s"><display><text><locale id="cs"/></text></display></command></remote-request>`,
		);
		expect(codes(validateSuite(xml, new Set(["cs"])))).toContain(
			"SUITE_REMOTE_REQUEST_NO_POST",
		);
	});

	it("flags a <post> with no url", () => {
		const xml = suite(
			`  <remote-request><post><data key="case_id" ref="x"/></post><command id="s"><display><text><locale id="cs"/></text></display></command></remote-request>`,
		);
		expect(codes(validateSuite(xml, new Set(["cs"])))).toContain(
			"SUITE_POST_NO_URL",
		);
	});

	it("flags a <query> with no url and no storage-instance", () => {
		const xml = suite(
			`  <query template="case"><title><text/></title></query>`,
		);
		const result = codes(validateSuite(xml, new Set()));
		expect(result).toContain("SUITE_QUERY_NO_URL");
		expect(result).toContain("SUITE_QUERY_NO_STORAGE_INSTANCE");
	});

	it("flags an unparseable <post relevant>", () => {
		const xml = suite(
			`  <remote-request><post url="http://x" relevant="not(broken("><data key="c" ref="x"/></post><command id="s"><display><text><locale id="cs"/></text></display></command></remote-request>`,
		);
		expect(codes(validateSuite(xml, new Set(["cs"])))).toContain(
			"SUITE_INVALID_XPATH",
		);
	});
});

// ── Category 1 — prompts ───────────────────────────────────────────

describe("suite oracle — prompts (C1-17)", () => {
	it("flags a prompt with no key", () => {
		const xml = suite(
			`  <query url="http://x" storage-instance="results" template="case"><prompt><display><text/></display></prompt></query>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_PROMPT_NO_KEY",
		);
	});

	it("flags duplicate prompt keys in one query", () => {
		const xml = suite(
			`  <query url="http://x" storage-instance="results" template="case"><prompt key="age"><display><text/></display></prompt><prompt key="age"><display><text/></display></prompt></query>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_PROMPT_DUPLICATE_KEY",
		);
	});

	it("accepts distinct prompt keys", () => {
		const xml = suite(
			`  <query url="http://x" storage-instance="results" template="case"><prompt key="age"><display><text/></display></prompt><prompt key="name"><display><text/></display></prompt></query>`,
		);
		expect(codes(validateSuite(xml, new Set()))).not.toContain(
			"SUITE_PROMPT_DUPLICATE_KEY",
		);
	});
});

// ── Category 1 — stack ops ─────────────────────────────────────────

describe("suite oracle — stack ops (C1-19)", () => {
	it("flags a non-enum stack op tag", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><frobnicate/></stack></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_STACK_BAD_OP",
		);
	});

	it("accepts create/push/clear", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><create><command value="'m0'"/></create><clear/></stack></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_STACK_BAD_OP",
		);
	});
});

// ── Category 1 — XPath validity sweep ──────────────────────────────

describe("suite oracle — XPath validity (C1-11/12/24)", () => {
	it("flags an unparseable <xpath function>", () => {
		const xml = suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text><xpath function="not(broken("/></text></template></field></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_INVALID_XPATH",
		);
	});

	it("flags an unparseable stack-op if condition", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><stack><create if="not(*"><command value="'m0'"/></create></stack></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_INVALID_XPATH",
		);
	});

	it("flags a non-path <data nodeset> (C1-14)", () => {
		const xml = suite(
			`  <query url="http://x" storage-instance="results" template="case"><data key="k" ref="instance('x')/x" nodeset="1 + 1"/></query>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_NON_PATH_XPATH",
		);
	});
});

// ── Category 1 — query <data> contract ─────────────────────────────

describe("suite oracle — query <data> (C1-13/14, QueryDataParser)", () => {
	const queryWith = (data: string) =>
		suite(
			`  <query url="http://x" storage-instance="results" template="case">${data}</query>`,
		);

	it("flags a <data> with no ref", () => {
		expect(
			codes(validateSuite(queryWith(`<data key="k"/>`), new Set())),
		).toContain("SUITE_DATA_NO_REF");
	});

	it("requires ref to be a PATH when a nodeset is also present (dual-path)", () => {
		// ListQueryData routes BOTH ref and nodeset through getPathExpr — a
		// non-path ref alongside a nodeset is a parse failure.
		expect(
			codes(
				validateSuite(
					queryWith(
						`<data key="k" ref="count(/x)" nodeset="instance('casedb')/casedb/case"/>`,
					),
					new Set(),
				),
			),
		).toContain("SUITE_DATA_NON_PATH_REF");
	});

	it("allows a non-path ref when no nodeset is present (ValueQueryData)", () => {
		// Without a nodeset the ref need only parse as XPath — a function call is
		// fine (it's a value-query data slot, e.g. `_xpath_query`).
		const result = codes(
			validateSuite(
				queryWith(`<data key="_xpath_query" ref="concat('a','b')"/>`),
				new Set(),
			),
		);
		expect(result).not.toContain("SUITE_DATA_NON_PATH_REF");
		expect(result).not.toContain("SUITE_INVALID_XPATH");
	});

	it("flags an unparseable value-query ref", () => {
		expect(
			codes(
				validateSuite(
					queryWith(`<data key="k" ref="not(broken("/>`),
					new Set(),
				),
			),
		).toContain("SUITE_INVALID_XPATH");
	});

	it("flags an unparseable <data exclude>", () => {
		expect(
			codes(
				validateSuite(
					queryWith(`<data key="k" ref="'v'" exclude="not(broken("/>`),
					new Set(),
				),
			),
		).toContain("SUITE_INVALID_XPATH");
	});

	it("accepts a well-formed value-query <data> with an exclude filter", () => {
		expect(
			validateSuite(
				queryWith(`<data key="case_type" ref="'patient'" exclude="false()"/>`),
				new Set(),
			),
		).toEqual([]);
	});
});

// ── Category 2 — id uniqueness ─────────────────────────────────────

describe("suite oracle — id uniqueness (C2-9/C2-10)", () => {
	it("flags a duplicate command id across entries", () => {
		const xml = suite(
			`  <entry><command id="dup"><text><locale id="forms.m0f0"/></text></command></entry>\n  <entry><command id="dup"><text><locale id="forms.m0f0"/></text></command></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DUPLICATE_COMMAND",
		);
	});

	it("flags a duplicate detail id", () => {
		const xml = suite(
			`  <detail id="dup"><title><text/></title></detail>\n  <detail id="dup"><title><text/></title></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).toContain(
			"SUITE_DUPLICATE_DETAIL",
		);
	});
});

// ── Category 2 — menu→command resolution ───────────────────────────

describe("suite oracle — menu→command (C2-1)", () => {
	it("flags a menu command that resolves to no entry", () => {
		const xml = suite(
			`  <entry><command id="real"><text><locale id="forms.m0f0"/></text></command></entry>\n  <menu id="m0"><text><locale id="modules.m0"/></text><command id="ghost"/></menu>`,
		);
		const errors = validateSuite(xml, BASE_LOCALES);
		expect(codes(errors)).toContain("SUITE_MENU_COMMAND_UNRESOLVED");
		// The finding names the offending menu so triage knows where to look.
		const menuErr = errors.find(
			(e) => e.code === "SUITE_MENU_COMMAND_UNRESOLVED",
		);
		expect(menuErr?.location.moduleName).toBe("m0");
	});

	it("resolves a menu command pointing at a remote-request command", () => {
		const xml = suite(
			`  <remote-request><post url="http://x"><data key="c" ref="x"/></post><command id="search_command.m0"><display><text><locale id="cs"/></text></display></command></remote-request>\n  <menu id="m0"><text><locale id="modules.m0"/></text><command id="search_command.m0"/></menu>`,
		);
		expect(
			codes(validateSuite(xml, new Set(["cs", "modules.m0"]))),
		).not.toContain("SUITE_MENU_COMMAND_UNRESOLVED");
	});
});

// ── Category 2 — detail-select / detail-confirm ────────────────────

describe("suite oracle — detail-select/confirm (C2-2/C2-3)", () => {
	it("flags a dangling detail-select", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" value="./@case_id" detail-select="ghost"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DETAIL_SELECT_UNRESOLVED",
		);
	});

	it("flags a dangling detail-confirm", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" value="./@case_id" detail-confirm="ghost"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DETAIL_CONFIRM_UNRESOLVED",
		);
	});

	it("resolves detail-select to a present detail", () => {
		const xml = suite(
			`  <detail id="m0_case_short"><title><text><locale id="cchq.case"/></text></title></detail>\n  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" value="./@case_id" detail-select="m0_case_short"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_DETAIL_SELECT_UNRESOLVED",
		);
	});
});

// ── Category 2 — instance resolution ───────────────────────────────

describe("suite oracle — instance resolution (C2-4/C2-5)", () => {
	it("flags an undeclared instance reference in an entry datum", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="instance('lookup')/lookup/x" value="./@id"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("accepts a runtime-provided instance with no declaration", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="d" nodeset="instance('casedb')/casedb/case" value="./@case_id"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("accepts an explicitly-declared instance", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><instance id="lookup" src="jr://fixture/lookup"/><session><datum id="d" nodeset="instance('lookup')/lookup/x" value="./@id"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("flags a duplicate instance declaration on one entry", () => {
		const xml = suite(
			`  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><instance id="x" src="a"/><instance id="x" src="b"/></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_DUPLICATE_INSTANCE",
		);
	});

	it("flags a detail xpath referencing an instance its loading entry doesn't declare", () => {
		// The entry LOADS the detail (detail-select) but declares no `lookup`
		// instance, so the detail's ref can't resolve when rendered from it.
		const xml = suite(
			`  <detail id="d_short"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text><xpath function="instance('lookup')/lookup/x"/></text></template></field></detail>\n  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><session><datum id="case_id" nodeset="instance('casedb')/casedb/case" value="./@case_id" detail-select="d_short"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("resolves a detail instance ref declared on the entry that loads it", () => {
		const xml = suite(
			`  <detail id="d_short"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text><xpath function="instance('lookup')/lookup/x"/></text></template></field></detail>\n  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command><instance id="lookup" src="jr://fixture/lookup"/><session><datum id="case_id" nodeset="instance('casedb')/casedb/case" value="./@case_id" detail-select="d_short"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("requires a detail ref to resolve in EVERY loading entry (intersection, not union)", () => {
		// Two entries load `d_short`. Entry A declares `lookup`, entry B does not.
		// The detail's `instance('lookup')` ref resolves from A but NOT from B, so
		// the per-referrer intersection must flag it — a union over all entries
		// would wrongly accept it.
		const xml = suite(
			`  <detail id="d_short"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text><xpath function="instance('lookup')/lookup/x"/></text></template></field></detail>
  <entry><command id="a"><text><locale id="forms.m0f0"/></text></command><instance id="lookup" src="jr://fixture/lookup"/><session><datum id="case_id" nodeset="instance('casedb')/casedb/case" value="./@case_id" detail-select="d_short"/></session></entry>
  <entry><command id="b"><text><locale id="forms.m0f0"/></text></command><session><datum id="case_id" nodeset="instance('casedb')/casedb/case" value="./@case_id" detail-select="d_short"/></session></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});

	it("skips an orphaned detail (no entry loads it) rather than false-flagging its refs", () => {
		// A detail no entry references has no scope to resolve against. It must be
		// skipped, not checked against the runtime-only set (which would flag the
		// non-runtime `lookup` ref).
		const xml = suite(
			`  <detail id="d_short"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text><xpath function="instance('lookup')/lookup/x"/></text></template></field></detail>\n  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command></entry>`,
		);
		expect(codes(validateSuite(xml, BASE_LOCALES))).not.toContain(
			"SUITE_MISSING_INSTANCE",
		);
	});
});

// ── Category 2 — locale resolution ─────────────────────────────────

describe("suite oracle — locale resolution (C2-6)", () => {
	it("flags a locale id with no app_strings entry", () => {
		const xml = suite(
			`  <menu id="m0"><text><locale id="modules.m0"/></text><command id="c"/></menu>\n  <entry><command id="c"><text><locale id="forms.m0f0"/></text></command></entry>`,
		);
		// modules.m0 unregistered; forms.m0f0 registered.
		expect(codes(validateSuite(xml, new Set(["forms.m0f0"])))).toContain(
			"SUITE_MISSING_LOCALE",
		);
	});

	it("accepts the built-in cchq.case locale unregistered", () => {
		const xml = suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title></detail>`,
		);
		expect(codes(validateSuite(xml, new Set()))).not.toContain(
			"SUITE_MISSING_LOCALE",
		);
	});
});

// ── Sort — silently tolerated ──────────────────────────────────────

describe("suite oracle — sort attributes (silently tolerated by device)", () => {
	const sortField = (sortAttrs: string) =>
		suite(
			`  <detail id="d"><title><text><locale id="cchq.case"/></text></title><field><header><text/></header><template><text/></template><sort ${sortAttrs}><text><xpath function="name"/></text></sort></field></detail>`,
		);

	it("flags a non-integer sort order", () => {
		expect(
			codes(validateSuite(sortField('order="x" type="string"'), new Set())),
		).toContain("SUITE_SORT_BAD_ORDER");
	});

	it("flags a bad sort direction", () => {
		expect(
			codes(validateSuite(sortField('order="1" direction="up"'), new Set())),
		).toContain("SUITE_SORT_BAD_DIRECTION");
	});

	it("flags a bad sort type", () => {
		expect(
			codes(validateSuite(sortField('order="1" type="banana"'), new Set())),
		).toContain("SUITE_SORT_BAD_TYPE");
	});

	it("flags a bad sort blanks preference", () => {
		expect(
			codes(validateSuite(sortField('order="1" blanks="middle"'), new Set())),
		).toContain("SUITE_SORT_BAD_BLANKS");
	});

	it("accepts a fully-valid sort block", () => {
		expect(
			validateSuite(
				sortField(
					'type="string" order="1" direction="ascending" blanks="last"',
				),
				new Set(),
			),
		).toEqual([]);
	});
});

// ── Media wire-path resolution ─────────────────────────────────────

describe("suite oracle — media wire-path resolution", () => {
	const MENU_LOCALE_ID = "modules.m0.icon";
	const ICON_PATH = "commcare/aaaa.png";
	const ICON_REF = `jr://file/${ICON_PATH}`;

	/** A minimal suite carrying one menu-borne `<text form="image">` locale
	 *  reference. The locale id is registered in app_strings (so the locale-
	 *  resolution check is happy); the media check resolves the value. */
	const MENU_ICON_SUITE = suite(`  <menu id="m0">
    <display>
      <text><locale id="modules.m0"/></text>
      <text form="image"><locale id="${MENU_LOCALE_ID}"/></text>
    </display>
  </menu>`);

	const MENU_APP_STRING_KEYS = new Set(["modules.m0", MENU_LOCALE_ID]);
	const MENU_APP_STRING_VALUES = new Map([
		["modules.m0", "Module zero"],
		[MENU_LOCALE_ID, ICON_REF],
	]);

	it("passes when the menu locale's jr:// value resolves to a manifest entry", () => {
		expect(
			validateSuite(MENU_ICON_SUITE, MENU_APP_STRING_KEYS, {
				appStringValues: MENU_APP_STRING_VALUES,
				manifest: new Set([ICON_PATH]),
			}),
		).toEqual([]);
	});

	it("flags a menu locale jr:// value with no manifest entry (SUITE_DANGLING_MEDIA_REF)", () => {
		const errors = validateSuite(MENU_ICON_SUITE, MENU_APP_STRING_KEYS, {
			appStringValues: MENU_APP_STRING_VALUES,
			manifest: new Set<string>(),
		});
		expect(
			errors.some(
				(e) =>
					e.code === "SUITE_DANGLING_MEDIA_REF" &&
					e.message.includes(ICON_PATH),
			),
		).toBe(true);
	});

	it("skips the media check when no media context is supplied", () => {
		// The locale resolution still runs (passes — both ids are registered);
		// the media check short-circuits, so no SUITE_DANGLING_MEDIA_REF surfaces
		// even though the manifest would have nothing in it.
		expect(validateSuite(MENU_ICON_SUITE, MENU_APP_STRING_KEYS)).toEqual([]);
	});

	const IMAGE_MAP_PATH_A = "commcare/bbbb.png";
	const IMAGE_MAP_PATH_B = "commcare/cccc.png";
	const IMAGE_MAP_SUITE = suite(`  <detail id="m0_case_short">
    <title><text><locale id="cchq.case"/></text></title>
    <field>
      <header><text><locale id="m0.case_short.icon_1.header"/></text></header>
      <template form="image"><text><xpath function="if(selected(status, 'a'), 'jr://file/${IMAGE_MAP_PATH_A}', if(selected(status, 'b'), 'jr://file/${IMAGE_MAP_PATH_B}', ''))"/></text></template>
    </field>
  </detail>`);

	const IMAGE_MAP_APP_STRINGS = new Set(["m0.case_short.icon_1.header"]);

	it("passes when image-map jr:// literals all resolve to manifest entries", () => {
		expect(
			validateSuite(IMAGE_MAP_SUITE, IMAGE_MAP_APP_STRINGS, {
				appStringValues: new Map(),
				manifest: new Set([IMAGE_MAP_PATH_A, IMAGE_MAP_PATH_B]),
			}),
		).toEqual([]);
	});

	it("flags an image-map jr:// literal with no manifest entry (SUITE_DANGLING_MEDIA_REF)", () => {
		const errors = validateSuite(IMAGE_MAP_SUITE, IMAGE_MAP_APP_STRINGS, {
			appStringValues: new Map(),
			// Only the first wire path is in the manifest; the second dangles.
			manifest: new Set([IMAGE_MAP_PATH_A]),
		});
		expect(
			errors.some(
				(e) =>
					e.code === "SUITE_DANGLING_MEDIA_REF" &&
					e.message.includes(IMAGE_MAP_PATH_B),
			),
		).toBe(true);
		// Only the second path dangles, not the first.
		expect(
			errors.some(
				(e) =>
					e.code === "SUITE_DANGLING_MEDIA_REF" &&
					e.message.includes(IMAGE_MAP_PATH_A),
			),
		).toBe(false);
	});
});
