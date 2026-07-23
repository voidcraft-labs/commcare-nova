import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildFormActions } from "@/lib/commcare/formActions";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import {
	authoredCaseIdCalculation,
	caseOperationTextValueCalculation,
	caseOperationTextValueGuard,
} from "@/lib/commcare/xform/caseOps";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import { asUuid } from "@/lib/doc/types";
import {
	authoredCaseIdPrefix,
	type CaseOperation,
	deriveAuthoredCaseId,
	type Form,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	MAX_CASE_OPERATION_TEXT_LENGTH,
	prepareCaseOperationTextValue,
} from "@/lib/domain";
import {
	actingUser,
	eq,
	exists,
	formField,
	idOf,
	literal,
	prop,
	subcasePath,
	term,
	unowned,
} from "@/lib/domain/predicate";
import { evaluate } from "@/lib/preview/xpath/evaluator";

const XMLNS = "http://openrosa.org/formdesigner/nova-case-operations-test";
const NAME = asUuid("11111111-1111-4111-8111-111111111111");
const REPEAT = asUuid("22222222-2222-4222-8222-222222222222");
const ITEM_ID = asUuid("33333333-3333-4333-8333-333333333333");
const CREATE = asUuid("44444444-4444-4444-8444-444444444444");
const UPDATE = asUuid("55555555-5555-4555-8555-555555555555");
const FORM = asUuid("66666666-6666-4666-8666-666666666666");

function emit(
	operations: readonly CaseOperation[],
	fields: Parameters<typeof f>[0][] = [
		f({ uuid: NAME, kind: "text", id: "name", label: "Name" }),
	],
): string {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: "Nickname" },
					{ name: "source_id", label: "Source ID" },
				],
			},
			{ name: "visit", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ uuid: FORM, name: "Edit", type: "followup", fields }],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	(doc.forms[formUuid] as Form).caseOperations = [...operations];
	return buildXForm(doc, formUuid, {
		xmlns: XMLNS,
		moduleCaseType: "patient",
	});
}

function createOperation(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: CREATE,
		id: "create_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
		...patch,
	};
}

