import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
// Tool-workspace, schema, validator and emitted-artifact contracts.
// No database or browser behavior is inferred from these pipeline checks.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "@/lib/agent/tools/case-list-config/removeCaseListColumn";
import { reorderCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/reorderCaseListColumns";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { buildSortDirectives } from "@/lib/commcare/suite/case-list/sortKeys";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	calculatedColumn,
	caseListConfigSchema,
	emptyCaseListConfig,
	type Module,
	orderedColumns,
	plainColumn,
	rangeMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	prop,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	APP_ID,
	buildFixtureDoc,
	buildWellFormedCaseListConfig,
} from "./fixtures/caseListAuthoring";

// =================================================================
// 1. Schema parse — round-trip the well-formed fixture through
//    `caseListConfigSchema`. Surfaces drift between the test
//    fixture and the schema as a parse failure rather than as a
//    silent downstream mismatch.
// =================================================================

describe("schema parse", () => {
	it("accepts the well-formed v2 case-list configuration", () => {
		const config = buildWellFormedCaseListConfig();
		const parsed = caseListConfigSchema.parse(config);
		expect(parsed).toEqual(config);
	});
});

// =================================================================
// 2. SA tool path — atomic column ops thread uuids through the
//    add → update → reorder → remove sequence. Every call's
//    `result.uuid` is the addressing key for the next call; the
//    final doc state matches the authored shape.
// =================================================================

describe("SA tool path — column atomic ops", () => {
	it("threads uuids through add → update → reorder → remove", async () => {
		// Single case-typed module — every SA tool invocation here
		// targets its stable UUID. The `f` helper auto-stamps field
		// uuids; explicit case-list slot is omitted so the first
		// `addCaseListColumns` initializes it.
		const startDoc = buildDoc({
			appId: APP_ID,
			appName: "SA Tool Path",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Patient name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		const moduleUuid = startDoc.moduleOrder[0];
		// The workspace owns the document across the whole sequence: each
		// call reads what the previous one committed, so nothing threads a
		// doc by hand.
		const h = makeToolWorkspaceHarness(startDoc, { appId: APP_ID });

		// 1. Add the first column — capture the uuid the tool mints.
		const addNameResult = await h.runTool(addCaseListColumnsTool, {
			moduleUuid,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});
		if ("error" in addNameResult.result) {
			throw new Error(
				`add patient column failed: ${addNameResult.result.error}`,
			);
		}
		const nameUuid = addNameResult.result.uuids[0];
		// The success message echoes the header; the `result.uuids`
		// surface the minted uuids structurally so the SA can reference
		// them directly without parsing the string.
		expect(addNameResult.result.message).toContain("Patient");

		// 2. Add a second column on the post-add doc.
		const addAgeResult = await h.runTool(addCaseListColumnsTool, {
			moduleUuid,
			columns: [{ kind: "plain", field: "age", header: "Age" }],
		});
		if ("error" in addAgeResult.result) {
			throw new Error(`add age column failed: ${addAgeResult.result.error}`);
		}
		const ageUuid = addAgeResult.result.uuids[0];
		expect(ageUuid).not.toBe(nameUuid);

		// 3. Update the second column — flip on a sort directive.
		// The replacement carries the same uuid (the tool stamps the
		// existing uuid back onto the supplied body).
		const updateResult = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: ageUuid,
			column: {
				kind: "plain",
				field: "age",
				header: "Age",
				sort: { direction: "desc", priority: 0 },
			},
		});
		if ("error" in updateResult.result) {
			throw new Error(`update column failed: ${updateResult.result.error}`);
		}
		expect(updateResult.result.uuid).toBe(ageUuid);

		// 4. Reorder — supply both uuids in age-first order.
		const reorderResult = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid,
			surface: "results",
			columnUuids: [ageUuid, nameUuid],
		});
		if ("error" in reorderResult.result) {
			throw new Error(`reorder failed: ${reorderResult.result.error}`);
		}
		const reorderedColumns = orderedColumns(configOf(h.currentDoc()), "list");
		expect(reorderedColumns.map((column) => column.uuid)).toEqual([
			ageUuid,
			nameUuid,
		]);

		// 5. Remove the original first column — still keyed by uuid
		// so the address survives the prior reorder.
		const removeResult = await h.runTool(removeCaseListColumnTool, {
			moduleUuid,
			columnUuid: nameUuid,
		});
		if ("error" in removeResult.result) {
			throw new Error(`remove failed: ${removeResult.result.error}`);
		}
		const finalColumns = collectColumns(h.currentDoc());
		expect(finalColumns).toHaveLength(1);
		expect(finalColumns[0]?.uuid).toBe(ageUuid);
		// Sort directive on the survivor survived the reorder + remove.
		expect(finalColumns[0]?.sort).toEqual({ direction: "desc", priority: 0 });
	});

	it("returns Elm-style error when an update targets an unknown column uuid", async () => {
		const doc = buildDoc({
			appId: APP_ID,
			modules: [{ name: "Patients", caseType: "patient", caseListOnly: true }],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const moduleUuid = doc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(doc, { appId: APP_ID });
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: testUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"),
			column: { kind: "plain", field: "case_name", header: "Patient" },
		});
		if (!("error" in result.result)) {
			throw new Error("expected error result on unknown uuid");
		}
		// The shared `replaceByUuid` helper's voice: "Tried to update
		// X. Found no entry with that uuid. Look at getModule's
		// projection or run searchBlueprint to surface the current
		// uuids."
		expect(result.result.error).toContain("Found no entry");
	});
});

