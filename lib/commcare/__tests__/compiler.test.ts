import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { asUuid } from "@/lib/domain";

// The compiler consumes the domain doc directly — we build the fixture
// via the shared DSL, expand it to HQ JSON with `expandDoc`, and feed
// both into `compileCcz`. Tests below assert archive-level invariants
// (present files, case-block injection, suite.xml structure).
const doc = buildDoc({
	appName: "CHW App",
	modules: [
		{
			name: "Patients",
			caseType: "patient",
			caseListConfig: caseListConfig([{ field: "age", header: "Age" }]),
			forms: [
				{
					name: "Register",
					type: "registration",
					fields: [
						f({
							kind: "text",
							id: "case_name",
							label: "Name",
							case_property_on: "patient",
						}),
						f({
							kind: "int",
							id: "age",
							label: "Age",
							case_property_on: "patient",
						}),
					],
				},
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({
							kind: "hidden",
							id: "total_visits",
							calculate: "#case/total_visits + 1",
							case_property_on: "patient",
						}),
						f({ kind: "text", id: "notes", label: "Notes" }),
					],
				},
			],
		},
	],
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name" },
				{ name: "age", label: "Age" },
				{ name: "total_visits", label: "Total Visits" },
			],
		},
	],
});

describe("compileCcz", () => {
	it("produces a valid zip with expected files", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const entries = zip
			.getEntries()
			.map((e) => e.entryName)
			.sort();

		expect(entries).toContain("suite.xml");
		expect(entries).toContain("profile.ccpr");
		expect(entries).toContain("default/app_strings.txt");
		// One XForm per form
		expect(
			entries.filter((e) => e.match(/modules-\d+\/forms-\d+\.xml/)),
		).toHaveLength(2);
	});

	it("injects case create block into registration XForms", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");

		expect(regXform).toContain("<create>");
		expect(regXform).toContain("<case_type/>");
		expect(regXform).toContain("<case_name/>");
		// Case-type bind. The serializer emits `'` as `&apos;` inside a
		// double-quoted attribute value (XML-spec-equivalent — both forms
		// decode to a single apostrophe). The same byte shape is what
		// Vellum's own emitter produces; CCHQ's import parser decodes the
		// entity before comparison.
		expect(regXform).toContain(
			`<bind nodeset="/data/case/create/case_type" calculate="&apos;patient&apos;"/>`,
		);
		// The <case> element carries three attributes per CCHQ's
		// XFormCaseBlock.elem: case_id (the session-allocated id),
		// date_modified (close-out timestamp), user_id (who did the work).
		expect(regXform).toContain(
			'<case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2">',
		);
		// The form-side `@case_id` setvalue chains from the suite's
		// case-create session datum. xforms-ready fires once at form
		// load. `instance('commcaresession')` serializes with `&apos;`
		// for the same XML-escaping reason as the case-type bind above.
		expect(regXform).toContain(
			`<setvalue ref="/data/case/@case_id" event="xforms-ready" value="instance(&apos;commcaresession&apos;)/session/data/case_id_new_patient_0"/>`,
		);
		// date_modified and user_id read from the always-on meta block;
		// the meta block's own setvalues + binds were emitted upstream.
		expect(regXform).toContain(
			'<bind nodeset="/data/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>',
		);
		expect(regXform).toContain(
			'<bind nodeset="/data/case/@user_id" calculate="/data/meta/userID"/>',
		);
	});

	it("emits a case-create session datum for registration entries", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const suite = zip.readAsText("suite.xml");
		// CCHQ shape — function="uuid()" mints a fresh id at entry.
		expect(suite).toContain(
			'<datum id="case_id_new_patient_0" function="uuid()"/>',
		);
	});

	it("injects case update block into followup XForms", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const followupXform = zip.readAsText("modules-0/forms-1.xml");

		expect(followupXform).toContain("<update>");
		expect(followupXform).toContain("<total_visits/>");
		expect(followupXform).not.toContain("<create>"); // followup should not create
		// Case-update forms wire `case/@case_id` from the case-loading
		// session datum (`case_id`), not from a uuid() — the case
		// already exists when this form opens. The serializer emits `'`
		// as `&apos;` inside a double-quoted attribute value (XML-spec-
		// equivalent to the literal apostrophe).
		expect(followupXform).toContain(
			`<bind nodeset="/data/case/@case_id" calculate="instance(&apos;commcaresession&apos;)/session/data/case_id"/>`,
		);
		expect(followupXform).toContain(
			'<case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2">',
		);
	});

	it("emits subcase scaffolding with proper case-transaction wiring", () => {
		const subDoc = buildDoc({
			appName: "Subcase",
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								f({
									kind: "text",
									id: "child_name",
									label: "Child name",
									// Case type differs from module type → auto-derived
									// child case creation per Nova's data model rules.
									case_property_on: "child",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "child_name", label: "Child" }],
				},
			],
		});
		const hq = expandDoc(subDoc);
		const buf = compileCcz(hq, "Subcase", subDoc);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");
		const suite = zip.readAsText("suite.xml");

		// Subcase wrapper element exists with the case-transaction
		// namespaced <case> inside.
		expect(regXform).toContain("<subcase_0>");
		expect(regXform).toMatch(
			/<subcase_0>[\s\S]*<case case_id="" date_modified="" user_id="" xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2">/,
		);
		// Subcase case_id reads from the per-subcase session datum
		// (index 1 because the primary case is _0). The serializer emits
		// `'` as `&apos;` inside a double-quoted attribute value (XML-
		// spec-equivalent to the literal apostrophe).
		expect(regXform).toContain(
			`<setvalue ref="/data/subcase_0/case/@case_id" event="xforms-ready" value="instance(&apos;commcaresession&apos;)/session/data/case_id_new_child_1"/>`,
		);
		// Parent index reads from /data/case/@case_id — the same shape
		// works for both registration-with-subcase and followup-with-
		// subcase (the latter's /data/case/@case_id binds to the case-
		// loading datum).
		expect(regXform).toContain(
			'<bind nodeset="/data/subcase_0/case/index/parent" calculate="/data/case/@case_id"/>',
		);
		// Both per-case-create session datums in suite.xml.
		expect(suite).toContain(
			'<datum id="case_id_new_household_0" function="uuid()"/>',
		);
		expect(suite).toContain(
			'<datum id="case_id_new_child_1" function="uuid()"/>',
		);
	});

	it("emits subcase update binds under <subcase_n>/case/update/<prop>", () => {
		// Two non-name properties so `case_properties` is non-empty on the
		// derived subcase — `deriveChildCases` consumes the first as
		// `case_name_field`, the rest land in `case_properties` and produce
		// the `<update>` element + per-prop binds. The bind nodeset must
		// match the actual element path `<subcase_n>/case/update/<prop>`
		// (NOT `<subcase_n>/update/<prop>` — that path doesn't exist and
		// the post-injection XForm oracle would flag XFORM_DANGLING_BIND).
		const subDoc = buildDoc({
			appName: "Subcase Update",
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								f({
									kind: "text",
									id: "child_name",
									label: "Child name",
									case_property_on: "child",
								}),
								f({
									kind: "int",
									id: "child_age",
									label: "Child age",
									case_property_on: "child",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [
						{ name: "child_name", label: "Name" },
						{ name: "child_age", label: "Age" },
					],
				},
			],
		});
		const hq = expandDoc(subDoc);
		const buf = compileCcz(hq, "Subcase Update", subDoc);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");

		// `<update>` block under the subcase's `<case>` carries the
		// derived child property.
		expect(regXform).toMatch(
			/<subcase_0>[\s\S]*<update>[\s\S]*<child_age\/>[\s\S]*<\/update>/,
		);
		// The bind nodeset includes `/case/`, matching the element path.
		expect(regXform).toContain(
			'<bind nodeset="/data/subcase_0/case/update/child_age"',
		);
	});

	it("post-injection validation catches orphaned binds", () => {
		const hq = expandDoc(doc);

		// Sabotage: inject a bind that points to a node we never create.
		const formId = hq.modules[0].forms[0].unique_id;
		const xml = hq._attachments[`${formId}.xml`];
		hq._attachments[`${formId}.xml`] = xml.replace(
			"</model>",
			'      <bind nodeset="/data/meta/location" type="xsd:geopoint"/>\n    </model>',
		);

		expect(() => compileCcz(hq, "CHW App", doc)).toThrow(
			/XForm validation failed[\s\S]*\/data\/meta\/location/,
		);
	});

	it("generates suite.xml with case detail and menu entries", () => {
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const suite = zip.readAsText("suite.xml");

		expect(suite).toContain('<menu id="m0">');
		expect(suite).toContain('<command id="m0-f0"/>');
		expect(suite).toContain('<command id="m0-f1"/>');
		expect(suite).toContain('<detail id="m0_case_short">');
		// Session-datum nodeset interpolates the case-type literal via an
		// XPath single-quoted string; the serializer round-trips that
		// quote as `&apos;` inside the double-quoted `nodeset` attribute.
		expect(suite).toContain("@case_type=&apos;patient&apos;");
	});

	// When a form declares formLinks, the expander emits them into
	// HqForm.form_links and the compiler threads them into the suite-
	// level `<stack>` block: one conditional `<create>` per link plus a
	// fallback whose condition negates every link condition. This test
	// asserts the end-to-end wiring — it doesn't re-assert the per-op
	// shape (session.test covers that at the derivation boundary).
	it("threads form_links into suite.xml as conditional stack frames", () => {
		const moduleUuid = "mod-fl";
		const intakeUuid = "frm-intake";
		const followupUuid = "frm-followup";

		const linkDoc = buildDoc({
			appName: "FL App",
			modules: [
				{
					uuid: moduleUuid,
					name: "M",
					forms: [
						{
							uuid: intakeUuid,
							name: "Intake",
							type: "survey",
							postSubmit: "module",
							formLinks: [
								{
									condition: "/data/refer = 'yes'",
									target: {
										type: "form",
										moduleUuid: asUuid(moduleUuid),
										formUuid: asUuid(followupUuid),
									},
								},
							],
							fields: [f({ kind: "text", id: "refer", label: "Refer?" })],
						},
						{
							uuid: followupUuid,
							name: "Followup",
							type: "survey",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
		});

		const hq = expandDoc(linkDoc);
		const buf = compileCcz(hq, "FL App", linkDoc);
		const zip = new AdmZip(buf);
		const suite = zip.readAsText("suite.xml");

		// The intake form's <entry> has a <stack> with the conditional
		// form-link frame targeting module 0, form 1 (followup). XPath
		// single-quote literals round-trip as `&apos;` inside the
		// double-quoted attribute value the serializer emits.
		expect(suite).toContain(`if="/data/refer = &apos;yes&apos;"`);
		expect(suite).toContain('<command value="&apos;m0&apos;"/>');
		expect(suite).toContain('<command value="&apos;m0-f1&apos;"/>');
		// And a fallback frame firing the 'module' destination when the
		// condition is false.
		expect(suite).toContain(`if="not(/data/refer = &apos;yes&apos;)"`);
	});

	// The compiler must still package a valid archive when a form carries
	// zero fields — this shape appears while the SA is mid-scaffold and a
	// dropped archive would crash the preview + upload path. No case blocks
	// are injected because the form is a survey; only the shell + suite
	// references should appear.
	it("compiles a survey module whose form has zero fields", () => {
		const emptyDoc = buildDoc({
			appName: "Stub",
			modules: [
				{ name: "M", forms: [{ name: "F", type: "survey", fields: [] }] },
			],
		});
		const hq = expandDoc(emptyDoc);
		const buf = compileCcz(hq, "Stub", emptyDoc);
		const zip = new AdmZip(buf);

		// Archive shell is present.
		expect(zip.readAsText("profile.ccpr")).toContain("Stub");
		// Single menu entry with one empty-form command — suite.xml still
		// wires the form even though the XForm body is empty.
		const suite = zip.readAsText("suite.xml");
		expect(suite).toContain('<menu id="m0">');
		expect(suite).toContain('<command id="m0-f0"/>');
		// The form XML is present and structurally empty. With no fields the
		// body has no children, so the serializer renders it self-closing
		// (`<h:body/>` ≡ `<h:body></h:body>`).
		const xform = zip.readAsText("modules-0/forms-0.xml");
		expect(xform).toMatch(/<h:body\s*\/>/);
		expect(xform).not.toMatch(/<bind[^/]*\/>/);
	});
});

/**
 * CCHQ wire-format parity coverage.
 *
 * The tests below hold Nova's emitted XForm case-block subtrees against
 * CommCare HQ's canonical `form_preparation_v2` fixtures. The contract
 * isn't "Nova matches a CCHQ snapshot frozen at test-write time" — it's
 * "Nova matches CCHQ AS IT EXISTS TODAY", so the fixtures are read from
 * the local CCHQ clone at test-run time (this file is locked to a
 * developer who has the clone; CI consumers without the clone skip).
 *
 * Each test models the same form-shape the CCHQ fixture models in
 * Nova's authoring vocabulary, compiles via `compileCcz`, then asserts
 * structural equivalence between the two emitted XForms. "Structural"
 * means: a `<bind>` with the same `nodeset` carries the same attribute
 * set (keys + values that are platform-invariant — case_id wiring,
 * @date_modified / @user_id calculate refs, namespace attributes); a
 * `<setvalue>` keyed by `ref + event` exists in both. Path-bound binds
 * like `/data/case/create/case_name` are present in both but their
 * `calculate` value differs because Nova picks different question paths
 * than CCHQ's fixture (Nova uses the field's `id`, CCHQ's fixture uses
 * `question1`). We assert presence + that `calculate` is non-empty, not
 * value equality.
 *
 * Why not full-file equality: every emitter carries its own attribute
 * ordering, whitespace rules, optional-attribute defaults, comment
 * conventions, and metadata (uuid namespaces, form titles). A snapshot
 * test would fail on every unrelated change — see Nova compiler.ts
 * emitting `nodeset` before `type` before `calculate` while CCHQ's
 * `multiple_subcase_repeat.xml` emits `calculate` first.
 *
 * Three fixtures are covered:
 *   - `open_case.xml` (A1-A4 case-create primary `<case>` + setvalue
 *     wiring).
 *   - `update_case.xml` (A5-A6 case-update — `@case_id` calculate from
 *     the case-loading session datum).
 *   - `subcase-parent-ref.xml` (A9-A11 subcase scaffolding at the data
 *     root — `<subcase_0>` wrapping a cx2-namespaced `<case>`, parent-
 *     index bind reading `/data/case/@case_id`).
 *
 * The remaining CCHQ fixtures named in the task aren't covered by a
 * positive parity test:
 *   - `multiple_subcase_repeat.xml` — Nova's repeat-context subcase
 *     emission is broken today (the wrapper element splices at the
 *     wrong nesting depth). Surfaced via a divergence pin below.
 *   - `update_parent_case.xml` / `update_attachment_case.xml` /
 *     `update_preload_case.xml` — corresponding emitter behavior
 *     (parent-case updates / case attachments / case-preload
 *     setvalues) is not implemented in Nova. Documented in the
 *     "Known divergences" section.
 */

/** Parsed shape of one XForm's binds, setvalues, and case elements. */
interface ParsedFormXml {
	/** `<bind>` records, keyed by `nodeset`. */
	binds: Map<string, Record<string, string>>;
	/** `<setvalue>` records, keyed by `ref` (event suffixed when present). */
	setvalues: Map<string, Record<string, string>>;
	/**
	 * Every `<case>` element in the data instance, in document order.
	 * Each carries the parent-element path (e.g. `[]` for the primary
	 * case, `["subcase_0"]` for an unconditional subcase, or
	 * `["children", "subcase_0"]` for a repeat-scoped subcase) so a
	 * caller can assert the subcase wrapper structure as well as the
	 * inner attributes.
	 */
	cases: Array<{ parentPath: string[]; attrs: Record<string, string> }>;
}

/**
 * Parse a serialized XForm into a structural index of its binds,
 * setvalues, and `<case>` elements.
 *
 * The walker is intentionally generic — it works against both Nova's
 * and CCHQ's emitted XML without any vendor-specific assumptions about
 * whitespace, attribute order, or comment placement. Two state stacks
 * track context: a tag-name stack to identify `<case>` parents, and a
 * one-shot model-scope flag so we only count `<bind>` / `<setvalue>`
 * elements that live inside the form's `<model>` (avoids picking up
 * unrelated `<bind>` elements that might appear in any future docs
 * embedded inside the form's body).
 */
function parseFormXml(xml: string): ParsedFormXml {
	const binds = new Map<string, Record<string, string>>();
	const setvalues = new Map<string, Record<string, string>>();
	const cases: ParsedFormXml["cases"] = [];

	// Tag name stack — records every open element we're currently
	// inside so we can determine a `<case>` element's parent path.
	const tagStack: string[] = [];
	// Tracks whether we're inside the model. `<bind>` / `<setvalue>`
	// only count when emitted within `<model>` — the form body can
	// legitimately contain neither, but a defensive scope keeps the
	// parser from picking up future authoring shapes that might.
	let modelDepth = 0;
	// Tracks the active `<data>` instance scope inside `<instance>`.
	// The XML namespace `xmlns` attribute appears in both `<instance>`
	// and `<model>` shells, so we count `<case>` elements only when
	// they live inside the data-instance subtree.
	let dataInstanceDepth = 0;

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				tagStack.push(name);
				if (name === "model") modelDepth++;
				// We treat the FIRST `<data>` (under `<instance>`) as the
				// data-instance scope. Both Nova and CCHQ emit a single
				// top-level `<data>`; subsequent `<data>` elements (if any
				// future XForm uses them) would still be scoped under this.
				if (name === "data" && tagStack.includes("instance")) {
					dataInstanceDepth++;
				}

				if (modelDepth > 0 && name === "bind" && attribs.nodeset) {
					binds.set(attribs.nodeset, { ...attribs });
					return;
				}
				if (modelDepth > 0 && name === "setvalue" && attribs.ref) {
					// Key by ref+event so the meta block's
					// `xforms-ready` vs `xforms-revalidate` setvalues
					// don't collide on `/data/meta/timeEnd`.
					const key = attribs.event
						? `${attribs.ref}@${attribs.event}`
						: attribs.ref;
					setvalues.set(key, { ...attribs });
					return;
				}
				if (dataInstanceDepth > 0 && name === "case") {
					// `tagStack` already contains the current `case`
					// element; trim it to derive the parent path. Also
					// drop the outer `data` / `instance` / `model` /
					// `h:head` shell so the path reads as authoring-level
					// nesting (`subcase_0`, `children/subcase_0`, etc.).
					const parentPath = tagStack
						.slice(0, -1)
						.filter(
							(t) =>
								t !== "data" &&
								t !== "instance" &&
								t !== "model" &&
								t !== "h:head" &&
								t !== "head" &&
								t !== "h:html" &&
								t !== "html",
						);
					cases.push({ parentPath, attrs: { ...attribs } });
				}
			},
			onclosetag(name) {
				if (name === "model") modelDepth--;
				if (name === "data" && dataInstanceDepth > 0) {
					dataInstanceDepth--;
				}
				tagStack.pop();
			},
		},
		{ xmlMode: true },
	);
	parser.write(xml);
	parser.end();

	return { binds, setvalues, cases };
}

