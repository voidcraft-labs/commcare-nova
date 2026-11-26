import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { readingAppStrings } from "@/lib/deployment/reading/appStrings";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { parseFormExpressionForSlot } from "@/lib/doc/expressionText";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { androidDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { buildEngineInput } from "@/lib/preview/engine/engineInput";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { readExpression } from "../readExpression";
import { readEnv, registration } from "./expressionReadFixture";

const MENU = testUuid("lookup-count-menu");
const FORM = testUuid("lookup-count-form");
const FIELD = testUuid("lookup-count-field");
const MIRROR = testUuid("lookup-count-mirror");
const leaf: Expression = { kind: "case-list-lookup-count", module: MENU };
const slot: SlotContextRef = {
	entity: "field",
	uuid: FIELD,
	slot: "calculate",
};
const node = "instance('commcaresession')/session/data/fingerprintquery";
const guard = `if(count(${node}) = 1, number(${node}[1]), '')`;

function document() {
	return buildDoc({
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [{ name: "visit", properties: [] }],
		modules: [
			{
				uuid: MENU,
				name: "Visits",
				caseType: "visit",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					deviceLookup: {
						action: "org.nova.proof.CASE_LOOKUP",
						label: "Find a visit",
						extras: [{ name: "mode", value: "visits" }],
						responses: ["first"],
					},
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note", label: "Note" }),
							f({
								kind: "hidden",
								id: "lookup_count",
								uuid: FIELD,
								calculate: leaf,
							}),
						],
					},
				],
			},
		],
	});
}

it("binds only the guarded number to the physical entry's one lookup", () => {
	const doc = document();
	expect(
		parseFormExpressionForSlot(
			doc,
			slot,
			"case-list-lookup-count()",
			new Map(),
		),
	).toMatchObject({
		ok: true,
		expression: leaf,
	});
	expect(
		readExpression(doc, registration(doc, slot, guard), readEnv()),
	).toMatchObject({
		kind: "bound",
		candidate: leaf,
		equal: true,
	});
	expect(
		readExpression(doc, registration(doc, slot, node), readEnv()),
	).toMatchObject({
		kind: "refused",
	});
	const arbitraryFirst = guard.replace(" = 1", " > 0");
	expect(
		readExpression(doc, registration(doc, slot, arbitraryFirst), readEnv()),
	).toMatchObject({
		kind: "refused",
	});
});

it("holds the count's surface claim through an HQ app reading", async () => {
	const input = await inputFor(exportedBody(document()), {
		appStrings: readingAppStrings(LOOKUP_CONTEXT_UNAVAILABLE),
	});
	const read = readHqApp(input);
	if (read.kind === "account") throw new Error(JSON.stringify(read.findings));
	const doc = read.draft.doc;
	const count = Object.values(doc.fields).find(
		(field) => field.id === "lookup_count",
	);
	expect(count?.calculate).toEqual({
		kind: "case-list-lookup-count",
		module: doc.moduleOrder[0],
	});
});

it("refuses a mirror route and keeps the reference bound when the source is renamed", () => {
	const doc = document();
	doc.modules[MENU].name = "Home visits";
	expect(
		readExpression(doc, registration(doc, slot, guard), readEnv()),
	).toMatchObject({
		kind: "bound",
		candidate: leaf,
		equal: true,
	});
	const mirror = {
		uuid: MIRROR,
		id: "other_route",
		name: "Other route",
		formsFromMenu: { menuUuid: MENU },
	};
	const verdict = mutationCommitVerdict(
		doc,
		[{ kind: "addModule", module: mirror }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict).toMatchObject({
		ok: false,
		findings: expect.arrayContaining([
			expect.objectContaining({
				code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
				details: expect.objectContaining({
					reason: "case-list-lookup-count-source",
				}),
			}),
		]),
	});
	doc.modules[MIRROR] = mirror;
	doc.moduleOrder.push(MIRROR);
	const context = slotContext(doc, slot, new Map());
	expect(context).toBeDefined();
	if (!context) throw new Error("Missing calculation slot.");
	expect(checkExpression(leaf, context)).toMatchObject({
		errors: [
			expect.objectContaining({ reason: "case-list-lookup-count-source" }),
		],
	});
	expect(
		readExpression(doc, registration(doc, slot, guard), readEnv()),
	).toMatchObject({
		kind: "refused",
	});
});

it("leaves the count empty in Android Preview without a companion response", () => {
	const doc = document();
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("Missing Preview form.");
	const engine = new FormEngine(
		input,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device: androidDevice() },
	);
	engine.evaluatePathsInto(engine.getAllPaths());
	expect(engine.getState("/data/lookup_count")?.value).toBe("");
});