// =================================================================
// 3. Wire emission — golden structural fingerprints across short
//    detail (sort + visibility), long detail (visibility-only,
//    no sort), and the .ccz bundle. Inline shape assertions
//    mirror the per-emitter unit tests' style; goldens are
//    structural fingerprints, not whole-XML snapshots.
// =================================================================

describe("wire emission", () => {
	it("emits per-column <sort> blocks ordered by priority with calc-arm template", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing module");
		const result = emitShortDetail({ module: mod, moduleIndex: 0, doc });

		expect(result.xml).toContain('<detail id="m0_case_short">');
		expect(result.xml).toContain('<locale id="cchq.case"/>');
		// Plain — bare property reference.
		expect(result.xml).toContain('<xpath function="case_name"/>');
		// Date — empty-string-guard wrapped in format-date. XPath
		// single-quote literals round-trip through the serializer as
		// `&apos;` inside the double-quoted attribute value.
		expect(result.xml).toContain(
			"if(date_opened = &apos;&apos;, &apos;&apos;, format-date(date(date_opened), &apos;%Y-%m-%d&apos;))",
		);
		// Interval (display: always) — divisor 7 (weeks) + threshold
		// 14 days. Worker text resolves through a locale variable.
		expect(result.xml).toContain("(today() - date(last_visit)) div 7");
		expect(result.xml).toContain("$knova_text_0");
		expect(Object.values(result.strings)).toContain("Overdue");
		// Id-mapping — selected() chain wrapped in replace(join(...)).
		expect(result.xml).toContain(
			"if(selected(region, &apos;N&apos;), $knova_text_0",
		);
		expect(Object.values(result.strings)).toEqual(
			expect.arrayContaining(["North", "South"]),
		);
		// Calculated column emits the inline-variable template per
		// CCHQ's `detail_screen.py::FormattedDetailColumn.template`'s
		// `useXpathExpression` branch.
		expect(result.xml).toContain('<variable name="calculated_property">');
		// Sort priority ordering — `age` carries priority 0 → order=1
		// (descending integer). `case_name` carries priority 1 →
		// order=2 (ascending plain).
		const sorts = findAll(
			(node) => node.name === "sort",
			parseDocument(result.xml, { xmlMode: true }).children,
		);
		expect(
			sorts
				.map((sort) => ({
					...sort.attribs,
					order: sort.attribs.order,
					xpath: findAll((node) => node.name === "xpath", sort.children).map(
						(node) => node.attribs.function,
					),
				}))
				.sort((a, b) => Number(a.order) - Number(b.order)),
		).toEqual([
			{ type: "int", order: "1", direction: "descending", xpath: ["age"] },
			{
				type: "string",
				order: "2",
				direction: "ascending",
				xpath: ["case_name"],
			},
		]);
	});

	it("emits long detail without <sort> blocks", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing module");
		const result = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		expect(result.xml).toContain('<detail id="m0_case_long">');
		// CCHQ's `detail_screen.py::FormattedDetailColumn.sort_node`
		// short-circuits on long detail; sort lives only on short.
		expect(result.xml).not.toContain("<sort");
	});

	it("filters columns by visibleInList on short detail and visibleInDetail on long detail", () => {
		// Two columns: one hidden from list, one hidden from detail.
		// The shared columns appear on both surfaces.
		const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
		const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
		const colShared = testUuid("00000000-0000-4000-8000-aaaa00000001");
		const colListOnly = testUuid("00000000-0000-4000-8000-aaaa00000002");
		const colDetailOnly = testUuid("00000000-0000-4000-8000-aaaa00000003");
		const mod: Module = {
			uuid: moduleUuid,
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: resolveCaseListConfig({
				columns: [
					plainColumn(colShared, "case_name", "Name"),
					plainColumn(colListOnly, "age", "Age", {
						visibleInDetail: false,
					}),
					plainColumn(colDetailOnly, "region", "Region", {
						visibleInList: false,
					}),
				],
				searchInputs: [],
			}),
		};
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Visibility",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
			],
			modules: { [moduleUuid]: mod },
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "register",
					name: "Register",
					type: "registration",
				},
			},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
			fieldParent: {},
		};
		const shortResult = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		const longResult = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		// Short detail — list-only filtered out; detail-only column
		// (`region`) absent from the short XML; shared + list-only
		// (`age`) present.
		expect(shortResult.xml).toContain('<xpath function="case_name"/>');
		expect(shortResult.xml).toContain('<xpath function="age"/>');
		expect(shortResult.xml).not.toContain('<xpath function="region"/>');

		// Long detail — detail-only present; list-only (`age`)
		// absent.
		expect(longResult.xml).toContain('<xpath function="case_name"/>');
		expect(longResult.xml).toContain('<xpath function="region"/>');
		expect(longResult.xml).not.toContain('<xpath function="age"/>');
	});

	it("packages the admitted blueprint into a .ccz archive", () => {
		const doc = buildFixtureDoc();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const hq = expandDoc(doc);
		const buffer = compileCcz(hq, doc.appName, doc);
		expect(buffer.length).toBeGreaterThan(0);

		const zip = new AdmZip(buffer);
		const entryNames = zip.getEntries().map((e) => e.entryName);
		expect(entryNames).toContain("suite.xml");
		expect(entryNames).toContain("profile.ccpr");
		expect(entryNames).toContain("default/app_strings.txt");

		const suite = zip.readAsText("suite.xml");
		// Both case-typed modules emit their configured Results details.
		expect(suite).toContain('<detail id="m0_case_short">');
		expect(suite).toContain('<detail id="m0_case_long">');
		expect(suite).toContain('<detail id="m1_case_short">');
		// The followup form's case-loading datum carries the
		// canonical `@case_type='patient'][@status='open']` chain
		// plus the `caseListConfig.filter` fragment appended at the
		// trailing position. XPath single-quote literals round-trip
		// as `&apos;` inside the double-quoted `nodeset` attribute.
		expect(suite).toContain("@case_type=&apos;patient&apos;");
		expect(suite).toContain("[@status = &apos;open&apos;]");
	});
});