/**
 * Path to CCHQ's `form_preparation_v2` fixture directory on the local
 * clone. The parity tests + divergence pins below read these fixtures
 * directly so the contract is "Nova matches CCHQ AS IT EXISTS TODAY"
 * — when CCHQ's upstream evolves, the parity tests evolve with it on
 * the next pull rather than against a frozen snapshot.
 *
 * Skip-guard rationale: the local-clone path is contributor-machine
 * convention, not a build artifact. CI runners + fresh contributor
 * clones don't have the directory. Without a skip guard the
 * `readFileSync` in `readCchqFixture` throws ENOENT during test
 * discovery and fails the entire suite — including the `pre-push`
 * async-leak gate that runs the full suite under `--detect-async-leaks`.
 * `describe.skipIf(!HAS_CCHQ_FIXTURES)` keeps the contract local to
 * developers who maintain the parity tests; everyone else gets a
 * green run.
 */
const CCHQ_FIXTURES = join(
	homedir(),
	"code/commcare-hq/corehq/apps/app_manager/tests/data/form_preparation_v2",
);
const HAS_CCHQ_FIXTURES = existsSync(CCHQ_FIXTURES);

/** Read a CCHQ form-preparation fixture as a string. */
function readCchqFixture(name: string): string {
	return readFileSync(join(CCHQ_FIXTURES, name), "utf-8");
}