describe("case-operation XForm emission", () => {
	it("pins name/owner normalization and bounds across domain and XPath", () => {
		const calculation = caseOperationTextValueCalculation("/data/name");
		expect(calculation).toBe("replace(/data/name, '^\\s+|\\s+$', '')");
		const guard = caseOperationTextValueGuard(calculation);
		expect(guard).toBe(
			`string-length(${calculation}) > 0 and string-length(${calculation}) <= 255`,
		);
		const evaluateText = (value: string) =>
			evaluate(calculation, {
				getValue: (path) => (path === "/data/name" ? value : undefined),
				resolveHashtag: () => "",
				contextPath: "/data/name",
				position: 1,
				size: 1,
			});
		const evaluateGuard = (value: string) =>
			evaluate(guard, {
				getValue: (path) => (path === "/data/name" ? value : undefined),
				resolveHashtag: () => "",
				contextPath: "/data/name",
				position: 1,
				size: 1,
			});

		for (const value of [
			"\t Alice  Smith \r\n",
			`  ${"x".repeat(MAX_CASE_OPERATION_TEXT_LENGTH)}  `,
			"\u00a0name\u00a0",
		]) {
			const prepared = prepareCaseOperationTextValue(value);
			expect(prepared.ok).toBe(true);
			expect(evaluateText(value)).toBe(prepared.value);
			expect(evaluateGuard(value)).toBe(true);
		}
		for (const value of [
			" \t\n\v\f\r ",
			"x".repeat(MAX_CASE_OPERATION_TEXT_LENGTH + 1),
		]) {
			const prepared = prepareCaseOperationTextValue(value);
			expect(prepared.ok).toBe(false);
			expect(evaluateText(value)).toBe(prepared.value);
			expect(evaluateGuard(value)).toBe(false);
		}
	});

	it("freezes authored-key identity across TypeScript and on-device XPath", () => {
		const scope = {
			appId: "test-app",
			formUuid: FORM,
			operationUuid: CREATE,
			caseType: "visit",
		};
		const prefix = authoredCaseIdPrefix(scope);
		expect(prefix).toBe("nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:");
		const calculation = authoredCaseIdCalculation(scope, "/data/name");
		expect(calculation).toBe(
			"if(string-length(/data/name) > 0 and string-length(/data/name) <= 205, concat('nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:', /data/name), '')",
		);
		const evaluateKey = (key: string) =>
			evaluate(calculation, {
				getValue: (path) => (path === "/data/name" ? key : undefined),
				resolveHashtag: () => "",
				contextPath: "/data/name",
				position: 1,
				size: 1,
			});

		const exactKey = " External/42 ";
		const derived = deriveAuthoredCaseId(scope, exactKey);
		expect(derived).toEqual({
			ok: true,
			caseId: `${prefix}${exactKey}`,
		});
		expect(evaluateKey(exactKey)).toBe(`${prefix}${exactKey}`);
		expect(evaluateKey("")).toBe("");
		expect(evaluateKey("x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH))).toBe(
			`${prefix}${"x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH)}`,
		);
		expect(evaluateKey("x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH + 1))).toBe("");
		expect(deriveAuthoredCaseId(scope, "")).toMatchObject({
			ok: false,
			reason: "blank",
		});
		expect(
			deriveAuthoredCaseId(scope, "x".repeat(MAX_AUTHORED_CASE_KEY_LENGTH + 1)),
		).toMatchObject({ ok: false, reason: "too-long" });
	});

	it("emits Vellum-recognisable create data and canonical create/update/index order", () => {
		const xml = emit([
			createOperation({
				writes: [{ property: "source_id", value: term(formField(NAME)) }],
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "session" },
						relationship: "child",
					},
				],
			}),
		]);

		expect(xml).toContain(
			'<__nova_operations><create_visit vellum:role="SaveToCase"',
		);
		expect(xml).toContain('vellum:case_type="visit"');
		expect(xml).toContain(
			'<case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2">',
		);
		expect(xml).toMatch(
			/<create><case_type\/><case_name\/><owner_id\/><\/create><update><source_id\/><\/update><index><parent case_type="patient" relationship="child"\/><\/index>/,
		);
		expect(xml).toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_operations/create_visit/case/@case_id" value="uuid()"/>',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/create_visit/case/@date_modified" calculate="/data/meta/timeEnd" type="xsd:dateTime"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("puts update before index even when a non-create link has no writes", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "unlink_parent",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: null,
						relationship: "child",
					},
				],
			},
		]);

		expect(xml).toContain(
			'<update><case_type/></update><index><parent case_type="patient" relationship="child"/></index>',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/unlink_parent/case/update/case_type" calculate="&apos;patient&apos;"',
		);
		expect(xml).not.toContain('case/index/parent" calculate=');
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/unlink_parent/case/@case_id" calculate="instance(&apos;commcaresession&apos;)/session/data/case_id"',
		);
	});

	it("emits final writes before close in one block", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "finish",
				action: "close",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "nickname", value: term(literal("Done")) }],
			},
		]);

		expect(xml).toContain("<update><nickname/></update><close/>");
		expect(xml.indexOf("<update><nickname/>")).toBeLessThan(
			xml.indexOf("<close/>"),
		);
	});

	it("normalizes a pure close through an idempotent typed update so server order stays authored", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "finish",
				action: "close",
				caseType: "patient",
				target: { kind: "session" },
			},
		]);

		expect(xml).toContain("<update><case_type/></update><close/>");
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/finish/case/update/case_type" calculate="&apos;patient&apos;"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("splices repeated operations into the iteration and correlates ids relatively", () => {
		const fields = [
			f({
				uuid: REPEAT,
				kind: "repeat",
				id: "items",
				label: "Items",
				repeat_mode: "user_controlled",
				children: [
					f({ uuid: ITEM_ID, kind: "text", id: "item_id", label: "ID" }),
				],
			}),
		];
		const xml = emit(
			[
				createOperation({
					forEach: { repeat: REPEAT },
					target: { kind: "new", idFrom: ITEM_ID },
				}),
				{
					uuid: UPDATE,
					id: "tag_visit",
					action: "update",
					caseType: "visit",
					target: { kind: "op", opUuid: CREATE },
					forEach: { repeat: REPEAT },
					writes: [{ property: "source_id", value: idOf(CREATE) }],
				},
			],
			fields,
		);

		expect(xml).toMatch(
			/<items[^>]*><item_id\/><__nova_operations><create_visit[^>]*>.*<tag_visit/s,
		);
		expect(xml).toContain(
			'nodeset="/data/items/__nova_operations/create_visit/case/@case_id" calculate="if(string-length(current()/../../../../item_id) &gt; 0 and string-length(current()/../../../../item_id) &lt;= 205, concat(&apos;nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:&apos;, current()/../../../../item_id), &apos;&apos;)"',
		);
		expect(xml).toContain(
			'nodeset="/data/items/__nova_operations/tag_visit/case/@case_id" calculate="current()/../../../create_visit/case/@case_id"',
		);
		expect(xml).toContain(
			'nodeset="/data/items/__nova_operations/tag_visit/case/update/source_id" calculate="current()/../../../../create_visit/case/@case_id"',
		);
		expect(xml).not.toContain('event="xforms-ready" ref="/data/items/');
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("splices query-bound operations below the model-iteration item template", () => {
		const fields = [
			f({
				uuid: REPEAT,
				kind: "repeat",
				id: "items",
				label: "Items",
				repeat_mode: "query_bound",
				data_source: {
					ids_query: "instance('casedb')/casedb/case/@case_id",
				},
				children: [
					f({ uuid: ITEM_ID, kind: "text", id: "item_id", label: "ID" }),
				],
			}),
		];
		const xml = emit(
			[
				createOperation({
					forEach: { repeat: REPEAT },
					target: { kind: "new", idFrom: ITEM_ID },
				}),
			],
			fields,
		);

		expect(xml).toMatch(
			/<items[^>]*>.*<item[^>]*><item_id\/><__nova_operations><create_visit/s,
		);
		expect(xml).toContain(
			'nodeset="/data/items/item/__nova_operations/create_visit/case/@case_id" calculate="if(string-length(current()/../../../../item_id) &gt; 0 and string-length(current()/../../../../item_id) &lt;= 205, concat(&apos;nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:&apos;, current()/../../../../item_id), &apos;&apos;)"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("keeps repeated form/id bindings anchored when a relation predicate changes context", () => {
		const fields = [
			f({
				uuid: REPEAT,
				kind: "repeat",
				id: "items",
				label: "Items",
				repeat_mode: "user_controlled",
				children: [
					f({ uuid: ITEM_ID, kind: "text", id: "item_id", label: "ID" }),
				],
			}),
		];
		const xml = emit(
			[
				createOperation({ forEach: { repeat: REPEAT } }),
				{
					uuid: UPDATE,
					id: "tag_visit",
					action: "update",
					caseType: "visit",
					target: { kind: "op", opUuid: CREATE },
					forEach: { repeat: REPEAT },
					condition: exists(
						subcasePath("parent", "visit"),
						eq(formField(ITEM_ID), idOf(CREATE)),
					),
				},
			],
			fields,
		);

		// `current()` stays on the operation wrapper while the relation filter
		// evaluates with each candidate case as its temporary context.
		expect(xml).toContain(
			"current()/../../item_id = current()/../create_visit/case/@case_id",
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("keeps singular effects before repeat-scoped effects in submission order", () => {
		const fields = [
			f({
				uuid: REPEAT,
				kind: "repeat",
				id: "items",
				label: "Items",
				repeat_mode: "user_controlled",
				children: [
					f({ uuid: ITEM_ID, kind: "text", id: "item_id", label: "ID" }),
				],
			}),
		];
		const xml = emit(
			[
				createOperation({ order: "a" }),
				{
					uuid: UPDATE,
					id: "tag_each_visit",
					order: "b",
					action: "update",
					caseType: "visit",
					target: { kind: "op", opUuid: CREATE },
					forEach: { repeat: REPEAT },
				},
			],
			fields,
		);

		expect(xml.indexOf("<__nova_operations><create_visit")).toBeLessThan(
			xml.indexOf("<items"),
		);
		expect(xml.indexOf("<create_visit")).toBeLessThan(
			xml.indexOf("<tag_each_visit"),
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("keeps advanced effects before Nova's ordinary primary-case action", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "nickname", label: "Nickname" }],
				},
				{ name: "visit", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Edit",
							type: "followup",
							fields: [
								f({
									uuid: NAME,
									kind: "text",
									id: "nickname",
									label: "Nickname",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [createOperation()];

		const source = buildXForm(doc, formUuid, {
			xmlns: XMLNS,
			moduleCaseType: "patient",
		});
		const withOrdinaryAction = addMetaBlock(
			addCaseBlocks(
				source,
				buildFormActions(doc, formUuid, "patient"),
				"patient",
			),
		);
		const advancedEnd = withOrdinaryAction.indexOf("</__nova_operations>");
		const ordinaryStart = withOrdinaryAction.indexOf(
			'<case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2">',
			advancedEnd,
		);

		expect(advancedEnd).toBeGreaterThan(-1);
		expect(ordinaryStart).toBeGreaterThan(advancedEnd);
		expect(withOrdinaryAction.slice(ordinaryStart)).toContain(
			"<update><nickname/></update>",
		);
		expect(validateXForm(withOrdinaryAction, "Edit", "Patients")).toEqual([]);
	});

	it("inherits a conditional create guard across every id dependency", () => {
		const xml = emit([
			createOperation({
				condition: eq(formField(NAME), literal("ready")),
			}),
			{
				uuid: UPDATE,
				id: "tag_created_visit",
				action: "update",
				caseType: "visit",
				target: { kind: "op", opUuid: CREATE },
			},
		]);

		expect(xml).toContain(
			'nodeset="/data/__nova_operations/create_visit" relevant="/data/name = &apos;ready&apos;"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/tag_created_visit" relevant="/data/name = &apos;ready&apos;"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("inherits a conditional retype guard across later destination-type effects", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "promote_patient",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "visit",
				condition: eq(formField(NAME), literal("ready")),
			},
			{
				uuid: CREATE,
				id: "update_promoted_visit",
				order: "b",
				action: "update",
				caseType: "visit",
				target: { kind: "session" },
			},
		]);

		expect(xml).toContain(
			'nodeset="/data/__nova_operations/promote_patient" relevant="/data/name = &apos;ready&apos;"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/update_promoted_visit" relevant="/data/name = &apos;ready&apos;"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("keeps exact expression targets on their pre-submission lookup type after retype", () => {
		const runtimeTarget = {
			kind: "expression" as const,
			expr: term(literal("runtime-case-id")),
		};
		const xml = emit([
			{
				uuid: CREATE,
				id: "promote_patient",
				order: "a",
				action: "update",
				caseType: "patient",
				target: runtimeTarget,
				retype: "visit",
			},
			{
				uuid: UPDATE,
				id: "update_promoted_visit",
				order: "b",
				action: "update",
				caseType: "visit",
				target: runtimeTarget,
			},
		]);

		const snapshotSelector =
			"instance(&apos;casedb&apos;)/casedb/case[@case_id=(&apos;runtime-case-id&apos;) and @case_type=&apos;patient&apos;]/@case_id";
		const postRetypeSelector =
			"instance(&apos;casedb&apos;)/casedb/case[@case_id=(&apos;runtime-case-id&apos;) and @case_type=&apos;visit&apos;]/@case_id";
		expect(xml.split(snapshotSelector)).toHaveLength(3);
		expect(xml).not.toContain(postRetypeSelector);
		const retypeGuardId = `__nova_guard_${CREATE.replaceAll("-", "_")}_retype_identity`;
		expect(xml).toContain(
			`<${retypeGuardId}><case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><update/></case></${retypeGuardId}>`,
		);
		expect(xml.indexOf(`<${retypeGuardId}>`)).toBeGreaterThan(
			xml.indexOf("<promote_patient"),
		);
		expect(xml).toContain(
			`nodeset="/data/__nova_operations/${retypeGuardId}/case/@case_id" calculate="if(not(starts-with(/data/__nova_operations/promote_patient/case/@case_id, &apos;nova-case-v1:&apos;)), /data/__nova_operations/promote_patient/case/@case_id, &apos;&apos;)"`,
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("anchors case-property reads on the loaded pre-submission case and declares instances", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "copy_name",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "nickname",
						value: term(prop("patient", "case_name")),
					},
				],
			},
		]);

		expect(xml).toContain('<instance src="jr://instance/casedb" id="casedb"/>');
		expect(xml).toContain(
			'<instance src="jr://instance/session" id="commcaresession"/>',
		);
		expect(xml).toContain(
			'calculate="instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/case_id]/case_name"',
		);
	});

	it("emits authored ids, update facets, runtime targets, and both condition scopes", () => {
		const xml = emit([
			createOperation({
				order: "a",
				target: { kind: "new", idFrom: NAME },
			}),
			{
				uuid: UPDATE,
				id: "revise_patient",
				order: "b",
				action: "update",
				caseType: "patient",
				target: {
					kind: "expression",
					expr: term(literal("runtime-patient-id")),
				},
				condition: eq(formField(NAME), literal("ready")),
				owner: term(literal("owner-2")),
				rename: term(literal("Renamed")),
				retype: "visit",
				writes: [
					{
						property: "source_id",
						value: term(formField(NAME)),
						condition: eq(formField(NAME), literal("write")),
					},
				],
			},
		]);

		// Fractional order, not membership-array position, is emission order.
		expect(xml.indexOf("<create_visit")).toBeLessThan(
			xml.indexOf("<revise_patient"),
		);
		expect(xml).toContain(
			"<update><case_name/><case_type/><owner_id/><source_id/></update>",
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient" relevant="/data/name = &apos;ready&apos;"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient/case/update/source_id" relevant="/data/name = &apos;write&apos;" calculate="/data/name"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient/case/@case_id" calculate="instance(&apos;casedb&apos;)/casedb/case[@case_id=(&apos;runtime-patient-id&apos;) and @case_type=&apos;patient&apos;]/@case_id"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient/case/update/case_name" calculate="replace(&apos;Renamed&apos;, &apos;^\\s+|\\s+$&apos;, &apos;&apos;)"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient/case/update/case_type" calculate="&apos;visit&apos;"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/revise_patient/case/update/owner_id" calculate="replace(&apos;owner-2&apos;, &apos;^\\s+|\\s+$&apos;, &apos;&apos;)"',
		);
		const textGuardId = `__nova_guard_${UPDATE.replaceAll("-", "_")}_text`;
		expect(xml).toContain(
			`nodeset="/data/__nova_operations/${textGuardId}" relevant="/data/name = &apos;ready&apos;"`,
		);
		expect(xml).toContain(
			`nodeset="/data/__nova_operations/${textGuardId}/case/@case_id" calculate="if((string-length(/data/__nova_operations/revise_patient/case/update/case_name) &gt; 0 and string-length(/data/__nova_operations/revise_patient/case/update/case_name) &lt;= 255) and (string-length(/data/__nova_operations/revise_patient/case/update/owner_id) &gt; 0 and string-length(/data/__nova_operations/revise_patient/case/update/owner_id) &lt;= 255), /data/__nova_operations/revise_patient/case/@case_id, &apos;&apos;)"`,
		);
		expect(xml).toContain(
			'<bind nodeset="/data/__nova_operations/create_visit/case/@case_id" calculate="if(string-length(/data/name) &gt; 0 and string-length(/data/name) &lt;= 205, concat(&apos;nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:&apos;, /data/name), &apos;&apos;)"/>',
		);
		expect(xml).not.toContain(
			'<setvalue event="xforms-ready" ref="/data/__nova_operations/create_visit/case/@case_id"',
		);
		expect(xml).not.toContain("_authored_id");
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("guards runtime-resolved link targets with a typed no-op block", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "link_visit",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				links: [
					{
						identifier: "visit",
						targetType: "visit",
						target: {
							kind: "expression",
							expr: term(literal("runtime-visit-id")),
						},
						relationship: "child",
					},
				],
			},
		]);

		const guardId = `__nova_guard_${UPDATE.replaceAll("-", "_")}_0`;
		const guard = `<${guardId}><case case_id="" date_modified="" user_id="" xmlns="http://commcarehq.org/case/transaction/v2"><update/></case></${guardId}>`;
		expect(xml).toContain(guard);
		expect(xml.indexOf(guard)).toBeGreaterThan(xml.indexOf("<link_visit"));
		const typedTarget =
			"instance(&apos;casedb&apos;)/casedb/case[@case_id=(&apos;runtime-visit-id&apos;) and @case_type=&apos;visit&apos;]/@case_id";
		// Link calculate once, then count + scalar self-link comparison in the
		// trailing guard.
		expect(xml.split(typedTarget)).toHaveLength(4);
		expect(xml).toContain(
			`nodeset="/data/__nova_operations/${guardId}/case/@case_id" calculate="if(count(${typedTarget}) &gt; 0 and string(${typedTarget}) != /data/__nova_operations/link_visit/case/@case_id, /data/__nova_operations/link_visit/case/@case_id, &apos;&apos;)"`,
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("emits explicit acting-user and unowned owner values", () => {
		const xml = emit([
			{
				uuid: CREATE,
				id: "assign_user",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: actingUser(),
			},
			{
				uuid: UPDATE,
				id: "remove_owner",
				order: "b",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: unowned(),
			},
		]);

		expect(xml).toContain(
			'nodeset="/data/__nova_operations/assign_user/case/update/owner_id" calculate="replace(/data/meta/userID, &apos;^\\s+|\\s+$&apos;, &apos;&apos;)"',
		);
		expect(xml).toContain(
			'nodeset="/data/__nova_operations/remove_owner/case/update/owner_id" calculate="replace(&apos;-&apos;, &apos;^\\s+|\\s+$&apos;, &apos;&apos;)"',
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});

	it("anchors relation roots on the loaded case while keeping related filters candidate-relative", () => {
		const xml = emit([
			{
				uuid: UPDATE,
				id: "update_if_child_matches",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: exists(
					subcasePath("parent", "patient"),
					eq(prop("patient", "nickname"), literal("child")),
				),
			},
		]);

		expect(xml).toContain('<instance src="jr://instance/casedb" id="casedb"/>');
		expect(xml).toContain(
			'<instance src="jr://instance/session" id="commcaresession"/>',
		);
		expect(xml).toContain(
			"selected(join(&apos; &apos;, instance(&apos;casedb&apos;)/casedb/case[@case_type=&apos;patient&apos; and (nickname = &apos;child&apos;)]/index/parent), instance(&apos;commcaresession&apos;)/session/data/case_id)",
		);
		expect(xml).not.toContain(
			"case[@case_type=&apos;patient&apos; and (instance(&apos;casedb&apos;)",
		);
		expect(validateXForm(xml, "Edit", "Patients")).toEqual([]);
	});
});