// =================================================================
// 4. Calc-column comparator safety — unresolved and null-shaped
//    values defensively fall back to `plain`, while expressions Core
//    cannot evaluate on-device fail closed at the wire boundary.
// =================================================================

describe("calc-column comparator-type fallback", () => {
	const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const calcUuid = testUuid("00000000-0000-4000-8000-cccc00000001");

	function buildCalcModule(
		expression: Parameters<typeof calculatedColumn>[2],
	): {
		mod: Module;
		doc: BlueprintDoc;
	} {
		const mod: Module = {
			uuid: moduleUuid,
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: resolveCaseListConfig({
				columns: [
					calculatedColumn(calcUuid, "Calc value", expression, {
						sort: { direction: "asc", priority: 0 },
					}),
				],
				searchInputs: [],
			}),
		};
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Calc Fallback",
			connectType: null,
			caseTypes: [{ name: "patient", properties: [] }],
			modules: { [moduleUuid]: mod },
			forms: {},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [] },
			fieldOrder: {},
			fieldParent: {},
		};
		return { mod, doc };
	}

	it("falls back to plain when checkExpression returns undefined (unresolvable property)", () => {
		// Resolution failure — `prop("patient", "ghost")` is not a
		// declared property and not a CCHQ standard property; the
		// type checker returns `undefined`.
		const { mod, doc } = buildCalcModule(term(prop("patient", "ghost")));
		const directives = buildSortDirectives(mod, doc);
		const dir = directives.get(calcUuid);
		if (!dir) throw new Error("missing directive on calc column");
		expect(dir.type).toBe("plain");
	});

	it("falls back to plain when checkExpression returns ANY_TYPE (null literal)", () => {
		// `null` literal — the type checker returns `ANY_TYPE`, the
		// permissive sentinel that compares against every type.
		const { mod, doc } = buildCalcModule(term(literal(null)));
		const directives = buildSortDirectives(mod, doc);
		const dir = directives.get(calcUuid);
		if (!dir) throw new Error("missing directive on calc column");
		expect(dir.type).toBe("plain");
	});
});

