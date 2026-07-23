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
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	asUuid,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	dateAdd,
	datetimeCoerce,
	eq,
	input,
	literal,
	prop,
	sessionUser,
	term,
	whenInput,
} from "@/lib/domain/predicate";

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
	it("emits module/form relevance with instances in Core's exact scopes", () => {
		const displayDoc = buildDoc({
			appName: "Conditional navigation",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					displayCondition: eq(sessionUser("role"), literal("supervisor")),
					forms: [
						{
							name: "Visit",
							type: "followup",
							displayCondition: eq(prop("patient", "status"), literal("open")),
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "status", label: "Status" }],
				},
			],
		});
		const suiteXml = new AdmZip(
			compileCcz(expandDoc(displayDoc), displayDoc.appName, displayDoc),
		).readAsText("suite.xml");
		const root = parseSuiteXml(suiteXml);
		const menu = findAllByName(root, "menu").find(
			(element) => element.attribs.id === "m0",
		);
		const command = menu && findFirstByName(menu, "command");
		const entry = findFirstByName(root, "entry");
		expect(menu).toBeDefined();
		expect(entry).toBeDefined();
		if (!menu || !entry) return;
		expect(menu?.attribs.relevant).toBe(
			"instance('commcaresession')/session/user/data/role = 'supervisor'",
		);
		expect(command?.attribs.relevant).toBe(
			"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@status = 'open'",
		);
		expect(findAllByName(menu, "instance")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attribs: expect.objectContaining({ id: "commcaresession" }),
				}),
			]),
		);
		const entryInstanceIds = findAllByName(entry, "instance").map(
			(instance) => instance.attribs.id,
		);
		expect(entryInstanceIds).toEqual(
			expect.arrayContaining(["casedb", "commcaresession"]),
		);
	});

	it("keeps legacy input-authored search consistent across HQ JSON and local CCZ", () => {
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a001"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];
		const legacy = buildDoc({
			appName: "Legacy Search",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const hq = expandDoc(legacy);
		expect(hq.modules[0].search_config.title_label).toEqual({ en: "Search" });
		expect(hq.modules[0].search_config.properties).toHaveLength(1);

		const suite = new AdmZip(
			compileCcz(hq, "Legacy Search", legacy),
		).readAsText("suite.xml");
		expect(suite).toContain("<remote-request>");
		expect(suite).toContain('id="m0_search_short"');
		expect(suite).toContain('id="m0_search_long"');
	});

	it("keeps an owner-only rule on a form's local case list without inventing Search", () => {
		const ownerOnly = buildDoc({
			appName: "Owner availability",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: term(literal("owner-a owner-b")),
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
		const hq = expandDoc(ownerOnly);
		const suite = new AdmZip(
			compileCcz(hq, ownerOnly.appName, ownerOnly),
		).readAsText("suite.xml");

		expect(hq.modules[0].case_details.short.filter).toBe(
			"normalize-space('owner-a owner-b') = '' or not(selected(normalize-space('owner-a owner-b'), @owner_id))",
		);
		expect(suite).toContain(
			"[normalize-space(&apos;owner-a owner-b&apos;) = &apos;&apos; or not(selected(normalize-space(&apos;owner-a owner-b&apos;), @owner_id))]",
		);
		expect(suite).not.toContain("<remote-request");
		expect(suite).not.toContain("<action");
	});

	it("emits date-add for an advanced date prompt through HQ JSON and suite CSQL", () => {
		const config = caseListConfig([
			{ field: "last_visit", header: "Last visit" },
		]);
		config.searchInputs = [
			advancedSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a002"),
				"base_date",
				"Starting date",
				"date",
				whenInput(
					input("base_date"),
					eq(
						prop("patient", "last_visit"),
						dateAdd(term(input("base_date")), "days", term(literal(7))),
					),
				),
			),
		];
		const temporalDoc = buildDoc({
			appName: "Temporal Search",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "last_visit",
							label: "Last visit",
							data_type: "date",
						},
					],
				},
			],
		});

		const hq = expandDoc(temporalDoc);
		const hqQuery = hq.modules[0].search_config.default_properties.find(
			(entry) => entry.property === "_xpath_query",
		)?.defaultValue;
		expect(hqQuery).toContain("date-add(");
		expect(hqQuery).not.toContain("datetime-add(");

		const suite = new AdmZip(
			compileCcz(hq, "Temporal Search", temporalDoc),
		).readAsText("suite.xml");
		expect(suite).toContain("date-add(");
		expect(suite).not.toContain("datetime-add(");
	});

	it("exports one-day exact search for date, custom datetime, and indexed metadata", () => {
		const config = caseListConfig([
			{ field: "last_seen", header: "Last seen" },
		]);
		config.searchInputs = [
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a003"),
				"visit_date",
				"Visit day",
				"date",
				"visit_date",
			),
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a005"),
				"last_seen",
				"Last seen day",
				"date",
				"last_seen",
			),
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a006"),
				"date_opened",
				"Date opened",
				"date",
				"date_opened",
			),
		];
		const temporalDoc = buildDoc({
			appName: "Simple Date Search",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_date",
							label: "Visit date",
							data_type: "date",
						},
						{
							name: "last_seen",
							label: "Last seen",
							data_type: "datetime",
						},
					],
				},
			],
		});

		const hq = expandDoc(temporalDoc);
		const hqQuery = hq.modules[0].search_config.default_properties.find(
			(entry) => entry.property === "_xpath_query",
		)?.defaultValue;
		// CCHQ's server query grammar only admits case properties on the left
		// side of a comparison. `date(property)` is invalid (`unwrap_value`
		// rejects a property Step), so all three targets use legal half-open
		// bounds with value functions on the right. Nova has no authored app
		// timezone yet, so datetime targets deliberately use the UTC day on BOTH
		// runtimes. Explicit datetime bounds also bypass CCHQ's hidden
		// domain-timezone special case for indexed metadata: `date_opened` and a
		// custom datetime property therefore mean the same thing.
		expect(hqQuery).toContain("visit_date >= date(");
		expect(hqQuery).toContain("visit_date < date-add(date(");
		expect(hqQuery).toContain("last_seen >= datetime(");
		expect(hqQuery).toContain("last_seen < datetime(date-add(date(");
		expect(hqQuery).toContain("date_opened >= datetime(");
		expect(hqQuery).toContain("date_opened < datetime(date-add(date(");
		expect(hq.modules[0].search_config.properties).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "visit_date", exclude: true }),
				expect.objectContaining({ name: "last_seen", exclude: true }),
				expect.objectContaining({ name: "date_opened", exclude: true }),
			]),
		);
		const suite = new AdmZip(
			compileCcz(hq, "Simple Date Search", temporalDoc),
		).readAsText("suite.xml");
		expect(suite).toContain("visit_date &gt;= date(");
		expect(suite).toContain("last_seen &gt;= datetime(");
		expect(suite).toContain("date_opened &gt;= datetime(");
		expect(suite).toContain("date-add(");
		expect(suite).not.toContain("datetime-add(");
	});

	it("honors an explicit datetime coercion around a date prompt", () => {
		const config = caseListConfig([
			{ field: "last_seen", header: "Last seen" },
		]);
		config.searchInputs = [
			advancedSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000a004"),
				"base_date",
				"Starting date",
				"date",
				whenInput(
					input("base_date"),
					eq(
						prop("patient", "last_seen"),
						dateAdd(
							datetimeCoerce(term(input("base_date"))),
							"hours",
							term(literal(1)),
						),
					),
				),
			),
		];
		const temporalDoc = buildDoc({
			appName: "Datetime Search",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "last_seen",
							label: "Last seen",
							data_type: "datetime",
						},
					],
				},
			],
		});

		const hq = expandDoc(temporalDoc);
		const hqQuery = hq.modules[0].search_config.default_properties.find(
			(entry) => entry.property === "_xpath_query",
		)?.defaultValue;
		expect(hqQuery).toContain("datetime-add(datetime(");
		const suite = new AdmZip(
			compileCcz(hq, "Datetime Search", temporalDoc),
		).readAsText("suite.xml");
		expect(suite).toContain("datetime-add(datetime(");
	});

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

	it("stamps `compiledAtSeq` into the profile's cc-content-version", () => {
		const hq = expandDoc(doc);
		const profile = new AdmZip(
			compileCcz(hq, "CHW App", doc, { compiledAtSeq: 42 }),
		).readAsText("profile.ccpr");

		// The blueprint's `mutation_seq` names the document version in the
		// profile; the per-compile `uniqueid` stays a fresh UUID (HQ version
		// dedup) and is NOT the seq.
		expect(profile).toContain(
			'<property key="cc-content-version" value="42"/>',
		);
		expect(profile).not.toContain('uniqueid="42"');
	});

	it("defaults cc-content-version to 1 when no seq is threaded", () => {
		const hq = expandDoc(doc);
		const profile = new AdmZip(compileCcz(hq, "CHW App", doc)).readAsText(
			"profile.ccpr",
		);
		expect(profile).toContain('<property key="cc-content-version" value="1"/>');
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
		// date_modified and user_id read from the meta block, which the
		// compiler injects right after the case block (see the dedicated
		// meta-block test below); both `/data/meta/...` references resolve
		// against it.
		expect(regXform).toContain(
			'<bind nodeset="/data/case/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>',
		);
		expect(regXform).toContain(
			'<bind nodeset="/data/case/@user_id" calculate="/data/meta/userID"/>',
		);
	});

	it("injects the OpenRosa meta block into the compiled XForm", () => {
		// The HQ-upload source omits the meta block — CCHQ regenerates it at
		// render time (`_add_meta_2`). The local .ccz has no render step, so the
		// compiler injects it via `addMetaBlock`. Assert the full shape lands on
		// the .ccz form: the `<orx:meta>` data node (prefixed children +
		// `cc:appVersion`), the commcaresession instance the setvalues read from,
		// the eight populating setvalues, and the two dateTime typing binds.
		const hq = expandDoc(doc);
		const buf = compileCcz(hq, "CHW App", doc);
		const zip = new AdmZip(buf);
		const regXform = zip.readAsText("modules-0/forms-0.xml");

		expect(regXform).toContain(
			'<orx:meta xmlns:cc="http://commcarehq.org/xforms">',
		);
		expect(regXform).toContain("<orx:deviceID/>");
		expect(regXform).toContain("<orx:instanceID/>");
		expect(regXform).toContain("<cc:appVersion/>");
		expect(regXform).toContain("<orx:drift/>");
		// commcaresession is declared because the meta setvalues read its
		// context. Idempotent: the case-managed form already pulled it in, so
		// exactly one declaration survives.
		expect(regXform).toContain(
			'<instance src="jr://instance/session" id="commcaresession"/>',
		);
		expect((regXform.match(/id="commcaresession"/g) ?? []).length).toBe(1);
		// Setvalues populate the meta nodes; the unprefixed `/data/meta/...`
		// refs resolve by local name against the namespaced elements at runtime.
		// `instance('commcaresession')` serializes with `&apos;` (XML-spec
		// escaping the parser decodes before evaluation).
		expect(regXform).toContain(
			`<setvalue ref="/data/meta/deviceID" value="instance(&apos;commcaresession&apos;)/session/context/deviceid" event="xforms-ready"/>`,
		);
		expect(regXform).toContain(
			'<setvalue ref="/data/meta/instanceID" value="uuid()" event="xforms-ready"/>',
		);
		// The two dateTime typing binds — `<setvalue>` carries no type in
		// XForms 1.x, so the datatype hint lives on a parallel bind.
		expect(regXform).toContain(
			'<bind nodeset="/data/meta/timeStart" type="xsd:dateTime"/>',
		);
		expect(regXform).toContain(
			'<bind nodeset="/data/meta/timeEnd" type="xsd:dateTime"/>',
		);
	});

	it("keeps the meta block out of the HQ-upload source", () => {
		// The expander output is the form source CCHQ stores and Vellum edits.
		// It must carry no meta block: CCHQ injects its own at render time, and a
		// meta node in the source breaks CCHQ's form builder ("'meta' is not a
		// valid Question ID"). The block appears only on the .ccz the compiler
		// builds.
		const hq = expandDoc(doc);
		const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
		expect(source).not.toContain("<orx:meta");
		expect(source).not.toContain('nodeset="/data/meta/timeStart"');
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
								// Child case fields live under a group so the child's
								// `case_name`-id'd field (required per the
								// `CHILD_CASE_NO_NAME_FIELD` validator) doesn't collide
								// with the household's `case_name` field at the form
								// root. Sibling field ids must be unique; cousins in
								// different containers may share an id.
								f({
									kind: "group",
									id: "child_section",
									label: "Child",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Child name",
											case_property_on: "child",
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
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "case_name", label: "Child" }],
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
		// The bucket for child case keyed by (case_type, repeat_ancestor)
		// must include a `case_name`-id'd field — the
		// `CHILD_CASE_NO_NAME_FIELD` validator rejects child case buckets
		// without one. Other fields in the bucket become `case_properties`
		// entries producing the `<update>` element + per-prop binds. The
		// bind nodeset must match the actual element path
		// `<subcase_n>/case/update/<prop>` (NOT `<subcase_n>/update/<prop>`
		// — that path doesn't exist and the post-injection XForm oracle
		// would flag XFORM_DANGLING_BIND).
		//
		// The child case uses a top-level `case_name` field as its name
		// source. Two top-level fields named `case_name` would collide on
		// XML element name, so this test puts the household name on
		// `household_name` and dedicates `case_name` to the child case —
		// the household case_name source comes from the primary's
		// derived `case_property_on: "household"` on `household_name`.
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
									kind: "group",
									id: "child_section",
									label: "Child",
									children: [
										f({
											kind: "text",
											id: "case_name",
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
						{ name: "case_name", label: "Name" },
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
	 * Every `<setvalue>` in document order. The keyed `setvalues` map collapses
	 * entries that share `ref@event` (a node can carry more than one — e.g. an
	 * authored `default_value` and a case-preload read both target the same
	 * question at `xforms-ready`); this list preserves their relative order,
	 * which determines which write wins at runtime.
	 */
	setvalueOrder: Array<Record<string, string>>;
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
	const setvalueOrder: ParsedFormXml["setvalueOrder"] = [];
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
					// Ordered list preserves duplicates the map collapses.
					setvalueOrder.push({ ...attribs });
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

	return { binds, setvalues, setvalueOrder, cases };
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
 * discovery and fails the entire suite — including any run under the
 * CI async-leak gate (`--detect-async-leaks`) that discovers this file.
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

		// The case-name source question carries `required="true()"` on both —
		// CommCare forces it so a case can't be created nameless. Nova's name
		// field is `/data/case_name`; CCHQ's fixture uses `/data/question1`.
		// The attribute is merged onto the field's existing bind.
		expect(nova.binds.get("/data/case_name")?.required).toBe("true()");
		expect(cchq.binds.get("/data/question1")?.required).toBe("true()");
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
								// root-level subcase. The child bucket needs its
								// own `case_name` field (per the
								// `CHILD_CASE_NO_NAME_FIELD` validator), placed
								// under a group so the id doesn't collide with
								// the household's `case_name` at the form root.
								f({
									kind: "group",
									id: "child_section",
									label: "Child",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Child name",
											case_property_on: "child",
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
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "case_name", label: "Name" }],
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

		// Build a Nova doc with a root-level subcase whose only field is
		// `case_name` (required per the `CHILD_CASE_NO_NAME_FIELD`
		// validator), leaving `case_properties` empty — exactly the
		// empty-properties shape this divergence test needs. The child's
		// `case_name` field lives under a group so it doesn't collide
		// with the household's `case_name` at the form root (sibling
		// field ids must be unique; cousins can share).
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
									kind: "group",
									id: "child_section",
									label: "Child",
									children: [
										f({
											kind: "text",
											id: "case_name",
											label: "Child name",
											case_property_on: "child",
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
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
				{
					name: "child",
					properties: [{ name: "case_name", label: "Name" }],
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
	 * Positive parity: a registration form with a `user_controlled`
	 * repeat whose children include a cross-case-type field now compiles
	 * cleanly. The splice algorithm in `addCaseBlocks` routes the
	 * subcase wrapper to its repeat-context parent (the `<children>`
	 * data element) so the bind nodesets resolve against the actual DOM
	 * path. The validator rule that previously rejected this shape
	 * (`SUBCASE_IN_REPEAT_NOT_MODELED`) has been deleted; the new rules
	 * `PRIMARY_CASE_FIELD_IN_REPEAT` + `CHILD_CASE_NO_NAME_FIELD` cover
	 * the still-invalid neighbors.
	 *
	 * Per-mode + per-nest coverage lives in
	 * `__tests__/repeatContextSubcase.test.ts` (Step 11). This test
	 * pins the smallest viable user-controlled single-subcase-in-repeat
	 * shape — the nest=False branch — so a regression here surfaces
	 * before the per-mode matrix runs.
	 */
	it("repeat-context subcase compiles into the repeat element (nest=false)", () => {
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
											id: "case_name",
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
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});

		const errors = runValidation(novaDoc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.find(
				(e) =>
					e.code === "PRIMARY_CASE_FIELD_IN_REPEAT" ||
					e.code === "CHILD_CASE_NO_NAME_FIELD",
			),
		).toBeUndefined();

		const novaForm = new AdmZip(
			compileCcz(expandDoc(novaDoc), "Parity", novaDoc),
		).readAsText("modules-0/forms-0.xml");
		// nest=False: the `<case>` element splices DIRECTLY into the
		// `<children>` repeat element with no `<subcase_N>` wrapper.
		// Bind nodesets anchor at `/data/children/case/...`.
		expect(novaForm).toMatch(
			/<children jr:template="">[\s\S]*<case case_id=""[\s\S]*xmlns="http:\/\/commcarehq\.org\/case\/transaction\/v2">/,
		);
		// `case_id` mints per-iteration via uuid() — no setvalue, no
		// session datum (CCHQ's `delay_case_id=True` branch).
		expect(novaForm).toContain(
			'<bind nodeset="/data/children/case/@case_id" calculate="uuid()"/>',
		);
		// Parent-index pointer reads from the form's primary case_id.
		expect(novaForm).toContain(
			'<bind nodeset="/data/children/case/index/parent" calculate="/data/case/@case_id"/>',
		);
	});

	/**
	 * Reference fixture: `update_preload_case.xml` — case-preload setvalues
	 * on a followup form. Holds Nova's preload emission against CCHQ's
	 * `XForm.add_case_preloads` contract: one `<setvalue event="xforms-ready">`
	 * per preloaded property, reading the loaded case's property out of
	 * `casedb`.
	 */
	it("update_preload_case.xml — case-preload setvalues read from casedb", () => {
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
		const nova = parseFormXml(novaForm);
		const cchq = parseFormXml(readCchqFixture("update_preload_case.xml"));

		// The preload setvalue seeds the question node from the loaded case at
		// form load. Both emitters carry the same ref + event + value triple.
		const key = "/data/question1@xforms-ready";
		const novaPreload = nova.setvalues.get(key);
		const cchqPreload = cchq.setvalues.get(key);
		expect(novaPreload).toBeDefined();
		expect(cchqPreload).toBeDefined();
		expect(novaPreload?.value).toBe(cchqPreload?.value);
		expect(novaPreload?.value).toBe(
			"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/question1",
		);
	});

	/**
	 * Preload overrides an explicit `default_value` on a case-property field,
	 * matching CCHQ. Both setvalues target the same node at `xforms-ready`;
	 * JavaRosa fires them in document order, last write wins. `buildXForm`
	 * emits the field's `default_value` setvalue; `addCaseBlocks` splices the
	 * preload setvalue in just before `<itext>`, i.e. AFTER it — so the loaded
	 * case value wins, exactly as a CCHQ-uploaded app behaves (CCHQ emits the
	 * preload regardless of any authored default). This pins the lockstep:
	 * authoring an explicit default on a case-loading form's case property does
	 * not change the initial value the user sees — the case value does.
	 */
	it("preload setvalue is ordered after an explicit default_value setvalue", () => {
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
									default_value: "'manual-default'",
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
		const xml = new AdmZip(novaCcz).readAsText("modules-0/forms-0.xml");
		const { setvalueOrder } = parseFormXml(xml);

		// Both setvalues target `/data/question1` at `xforms-ready`; the keyed
		// map collapses them, so assert against the document-ordered list. Match
		// on decoded attribute values (the parser decodes `&apos;` → `'`).
		const defaultIdx = setvalueOrder.findIndex(
			(sv) => sv.ref === "/data/question1" && sv.value === "'manual-default'",
		);
		const preloadIdx = setvalueOrder.findIndex(
			(sv) =>
				sv.ref === "/data/question1" &&
				sv.value?.includes("instance('casedb')/casedb/case"),
		);
		expect(defaultIdx).toBeGreaterThan(-1);
		expect(preloadIdx).toBeGreaterThan(-1);
		// Preload comes later → fires last → the loaded case value wins.
		expect(preloadIdx).toBeGreaterThan(defaultIdx);
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
	 *   Nova does not emit case attachments today — the `mediaCaseProperty`
	 *   validator rejects media-kind fields with `case_property_on`, so this
	 *   shape is unreachable in a valid doc. Supporting it is a separate
	 *   feature (lift the rejection + emit on both pipelines + CCZ media
	 *   bundling), NOT a lockstep gap.
	 *
	 * (`update_preload_case.xml` was here — case-preload is now emitted; see
	 * the positive parity test "update_preload_case.xml — case-preload
	 * setvalues read from casedb" above.)
	 */
	it("documents unmodeled CCHQ features still under emission gap", () => {
		// Sanity-check: the documentation references real CCHQ fixtures.
		expect(readCchqFixture("update_parent_case.xml")).toContain("<parents>");
		expect(readCchqFixture("update_attachment_case.xml")).toContain(
			"<attachment>",
		);
	});
});

/**
 * Path to CCHQ's `suite` fixture directory on the local clone. Holds
 * canonical wire-shape references for suite.xml elements Nova emits —
 * detail blocks, remote-request, action, sort, datum. The parity tests
 * below parse Nova's output AND the matching CCHQ fixture via
 * `htmlparser2` so byte-level differences in escaping (the serializer
 * encodes `'` as `&apos;`, CCHQ's fixtures use the literal `'`) don't
 * trigger false positives — structural equivalence is the contract.
 *
 * Same skip-guard rationale as `CCHQ_FIXTURES` above: contributor-machine
 * convention, not a build artifact.
 */
const CCHQ_SUITE_FIXTURES = join(
	homedir(),
	"code/commcare-hq/corehq/apps/app_manager/tests/data/suite",
);
const HAS_CCHQ_SUITE_FIXTURES = existsSync(CCHQ_SUITE_FIXTURES);

/** Read a CCHQ suite fixture as a string. */
function readCchqSuiteFixture(name: string): string {
	return readFileSync(join(CCHQ_SUITE_FIXTURES, name), "utf-8");
}

/**
 * Structural shape of an element parsed out of a suite-XML document.
 * `name` is the element tag; `attribs` is the raw attribute map; `path`
 * is the slash-joined ancestor chain (excluding the root); `children`
 * holds nested elements in document order so the parity assertions can
 * walk down without a re-parse.
 */
interface SuiteElement {
	readonly name: string;
	readonly attribs: Readonly<Record<string, string>>;
	readonly path: string;
	readonly children: readonly SuiteElement[];
}

/**
 * Parse a suite.xml string into a structural tree. The parser uses
 * `htmlparser2` in `xmlMode` so attribute order and CCHQ's literal
 * markup round-trip into the same shape Nova's emission resolves to
 * after the dom-serializer escapes `'` to `&apos;`.
 */
function parseSuiteXml(xml: string): SuiteElement {
	const stack: {
		name: string;
		attribs: Record<string, string>;
		path: string;
		children: SuiteElement[];
	}[] = [];
	let root: SuiteElement | null = null;
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				const parentPath =
					stack.length === 0 ? "" : stack[stack.length - 1].path;
				const path = parentPath === "" ? name : `${parentPath}/${name}`;
				stack.push({ name, attribs: { ...attribs }, path, children: [] });
			},
			onclosetag() {
				const frame = stack.pop();
				if (frame === undefined) return;
				const node: SuiteElement = {
					name: frame.name,
					attribs: frame.attribs,
					path: frame.path,
					children: frame.children,
				};
				if (stack.length === 0) {
					root = node;
				} else {
					stack[stack.length - 1].children.push(node);
				}
			},
		},
		{ xmlMode: true },
	);
	parser.write(xml);
	parser.end();
	if (root === null) {
		throw new Error(
			"parseSuiteXml: input contained no top-level element. " +
				"Check that the suite-XML string the test fed in is a complete document with a root element.",
		);
	}
	return root;
}

/** Find every descendant element whose `name` matches. Depth-first. */
function findAllByName(
	root: SuiteElement,
	name: string,
): readonly SuiteElement[] {
	const out: SuiteElement[] = [];
	function walk(node: SuiteElement): void {
		if (node.name === name) out.push(node);
		for (const child of node.children) walk(child);
	}
	walk(root);
	return out;
}

/** Find the first descendant element whose `name` matches. */
function findFirstByName(
	root: SuiteElement,
	name: string,
): SuiteElement | undefined {
	function walk(node: SuiteElement): SuiteElement | undefined {
		if (node.name === name) return node;
		for (const child of node.children) {
			const hit = walk(child);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	return walk(root);
}

describe.skipIf(!HAS_CCHQ_SUITE_FIXTURES)("CCHQ suite-fixture parity", () => {
	/**
	 * Reference fixture: `search_command_detail.xml` — CCHQ's canonical
	 * wire shape for a case-search-enabled module. Pins three load-bearing
	 * suite-XML element families together:
	 *
	 *   1. `<detail id="m0_case_short">` with a case-list short detail
	 *      carrying a `<sort>` block AND an `<action auto_launch>` element
	 *      for the search button.
	 *   2. `<remote-request>` with `<post>`, `<command>`, `<instance>`
	 *      declarations, `<session>`, and `<stack>` rewind frame.
	 *   3. `<detail id="m0_search_short">` — the search-target detail
	 *      block, structurally identical to `m0_case_short` minus the
	 *      `<action>` element.
	 *
	 * The fixture covers CCHQ-specific features Nova doesn't emit (the
	 * inline `instance('reports')` and `instance('item-list:moons')`
	 * calc-column lookups, the parent-relation column). The parity test
	 * asserts what Nova emits matches CCHQ in structure on the slots
	 * Nova ALSO emits — element presence, attribute presence + value,
	 * child element ordering. Byte-level escaping differences
	 * (Nova: `&apos;` via serializer; CCHQ fixture: literal `'`) wash
	 * out at the parse boundary.
	 */
	// Shared Nova authoring fixture — a case-search-enabled module
	// that lights up the same suite-XML surfaces both CCHQ reference
	// fixtures pin. Used by every parity test in this `describe` block.
	function buildSearchParityDoc(): ReturnType<typeof buildDoc> {
		return buildDoc({
			appName: "SearchParity",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { searchScreenTitle: "Find patient" },
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes", label: "Notes" })],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		});
	}

	/**
	 * Reference fixture: `search_command_detail.xml` — CCHQ's wire
	 * shape for the two case-list detail blocks a case-search-enabled
	 * module emits. Pins the dual-detail emission contract:
	 *
	 *   1. `<detail id="m0_case_short">` — the case-list short detail
	 *      with an `<action>` element for the search button.
	 *   2. `<detail id="m0_search_short">` — the search-target short
	 *      detail (no `<action>` child; the search results screen IS
	 *      the action's destination).
	 *
	 * Both detail blocks carry the same `<title>` referencing CCHQ's
	 * `cchq.case` built-in locale. The fixture's CCHQ-specific calc
	 * columns (`instance('reports')`, `instance('item-list:moons')`)
	 * sit outside Nova's authoring surface; the parity assertions hold
	 * the structural slots both emitters carry.
	 */
	it("search_command_detail.xml — case-list + search-target detail blocks structurally match", () => {
		const cchqDoc = buildSearchParityDoc();
		const novaCcz = compileCcz(expandDoc(cchqDoc), "SearchParity", cchqDoc);
		const novaSuite = new AdmZip(novaCcz).readAsText("suite.xml");
		const cchqFragment = readCchqSuiteFixture("search_command_detail.xml");

		const novaRoot = parseSuiteXml(novaSuite);
		// CCHQ's fixture is a fragment (no `<suite>` wrapper); wrap so
		// the parser yields a single root for parallel traversal.
		const cchqRoot = parseSuiteXml(
			`<suite version="1">${cchqFragment}</suite>`,
		);

		// (1) Case-list short detail — both emitters carry the same id +
		// the same `<title>` referencing CCHQ's `cchq.case` locale.
		const novaCaseShort = findAllByName(novaRoot, "detail").find(
			(d) => d.attribs.id === "m0_case_short",
		);
		const cchqCaseShort = findAllByName(cchqRoot, "detail").find(
			(d) => d.attribs.id === "m0_case_short",
		);
		expect(novaCaseShort).toBeDefined();
		expect(cchqCaseShort).toBeDefined();
		const novaTitleLocale = findFirstByName(
			novaCaseShort as SuiteElement,
			"locale",
		);
		const cchqTitleLocale = findFirstByName(
			cchqCaseShort as SuiteElement,
			"locale",
		);
		expect(novaTitleLocale?.attribs.id).toBe(cchqTitleLocale?.attribs.id);
		expect(novaTitleLocale?.attribs.id).toBe("cchq.case");

		// (2) The case-search-enabled short detail carries an `<action>`
		// element with the canonical `auto_launch="false()"` +
		// `redo_last="false"` attribute pair (Nova's `compileForPlatform`
		// picks the list-first / no-auto-launch shape for this fixture's
		// no-filter no-input shape; CCHQ's fixture pins the same).
		const novaAction = findFirstByName(novaCaseShort as SuiteElement, "action");
		const cchqAction = findFirstByName(cchqCaseShort as SuiteElement, "action");
		expect(novaAction).toBeDefined();
		expect(cchqAction).toBeDefined();
		expect(novaAction?.attribs.auto_launch).toBe(
			cchqAction?.attribs.auto_launch,
		);
		expect(novaAction?.attribs.redo_last).toBe(cchqAction?.attribs.redo_last);
		expect(novaAction?.attribs.auto_launch).toBe("false()");
		expect(novaAction?.attribs.redo_last).toBe("false");

		// (3) Search-target detail block — same id pattern, same
		// `cchq.case` title locale, NO `<action>` child (the search
		// results screen IS the action's destination).
		const novaSearchShort = findAllByName(novaRoot, "detail").find(
			(d) => d.attribs.id === "m0_search_short",
		);
		const cchqSearchShort = findAllByName(cchqRoot, "detail").find(
			(d) => d.attribs.id === "m0_search_short",
		);
		expect(novaSearchShort).toBeDefined();
		expect(cchqSearchShort).toBeDefined();
		expect(
			findFirstByName(novaSearchShort as SuiteElement, "action"),
		).toBeUndefined();
		expect(
			findFirstByName(cchqSearchShort as SuiteElement, "action"),
		).toBeUndefined();
	});

	/**
	 * Reference fixture: `remote_request.xml` — CCHQ's wire shape for
	 * the full `<remote-request>` block a case-search-enabled module
	 * emits. Pins the five-family child element order
	 * (`<post>` → `<command>` → `<instance>+` → `<session>` → `<stack>`)
	 * plus the canonical `<post>` / `<datum>` / `<stack>` attribute
	 * shapes Nova matches.
	 */
	it("remote_request.xml — full <remote-request> block structurally matches", () => {
		const cchqDoc = buildSearchParityDoc();
		const novaCcz = compileCcz(expandDoc(cchqDoc), "SearchParity", cchqDoc);
		const novaSuite = new AdmZip(novaCcz).readAsText("suite.xml");
		const cchqFragment = readCchqSuiteFixture("remote_request.xml");

		const novaRoot = parseSuiteXml(novaSuite);
		const cchqRoot = parseSuiteXml(
			`<suite version="1">${cchqFragment}</suite>`,
		);

		// `<remote-request>` element presence on both emitters.
		const novaRemoteReq = findFirstByName(novaRoot, "remote-request");
		const cchqRemoteReq = findFirstByName(cchqRoot, "remote-request");
		expect(novaRemoteReq).toBeDefined();
		expect(cchqRemoteReq).toBeDefined();

		// (1) `<post>` element with the canonical relevant-guard and
		// `case_id` data child. The guard is the
		// `CaseClaimXpath.default_relevant` formula CCHQ lifts verbatim
		// into the fixture; Nova carries the same string (encoded as
		// `&apos;` once for the wire, decoded back at parse time).
		const novaPost = findFirstByName(novaRemoteReq as SuiteElement, "post");
		const cchqPost = findFirstByName(cchqRemoteReq as SuiteElement, "post");
		expect(novaPost?.attribs.relevant).toBeDefined();
		expect(cchqPost?.attribs.relevant).toBeDefined();
		expect(novaPost?.attribs.relevant).toBe(cchqPost?.attribs.relevant);
		const novaPostData = findFirstByName(novaPost as SuiteElement, "data");
		const cchqPostData = findFirstByName(cchqPost as SuiteElement, "data");
		expect(novaPostData?.attribs.key).toBe(cchqPostData?.attribs.key);
		expect(novaPostData?.attribs.key).toBe("case_id");
		expect(novaPostData?.attribs.ref).toBeDefined();
		expect(cchqPostData?.attribs.ref).toBeDefined();
		expect(novaPostData?.attribs.ref).toBe(cchqPostData?.attribs.ref);

		// (2) Five-family child element ordering on BOTH emitters:
		// post → command → instance(s) → session → stack. Asserting
		// the same ordering relations on both Nova and CCHQ makes
		// this a real bidirectional parity check — a future CCHQ
		// reorder would surface here (failing the parity gate) rather
		// than silently diverging.
		const novaChildNames = (novaRemoteReq as SuiteElement).children.map(
			(c) => c.name,
		);
		const cchqChildNames = (cchqRemoteReq as SuiteElement).children.map(
			(c) => c.name,
		);
		for (const name of ["post", "command", "session", "stack"]) {
			expect(novaChildNames).toContain(name);
			expect(cchqChildNames).toContain(name);
		}
		// Apply the same ordering assertions to both sides — any
		// future CCHQ reorder makes the parity gate fail.
		for (const names of [novaChildNames, cchqChildNames]) {
			expect(names.indexOf("post")).toBeLessThan(names.indexOf("command"));
			expect(names.indexOf("command")).toBeLessThan(names.indexOf("instance"));
			expect(names.lastIndexOf("instance")).toBeLessThan(
				names.indexOf("session"),
			);
			expect(names.indexOf("session")).toBeLessThan(names.indexOf("stack"));
		}

		// (3) `<datum>` inside `<session>` references the search-target
		// detail ids on both emitters. CCHQ's fixture uses a literal
		// `{module_id}` placeholder that the runtime substitutes at
		// app-build time; Nova emits the substituted form directly
		// (`m0_search_short`). The parity check holds the structural
		// shape — both have a `<datum>` with the same `detail-select`
		// / `detail-confirm` attribute SUFFIX after stripping the
		// CCHQ placeholder.
		const novaSession = findFirstByName(
			novaRemoteReq as SuiteElement,
			"session",
		);
		const cchqSession = findFirstByName(
			cchqRemoteReq as SuiteElement,
			"session",
		);
		const novaDatum = findFirstByName(novaSession as SuiteElement, "datum");
		const cchqDatum = findFirstByName(cchqSession as SuiteElement, "datum");
		expect(novaDatum?.attribs["detail-select"]).toBe("m0_search_short");
		expect(novaDatum?.attribs["detail-confirm"]).toBe("m0_search_long");
		// CCHQ's value is `{module_id}_search_short`; the suffix matches.
		expect(cchqDatum?.attribs["detail-select"]).toMatch(/_search_short$/);
		expect(cchqDatum?.attribs["detail-confirm"]).toMatch(/_search_long$/);

		// (4) `<stack>` rewind frame — single `<push>` containing a
		// `<rewind>` referencing the same `search_case_id` session
		// datum on both emitters.
		const novaStack = findFirstByName(novaRemoteReq as SuiteElement, "stack");
		const cchqStack = findFirstByName(cchqRemoteReq as SuiteElement, "stack");
		const novaRewind = findFirstByName(novaStack as SuiteElement, "rewind");
		const cchqRewind = findFirstByName(cchqStack as SuiteElement, "rewind");
		expect(novaRewind?.attribs.value).toBeDefined();
		expect(cchqRewind?.attribs.value).toBeDefined();
		expect(novaRewind?.attribs.value).toBe(cchqRewind?.attribs.value);
	});
});