describe.skipIf(!HAS_CCHQ_FIXTURES)("CCHQ fixture parity", () => {
	/**
	 * Reference fixture: `open_case.xml` — the canonical CCHQ shape for
	 * a registration form opening a case. Holds Nova's case-create
	 * scaffolding (A1-A4) against the contract `XFormCaseBlock.elem` +
	 * `XFormCaseBlock.add_create_block` in `commcare-hq/.../app_manager
	 * /xform.py` emit at server-side post-process time.
	 */
	it("open_case.xml — primary <case> element + case-create wiring match", () => {
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Patients",
					caseType: "test_case_type",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "test_case_type",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "test_case_type",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});

		const novaCcz = compileCcz(expandDoc(novaDoc), "Parity", novaDoc);
		const novaForm = new AdmZip(novaCcz).readAsText("modules-0/forms-0.xml");

		const cchqForm = readCchqFixture("open_case.xml");
		const nova = parseFormXml(novaForm);
		const cchq = parseFormXml(cchqForm);

		// Primary `<case>` element exists in both and carries the same
		// case-transaction namespace + the three required attributes.
		// `case_id` / `date_modified` / `user_id` are emitted as empty
		// string placeholders; binds populate them at runtime.
		const novaPrimary = nova.cases.find((c) => c.parentPath.length === 0);
		const cchqPrimary = cchq.cases.find((c) => c.parentPath.length === 0);
		expect(novaPrimary).toBeDefined();
		expect(cchqPrimary).toBeDefined();
		expect(novaPrimary?.attrs.xmlns).toBe(cchqPrimary?.attrs.xmlns);
		expect(novaPrimary?.attrs.xmlns).toBe(
			"http://commcarehq.org/case/transaction/v2",
		);
		expect(novaPrimary?.attrs.case_id).toBe("");
		expect(novaPrimary?.attrs.date_modified).toBe("");
		expect(novaPrimary?.attrs.user_id).toBe("");

		// Case-create setvalue wires `@case_id` from the session datum
		// at `xforms-ready`. Both emitters carry the same `ref` + `event`
		// + `value` triple — this is the bind point JavaRosa reads at
		// form-load to seed the new case's id.
		const refKey = "/data/case/@case_id@xforms-ready";
		const novaSetval = nova.setvalues.get(refKey);
		const cchqSetval = cchq.setvalues.get(refKey);
		expect(novaSetval).toBeDefined();
		expect(cchqSetval).toBeDefined();
		expect(novaSetval?.value).toBe(cchqSetval?.value);
		expect(novaSetval?.value).toBe(
			"instance('commcaresession')/session/data/case_id_new_test_case_type_0",
		);

		// @date_modified bind reads from the meta block's timeEnd.
		const dmBind = nova.binds.get("/data/case/@date_modified");
		expect(dmBind).toBeDefined();
		expect(dmBind?.calculate).toBe(
			cchq.binds.get("/data/case/@date_modified")?.calculate,
		);
		expect(dmBind?.calculate).toBe("/data/meta/timeEnd");
		expect(dmBind?.type).toBe("xsd:dateTime");

		// @user_id bind reads from the meta block's userID.
		const uidBind = nova.binds.get("/data/case/@user_id");
		expect(uidBind).toBeDefined();
		expect(uidBind?.calculate).toBe(
			cchq.binds.get("/data/case/@user_id")?.calculate,
		);
		expect(uidBind?.calculate).toBe("/data/meta/userID");

		// case_name + owner_id binds exist on both. Nova's `calculate`
		// references `/data/case_name` (its field id); CCHQ's fixture
		// references `/data/question1`. The path differs by design —
		// assert presence + that the calculate is non-empty.
		expect(nova.binds.has("/data/case/create/case_name")).toBe(true);
		expect(cchq.binds.has("/data/case/create/case_name")).toBe(true);
		expect(
			nova.binds.get("/data/case/create/case_name")?.calculate,
		).toBeTruthy();

		// owner_id calculate is platform-invariant on both: the meta
		// block's userID.
		const novaOwnerId = nova.binds.get("/data/case/create/owner_id");
		const cchqOwnerId = cchq.binds.get("/data/case/create/owner_id");
		expect(novaOwnerId?.calculate).toBe(cchqOwnerId?.calculate);
		expect(novaOwnerId?.calculate).toBe("/data/meta/userID");
	});

	/**
	 * Reference fixture: `update_case.xml` — case-update from a followup
	 * form. Holds Nova's A5-A6 case-update wiring against CCHQ's
	 * `XFormCaseBlock.add_case_updates` contract.
	 */
	it("update_case.xml — case_id wires from the case-loading session datum", () => {
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Patients",
					caseType: "test_case_type",
					caseListConfig: caseListConfig([
						{ field: "question1", header: "Question" },
					]),
					forms: [
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "question1",
									label: "Question",
									case_property_on: "test_case_type",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "test_case_type",
					properties: [{ name: "question1", label: "Question" }],
				},
			],
		});

		const novaCcz = compileCcz(expandDoc(novaDoc), "Parity", novaDoc);
		const novaForm = new AdmZip(novaCcz).readAsText("modules-0/forms-0.xml");
		const cchqForm = readCchqFixture("update_case.xml");
		const nova = parseFormXml(novaForm);
		const cchq = parseFormXml(cchqForm);

		// Primary `<case>` element with the same namespaced attribute
		// triple as the open-case fixture.
		const novaPrimary = nova.cases.find((c) => c.parentPath.length === 0);
		const cchqPrimary = cchq.cases.find((c) => c.parentPath.length === 0);
		expect(novaPrimary?.attrs.xmlns).toBe(cchqPrimary?.attrs.xmlns);
		expect(novaPrimary?.attrs.case_id).toBe("");
		expect(novaPrimary?.attrs.date_modified).toBe("");
		expect(novaPrimary?.attrs.user_id).toBe("");

		// `@case_id` is calculated from the case-loading session datum
		// on case-update forms (NOT setvalue'd from a uuid-mint datum
		// the way case-create does). Both emitters carry the same
		// calculate expression — the case is being loaded, not created.
		const caseIdBind = nova.binds.get("/data/case/@case_id");
		expect(caseIdBind).toBeDefined();
		expect(caseIdBind?.calculate).toBe(
			cchq.binds.get("/data/case/@case_id")?.calculate,
		);
		expect(caseIdBind?.calculate).toBe(
			"instance('commcaresession')/session/data/case_id",
		);
		// No xforms-ready setvalue on the primary case-id for
		// case-update forms (case-create does emit one — that's the
		// difference that drives the dispatch).
		expect(nova.setvalues.has("/data/case/@case_id@xforms-ready")).toBe(false);
		expect(cchq.setvalues.has("/data/case/@case_id@xforms-ready")).toBe(false);

		// @date_modified / @user_id meta-block binds — same shape on
		// both case-create and case-update forms.
		expect(nova.binds.get("/data/case/@date_modified")?.calculate).toBe(
			cchq.binds.get("/data/case/@date_modified")?.calculate,
		);
		expect(nova.binds.get("/data/case/@user_id")?.calculate).toBe(
			cchq.binds.get("/data/case/@user_id")?.calculate,
		);

		// Update bind for the case property exists on both. CCHQ's
		// fixture additionally carries `relevant="count(/data/question1)
		// > 0"`; Nova currently does not emit this guard — see "Known
		// divergences" at the bottom of this file. We assert presence +
		// non-empty calculate here; the divergence test below pins the
		// gap explicitly so a future fix lights it up.
		expect(nova.binds.has("/data/case/update/question1")).toBe(true);
		expect(cchq.binds.has("/data/case/update/question1")).toBe(true);
		expect(
			nova.binds.get("/data/case/update/question1")?.calculate,
		).toBeTruthy();
	});

	/**
	 * Reference fixture: a registration form that opens a subcase at the
	 * data root (NOT inside a repeat). The CCHQ tree has no fixture
	 * using Nova's default `<parent>` index-element name in a non-repeat
	 * subcase shape (every CCHQ non-repeat subcase fixture customizes
	 * the index name), so this test pairs a Nova-side compile with a
	 * structural inspection of the emitted output. The contract this
	 * test pins is CCHQ-identical at the structural level: `<subcase_n>`
	 * wraps a cx2-namespaced `<case>`; `@case_id` is setvalued from the
	 * per-subcase session datum at `xforms-ready`; the parent-index bind
	 * reads from `/data/case/@case_id`. Compare against
	 * `subcase-parent-ref.xml` for the same shape with a customized
	 * index-element name.
	 */
	it("subcase-parent-ref.xml — root-level subcase scaffolding matches", () => {
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								// Field on a different case type at the data
								// root (no enclosing repeat) — derives a
								// root-level subcase.
								f({
									kind: "text",
									id: "child_name",
									label: "Child name",
									case_property_on: "child",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "child_name", label: "Name" }],
				},
			],
		});

		const novaCcz = compileCcz(expandDoc(novaDoc), "Parity", novaDoc);
		const novaForm = new AdmZip(novaCcz).readAsText("modules-0/forms-0.xml");
		const cchqForm = readCchqFixture("subcase-parent-ref.xml");
		const nova = parseFormXml(novaForm);
		const cchq = parseFormXml(cchqForm);

		// Both forms emit one root-level `<case>` (primary) plus one
		// `<subcase_0>`-wrapped `<case>`.
		const novaSubcase = nova.cases.find(
			(c) => c.parentPath.length === 1 && c.parentPath[0] === "subcase_0",
		);
		const cchqSubcase = cchq.cases.find(
			(c) => c.parentPath.length === 1 && c.parentPath[0] === "subcase_0",
		);
		expect(novaSubcase).toBeDefined();
		expect(cchqSubcase).toBeDefined();
		expect(novaSubcase?.attrs.xmlns).toBe(cchqSubcase?.attrs.xmlns);
		expect(novaSubcase?.attrs.xmlns).toBe(
			"http://commcarehq.org/case/transaction/v2",
		);
		expect(novaSubcase?.attrs.case_id).toBe("");
		expect(novaSubcase?.attrs.date_modified).toBe("");
		expect(novaSubcase?.attrs.user_id).toBe("");

		// Subcase `@case_id` setvalue fires at `xforms-ready` from the
		// per-subcase session datum. CCHQ's fixture uses
		// `case_id_new_cc_bihar_pregnancy_1`; Nova's uses
		// `case_id_new_child_1`. The shape is identical: the datum index
		// is 1 because the primary case takes _0 (mirrors CCHQ's
		// `Form.session_var_for_action`). Assert structural shape, not
		// the case-type-suffixed datum id.
		const setvalKey = "/data/subcase_0/case/@case_id@xforms-ready";
		const novaSubSetval = nova.setvalues.get(setvalKey);
		const cchqSubSetval = cchq.setvalues.get(setvalKey);
		expect(novaSubSetval).toBeDefined();
		expect(cchqSubSetval).toBeDefined();
		expect(novaSubSetval?.value).toMatch(
			/^instance\('commcaresession'\)\/session\/data\/case_id_new_[a-z_]+_1$/,
		);
		expect(cchqSubSetval?.value).toMatch(
			/^instance\('commcaresession'\)\/session\/data\/case_id_new_[a-z_]+_1$/,
		);

		// @date_modified / @user_id meta-block binds — same shape as the
		// primary case but scoped to the subcase path. Existence checks
		// on both emitters' binds guard against an `undefined ===
		// undefined` false-pass: a missing bind on either side is a
		// real divergence to surface, not silent agreement.
		const novaSubDm = nova.binds.get("/data/subcase_0/case/@date_modified");
		const cchqSubDm = cchq.binds.get("/data/subcase_0/case/@date_modified");
		expect(novaSubDm).toBeDefined();
		expect(cchqSubDm).toBeDefined();
		expect(novaSubDm?.calculate).toBe(cchqSubDm?.calculate);

		const novaSubUid = nova.binds.get("/data/subcase_0/case/@user_id");
		const cchqSubUid = cchq.binds.get("/data/subcase_0/case/@user_id");
		expect(novaSubUid).toBeDefined();
		expect(cchqSubUid).toBeDefined();
		expect(novaSubUid?.calculate).toBe(cchqSubUid?.calculate);
		expect(novaSubUid?.calculate).toBe("/data/meta/userID");

		// Parent-index bind: Nova always names the index element
		// `parent`, while CCHQ's fixture customized it to `mother_id`.
		// The CALCULATE is invariant on both — the parent's case_id is
		// read off `/data/case/@case_id` (the primary case-create
		// setvalue populates this). Assert the CALCULATE matches via the
		// per-emitter index-element name. The explicit existence checks
		// on both binds guard against an `undefined === undefined`
		// false-pass — a missing index bind on either side is a real
		// divergence to surface, not silent agreement.
		const novaIdxBind = nova.binds.get("/data/subcase_0/case/index/parent");
		const cchqIdxBind = cchq.binds.get("/data/subcase_0/case/index/mother_id");
		expect(novaIdxBind).toBeDefined();
		expect(cchqIdxBind).toBeDefined();
		expect(novaIdxBind?.calculate).toBe(cchqIdxBind?.calculate);
		expect(novaIdxBind?.calculate).toBe("/data/case/@case_id");
	});

	// ============================================================
	// Known divergences (intentionally pinned)
	//
	// The tests below name CCHQ shapes Nova does NOT emit today and
	// surface the gap. They exist so a future implementer who wires
	// the feature can flip the assertion direction (or convert the
	// `expect(...).toBe(undefined)` shape into a positive parity
	// check) in the same change that adds the emission.
	// ============================================================

	/**
	 * CCHQ wraps every case-update bind in `relevant="count(<qPath>) > 0"`
	 * so the case property only updates when the question is answered
	 * — the JavaRosa semantic when the question's data node is absent
	 * at submission time (e.g. a `relevant`-gated question whose
	 * condition evaluates false). Without the guard, the case-update
	 * fires unconditionally with whatever `/data/<id>` evaluates to,
	 * overwriting the existing case property with empty for any
	 * conditionally-hidden field — destroying preserved case data.
	 *
	 * Nova's emission matches CCHQ here. This test pins the parity so
	 * a future refactor that drops the guard regresses on data
	 * preservation across conditional-question flows.
	 */
	it("update_case.xml — case-update binds carry CCHQ's relevant=count() guard", () => {
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Patients",
					caseType: "test_case_type",
					caseListConfig: caseListConfig([
						{ field: "question1", header: "Question" },
					]),
					forms: [
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "question1",
									label: "Question",
									case_property_on: "test_case_type",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "test_case_type",
					properties: [{ name: "question1", label: "Question" }],
				},
			],
		});

		const novaForm = new AdmZip(
			compileCcz(expandDoc(novaDoc), "Parity", novaDoc),
		).readAsText("modules-0/forms-0.xml");
		const cchqForm = readCchqFixture("update_case.xml");
		const nova = parseFormXml(novaForm);
		const cchq = parseFormXml(cchqForm);

		// Both emitters carry the relevant guard on the case-update
		// bind. The exact qPath inside `count(...)` may differ
		// (Nova: `/data/question1`; CCHQ: the same after path-resolve)
		// — assert by shape, not literal byte-equality.
		expect(cchq.binds.get("/data/case/update/question1")?.relevant).toMatch(
			/count\(.+\)\s*>\s*0/,
		);
		expect(nova.binds.get("/data/case/update/question1")?.relevant).toMatch(
			/count\(.+\)\s*>\s*0/,
		);
	});

	/**
	 * CCHQ emits a bare `<update/>` element on every subcase even when
	 * the subcase has zero case properties (see CCHQ's
	 * `multiple_subcase_repeat.xml` — `<update/>` under both subcase
	 * wrappers, source `XFormCaseBlock.update_block`'s memoized
	 * side-effect: the element is appended on first access regardless
	 * of whether properties were ever added). The element is
	 * functionally inert (a receiver iterating `<update>`'s children
	 * does nothing when there are none), but byte-level parity
	 * matters: any future CCHQ-side check that reads "is `<update>`
	 * present?" agrees on every Nova-emitted form.
	 *
	 * Nova's emission matches CCHQ here.
	 */
	it("multiple_subcase_repeat.xml — subcase carries bare <update/> when no properties", () => {
		// CCHQ shows the bare-update pattern under subcase_1's `<case>`
		// element — both subcases in this fixture have `case_properties:
		// {}` in the source JSON yet still emit `<update/>` on the wire.
		const cchqForm = readCchqFixture("multiple_subcase_repeat.xml");
		expect(cchqForm).toMatch(
			/<subcase_1>[\s\S]*<case[^>]*>[\s\S]*<update\s*\/>[\s\S]*<\/case>/,
		);

		// Build a Nova doc with a root-level subcase whose only field
		// becomes the case-name field. `deriveChildCases` picks the
		// first (and only) field in the child bucket as
		// `case_name_field`, leaving `case_properties` empty — exactly
		// the empty-properties shape this divergence test needs.
		// Sibling ids must be unique (CommCare invariant; Nova
		// validates), so the child's field id is `child_name`, not
		// `case_name`.
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Households",
					caseType: "household",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Household name",
									case_property_on: "household",
								}),
								f({
									kind: "text",
									id: "child_name",
									label: "Child name",
									case_property_on: "child",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "child_name", label: "Name" }],
				},
			],
		});

		const novaForm = new AdmZip(
			compileCcz(expandDoc(novaDoc), "Parity", novaDoc),
		).readAsText("modules-0/forms-0.xml");
		// Nova matches CCHQ — the bare `<update/>` appears inside the
		// subcase's `<case>` element even when no properties were
		// authored on the subcase.
		expect(novaForm).toMatch(
			/<subcase_0>[\s\S]*<case[^>]*>[\s\S]*<update\s*\/>[\s\S]*<\/case>[\s\S]*<\/subcase_0>/,
		);
	});

	/**
	 * Repeat-context subcase emission is a CCHQ feature Nova doesn't
	 * yet model. The wire emitter
	 * (`xform/caseBlocks.ts::buildCaseBlocks`) builds bind nodesets
	 * with the repeat-scoped prefix but `addCaseBlocks` always
	 * splices the wrapper element under the form's top-level
	 * `<data>` — the two disagree on the wire path and the post-
	 * injection XForm oracle catches the mismatch as a generator-bug
	 * backstop.
	 *
	 * The user-visible gate is now at the doc layer:
	 * `SUBCASE_IN_REPEAT_NOT_MODELED` in
	 * `validator/rules/form.ts::subcaseInRepeatNotModeled` rejects
	 * the authoring shape before compile. The author sees an
	 * actionable message in the editor with the supported
	 * alternative (move child creation to a followup form, or hoist
	 * the child field out of the repeat for a single subcase per
	 * parent). The compile-time throw is the totality backstop a
	 * future emitter fix will close.
	 *
	 * When the emitter does land — splicing under the repeat-context
	 * parent so CCHQ's `multiple_subcase_repeat.xml` parity is
	 * structural — the validator rule retires and this test gets
	 * flipped to a positive parity assertion.
	 */
	it("repeat-context subcase shape is rejected at the doc layer", () => {
		const novaDoc = buildDoc({
			appName: "Parity",
			modules: [
				{
					name: "Parents",
					caseType: "parent",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Parent name",
									case_property_on: "parent",
								}),
								f({
									kind: "repeat",
									id: "children",
									label: "Children",
									repeat_mode: "user_controlled",
									children: [
										f({
											kind: "text",
											id: "child_name",
											label: "Child name",
											case_property_on: "child1",
										}),
									],
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "parent",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child1",
					properties: [{ name: "child_name", label: "Name" }],
				},
			],
		});

		const errors = runValidation(novaDoc);
		const rejection = errors.find(
			(e) => e.code === "SUBCASE_IN_REPEAT_NOT_MODELED",
		);
		expect(rejection).toBeDefined();
		expect(rejection?.message).toContain("children");
		expect(rejection?.message).toContain("child1");
	});

	/**
	 * Features Nova does not yet emit at all — covered by the read-only
	 * CCHQ fixtures but no corresponding emitter. When the feature
	 * lands, replace these explanatory checks with full parity tests in
	 * the positive section above.
	 *
	 * - `update_parent_case.xml` — case-update form with a derived
	 *   parent-case update (`<parents><parent><case>...</case></parent>
	 *   </parents>`). Nova does not model parent-case updates from a
	 *   followup form; the entire `<parents>` subtree is absent.
	 *
	 * - `update_attachment_case.xml` — case-update form with a media
	 *   field whose value writes through to a case attachment
	 *   (`<bind nodeset="/data/case/attachment/<prop>" relevant="count(
	 *   <qPath>) = 1"/>` + `<bind nodeset=".../@src" calculate="<qPath>"/>`).
	 *   Nova does not emit case attachments today.
	 *
	 * - `update_preload_case.xml` — case-preload setvalues for an
	 *   existing case. Nova has the `case_preload` derivation in
	 *   `deriveCaseConfig.ts` but the compiler does not lower it into
	 *   `<setvalue ref="/data/<prop>" event="xforms-ready" value="
	 *   instance('casedb')/.../@<prop>"/>` setvalues on the form.
	 */
	it("documents unmodeled CCHQ features still under emission gap", () => {
		// Sanity-check: the documentation references real CCHQ fixtures.
		expect(readCchqFixture("update_parent_case.xml")).toContain("<parents>");
		expect(readCchqFixture("update_attachment_case.xml")).toContain(
			"<attachment>",
		);
		expect(readCchqFixture("update_preload_case.xml")).toMatch(
			/setvalue[^>]*event="xforms-ready"[^>]*value="instance\('casedb'\)/,
		);
	});
});