// =================================================================
// 5. Discriminated SearchInputDef round-trip — a simple input
//    converts to advanced via the SA `updateSearchInput` tool path,
//    converts back to simple, and the common slots survive both
//    edits byte-identically.
// =================================================================

describe("SearchInputDef simple and advanced round-trip", () => {
	it("converts simple → advanced → simple via updateSearchInput, preserving uuid + common slots", async () => {
		const baseDoc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(
								testUuid("00000000-0000-4000-8000-aaaa00000001"),
								"case_name",
								"Patient",
							),
						],
						searchInputs: [],
					}),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Case name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "name",
									label: proseText("Patient name"),
									caseWrite: {
										caseType: "patient",
										property: "full_name",
									},
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const moduleUuid = baseDoc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(baseDoc, { appId: APP_ID });

		// Add a simple input — capture the uuid the tool mints.
		const addResult = await h.runTool(addSearchInputsTool, {
			moduleUuid,
			searchInputs: [
				{
					kind: "simple",
					name: "patient_name",
					label: "Patient name",
					type: "text",
					property: "full_name",
					default: term(literal("Alice")),
				},
			],
		});
		if ("error" in addResult.result) {
			throw new Error(`add input failed: ${addResult.result.error}`);
		}
		const inputUuid = addResult.result.uuids[0];
		const afterAdd = collectSearchInputs(h.currentDoc());
		expect(afterAdd).toHaveLength(1);
		expect(afterAdd[0]?.kind).toBe("simple");

		// Convert simple → advanced. The new body carries a free-form
		// predicate; the SA preserves uuid + name + label + type +
		// default across the call.
		const toAdvancedResult = await h.runTool(updateSearchInputTool, {
			moduleUuid,
			searchInputUuid: inputUuid,
			searchInput: {
				kind: "advanced",
				name: "patient_name",
				label: "Patient name",
				type: "text",
				default: term(literal("Alice")),
				predicate: matchAll(),
			},
		});
		if ("error" in toAdvancedResult.result) {
			throw new Error(
				`simple → advanced failed: ${toAdvancedResult.result.error}`,
			);
		}
		const advanced = collectSearchInputs(h.currentDoc())[0];
		if (!advanced) throw new Error("missing input after simple → advanced");
		expect(advanced.kind).toBe("advanced");
		expect(advanced.uuid).toBe(inputUuid);
		expect(advanced.name).toBe("patient_name");
		expect(advanced.label).toBe("Patient name");
		if (advanced.kind === "hidden") throw new Error("expected a visible input");
		expect(advanced.type).toBe("text");
		if (advanced.type !== "date-range") {
			expect(advanced.default).toEqual(term(literal("Alice")));
		}

		// Convert back to simple. The discriminated SA tool accepts
		// the simple-arm body shape; the advanced predicate is
		// dropped on the conversion (the advanced and simple arms
		// are distinct unions — there is no shared "predicate" slot).
		const toSimpleResult = await h.runTool(updateSearchInputTool, {
			moduleUuid,
			searchInputUuid: inputUuid,
			searchInput: {
				kind: "simple",
				name: "patient_name",
				label: "Patient name",
				type: "text",
				property: "full_name",
				default: term(literal("Alice")),
			},
		});
		if ("error" in toSimpleResult.result) {
			throw new Error(
				`advanced → simple failed: ${toSimpleResult.result.error}`,
			);
		}
		const simple = collectSearchInputs(h.currentDoc())[0];
		if (!simple) throw new Error("missing input after advanced → simple");
		expect(simple.kind).toBe("simple");
		expect(simple.uuid).toBe(inputUuid);
		expect(simple.name).toBe("patient_name");
		expect(simple.label).toBe("Patient name");
		if (simple.kind === "hidden") throw new Error("expected a visible input");
		expect(simple.type).toBe("text");
		if (simple.type !== "date-range") {
			expect(simple.default).toEqual(term(literal("Alice")));
		}
		if (simple.kind === "simple") {
			expect(simple.property).toBe("full_name");
		}
	});
});

// =================================================================
// 6. Orphan Search-input identity validator surface. An unresolved
//    Search-input UUID in `caseListConfig.filter` surfaces as
//    `CASE_LIST_FILTER_TYPE_ERROR` via the predicate type checker.
// =================================================================

describe("orphan Search-input identity surfaces a validator error", () => {
	it("flags an unresolvable Search-input identity inside the filter as CASE_LIST_FILTER_TYPE_ERROR", () => {
		const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
		const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
		// The filter references an immutable UUID with no matching
		// declaration in `searchInputs`; the validator reports the
		// owning filter slot without inventing a mutable-name fallback.
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Orphan Input",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(
								testUuid("00000000-0000-4000-8000-aaaa00000001"),
								"full_name",
								"Name",
							),
						],
						filter: eq(
							prop("patient", "full_name"),
							term(input(testUuid("orphan_input"))),
						),
						searchInputs: [
							// A different immutable identity is declared.
							simpleSearchInputDef(
								testUuid("00000000-0000-4000-8000-bbbb00000001"),
								"declared_input",
								"Declared",
								"text",
								"full_name",
							),
						],
					}),
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "register",
					name: "Register",
					type: "registration",
				},
			},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
			fieldParent: {},
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR")).toBe(
			true,
		);
	});
});

// =================================================================
// 7. Validator rejection of broken references — orthogonal column-
//    uuid / search-input shape errors fire on their dedicated codes.
// =================================================================

describe("validator rejection of broken references", () => {
	it("admits the complete well-formed blueprint", () => {
		const doc = buildFixtureDoc();
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toEqual([]);
	});

	it("flags a column referencing an unknown property with CASE_LIST_COLUMN_UNKNOWN_FIELD", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod?.caseListConfig) {
			throw new Error("fixture module missing caseListConfig");
		}
		// Replace one column with one whose `field` no writer creates
		// and no case type declares.
		const corruptedColumns: Column[] = [
			...mod.caseListConfig.columns.slice(0, -1),
			plainColumn(
				testUuid("00000000-0000-4000-8000-eeee00000001"),
				"ghost_property",
				"Ghost",
			),
		];
		const replacedColumnUuid = mod.caseListConfig.columns.at(-1)?.uuid;
		const ghostColumnUuid = corruptedColumns.at(-1)?.uuid;
		if (!replacedColumnUuid || !ghostColumnUuid) {
			throw new Error("fixture has no column to replace");
		}
		mod.caseListConfig = {
			...mod.caseListConfig,
			columns: corruptedColumns,
			listColumnOrder: mod.caseListConfig.listColumnOrder.map((uuid) =>
				uuid === replacedColumnUuid ? ghostColumnUuid : uuid,
			),
			detailColumnOrder: mod.caseListConfig.detailColumnOrder.map((uuid) =>
				uuid === replacedColumnUuid ? ghostColumnUuid : uuid,
			),
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("ghost_property"),
			),
		).toBe(true);
	});

	it("flags a search input mode-vs-property-type mismatch with the dedicated code", () => {
		// `range` mode is forbidden on text-typed properties — the
		// `(text-input, text-property, range-mode)` tuple is not in
		// the `SEARCH_MODE_PROPERTY_TYPES["range"]` allow-list.
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod?.caseListConfig) {
			throw new Error("fixture module missing caseListConfig");
		}
		mod.caseListConfig = {
			...mod.caseListConfig,
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-ffff00000001"),
					"name_range",
					"Name range",
					"date-range",
					"full_name",
					{ mode: rangeMode() },
				),
			],
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});
});

// =================================================================
// 8. Sort-priority collisions — the absolute gate rejects the edit
//    that would land two sorted columns at one priority.
// =================================================================

describe("sort-priority collision admission", () => {
	const colFirstUuid = testUuid("00000000-0000-4000-8000-bbbb00000001");
	const colSecondUuid = testUuid("00000000-0000-4000-8000-bbbb00000002");

	it("rejects a colliding sort priority without changing the tool workspace", async () => {
		// The saga layer never silently renumbers a priority collision —
		// and with the commit gate live, it never PERSISTS one either:
		// the second `updateCaseListColumn` that would land a duplicate
		// priority fails the call with the validator's actionable
		// message and leaves the doc untouched.
		const startDoc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(colFirstUuid, "case_name", "Patient"),
							plainColumn(colSecondUuid, "age", "Age"),
						],
						searchInputs: [],
					}),
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		const moduleUuid = startDoc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(startDoc, { appId: APP_ID });

		const firstUpdate = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: colFirstUuid,
			column: {
				kind: "plain",
				field: "case_name",
				header: "Patient",
				sort: { direction: "asc", priority: 0 },
			},
		});
		if ("error" in firstUpdate.result) {
			throw new Error(`first update failed: ${firstUpdate.result.error}`);
		}
		const secondUpdate = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: colSecondUuid,
			column: {
				kind: "plain",
				field: "age",
				header: "Age",
				sort: { direction: "desc", priority: 0 },
			},
		});
		// The colliding write is rejected with the rule's actionable
		// message — the SA renumbers and retries rather than landing a
		// silent ordering ambiguity.
		if (!("error" in secondUpdate.result)) {
			throw new Error("expected the colliding priority to be rejected");
		}
		expect(secondUpdate.result.error).toContain("sort priority");
		expect(secondUpdate.mutations).toEqual([]);
		// The doc after the rejected call still carries only the FIRST
		// column's sort — the collision never landed.
		const finalCols = collectColumns(h.currentDoc());
		expect(finalCols[0]?.sort?.priority).toBe(0);
		expect(finalCols[1]?.sort).toBeUndefined();
	});
});

// ── Helpers ──────────────────────────────────────────────────────
//
// Two narrow helpers extract the columns / search inputs of the
// first module out of a `BlueprintDoc`. The SA tool path tests
// invoke them after each call to assert the post-mutation shape
// without re-walking `moduleOrder` / `modules` at every site.

function configOf(doc: BlueprintDoc): CaseListConfig {
	return (
		doc.modules[doc.moduleOrder[0]]?.caseListConfig ?? emptyCaseListConfig()
	);
}

function collectColumns(doc: BlueprintDoc): Column[] {
	return [...configOf(doc).columns];
}

function collectSearchInputs(
	doc: BlueprintDoc,
): NonNullable<Module["caseListConfig"]>["searchInputs"] {
	const moduleUuid = doc.moduleOrder[0];
	const mod = doc.modules[moduleUuid];
	if (!mod?.caseListConfig) return [];
	return [...mod.caseListConfig.searchInputs];
}
