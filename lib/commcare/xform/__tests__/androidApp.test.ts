import { type Element, isTag } from "domhandler";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type Field, NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { literal, toExpression } from "@/lib/domain/expression/builders";
import { expandDoc } from "../../expander";
import { requiredPlanFeatures } from "../../planPrivileges";
import { readHqApp } from "../../reader";
import { exportedBody, inputFor } from "../../reader/__tests__/novaExport";
import { parseXml } from "../../xmlParse";
import { androidAppAnswerProblem } from "../androidApp";

const question = testUuid("external-app");
const destination = testUuid("recorded-count");

function appWithQuestion(action: string) {
	return buildDoc({
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Record a reading",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: question,
								id: "read",
								label: proseText("Take a reading"),
								androidApp: {
									kind: "open-app",
									action,
									send: [
										{
											name: "unit",
											value: toExpression(literal("per minute")),
										},
									],
									receive: [{ name: "measurement", question: destination }],
								},
							}),
							f({
								kind: "int",
								uuid: destination,
								id: "count",
								label: proseText("Count"),
								androidApp: { kind: "use-question", question },
							}),
						],
					},
				],
			},
		],
	});
}
function descendants(element: Element): Element[] {
	return [element, ...element.children.filter(isTag).flatMap(descendants)];
}

it("opens the same action from two inputs and keeps each input’s answer type", () => {
	const action = "org.commcare.respiratory.BREATHCOUNT";
	const doc = appWithQuestion(action);
	const source = Object.values(expandDoc(doc)._attachments).find(
		(value): value is string => typeof value === "string",
	);
	if (!source) throw new Error("The app contains no form.");
	const elements = parseXml(source).children.filter(isTag).flatMap(descendants);
	const head = elements.find((el) => el.name === "h:head");
	const intent = head?.children
		.filter(isTag)
		.find((el) => el.name === "odkx:intent");
	expect(intent?.attribs).toEqual({
		id: "read",
		class: action,
		"xmlns:odkx": "http://opendatakit.org/xforms",
	});
	expect(
		intent?.children
			.filter(isTag)
			.map((el) => [el.name, el.attribs.key, el.attribs.ref]),
	).toEqual([
		["extra", "unit", "'per minute'"],
		["response", "measurement", "/data/count"],
	]);
	expect(
		elements
			.filter((el) => el.name === "input")
			.map((el) => [el.attribs.ref, el.attribs.appearance]),
	).toEqual([
		["/data/read", "intent:read"],
		["/data/count", "intent:read"],
	]);
	expect(
		elements
			.filter(
				(el) =>
					el.name === "bind" &&
					["/data/read", "/data/count"].includes(el.attribs.nodeset ?? ""),
			)
			.map((el) => el.attribs.type),
	).toEqual(["intent", "xsd:int"]);
});

it.each([
	["org.commcare.respiratory.BREATHCOUNT", "built-in-android-apps"],
	["org.example.MEASURE", "external-android-apps"],
])("confirms the privilege HQ needs to build %s", (action, feature) => {
	const doc = appWithQuestion(action);
	const uses = requiredPlanFeatures(
		doc,
		{ lookupTables: false, places: false },
		null,
	);
	expect(
		uses.filter((use) => use.id.endsWith("-android-apps")).map((use) => use.id),
	).toEqual([feature]);
});

it("adopts the action, sent expression, typed destination and ordinary input together", async () => {
	const action = "org.example.MEASURE";
	const doc = structuredClone(appWithQuestion(action));
	const configured = doc.fields[question];
	if (configured?.kind !== "text" || configured.androidApp?.kind !== "open-app")
		throw new Error("Expected an Android app question.");
	configured.androidApp.send.unshift({
		name: "unit",
		value: toExpression(literal("per hour")),
	});
	const body = exportedBody(doc);
	const outcome = readHqApp(await inputFor(body));
	if (outcome.kind !== "read")
		throw new Error(
			JSON.stringify({ findings: outcome.findings, defects: outcome.defects }),
		);
	expect(outcome.defects).toEqual([]);
	const fields = Object.values(outcome.draft.doc.fields);
	const source = fields.find((field) => field.id === "read");
	const target = fields.find((field) => field.id === "count");
	expect(source?.kind === "text" && source.androidApp).toEqual({
		kind: "open-app",
		action,
		send: [
			{ name: "unit", value: toExpression(literal("per hour")) },
			{ name: "unit", value: toExpression(literal("per minute")) },
		],
		receive: [{ name: "measurement", question: target?.uuid }],
	});
	expect(target?.kind === "int" && target.androidApp).toEqual({
		kind: "use-question",
		question: source?.uuid,
	});
});

it("accounts for a result pointing into a different repeat while keeping expression claims complete", async () => {
	const doc = buildDoc({
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				name: "Equipment",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "meter",
								uuid: question,
								label: proseText("Meter"),
								androidApp: {
									kind: "open-app",
									action: "org.example.MEASURE",
									send: [
										{ name: "unit", value: toExpression(literal("litres")) },
									],
									receive: [{ name: "value", question }],
								},
							}),
							f({
								kind: "repeat",
								id: "items",
								label: proseText("Item"),
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [
									f({
										kind: "int",
										id: "reading",
										label: proseText("Reading"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const body = exportedBody(doc, {
		xml: (xml) =>
			xml.replace(
				/<response\b[^>]*\/>/,
				'<response key="value" ref="/data/items/reading"/>',
			),
	});
	const result = readHqApp(await inputFor(body));
	if (result.kind !== "account")
		throw new Error("Expected the result mapping to be refused.");
	expect(result.defects).toEqual([]);
	expect(result.findings).toContainEqual(
		expect.objectContaining({
			code: "questions/android-app-callout-that-cannot-be-recreated",
			place: expect.objectContaining({ path: "meter" }),
		}),
	);
});

it("accounts for every invoking input when two head actions share a question ID", async () => {
	const doc = appWithQuestion("org.example.MEASURE");
	const body = exportedBody(doc, {
		xml: (xml) =>
			xml.replace(
				/<odkx:intent\b[\s\S]*?<\/odkx:intent>/,
				(first) =>
					first + first.replace("org.example.MEASURE", "org.example.OTHER"),
			),
	});
	const result = readHqApp(await inputFor(body));
	if (result.kind !== "account")
		throw new Error("Expected the overlapping actions to be refused.");
	expect(result.defects).toEqual([]);
	expect(
		result.findings
			.filter(
				(finding) =>
					finding.code ===
					"questions/android-app-callout-that-cannot-be-recreated",
			)
			.map((finding) =>
				finding.place.kind === "question" ? finding.place.path : undefined,
			)
			.sort(),
	).toEqual(["count", "read"]);
});

it("refuses appearance settings on both the owner and a second invoking input", () => {
	const doc = appWithQuestion("org.example.MEASURE");
	const [form] = Object.values(doc.forms);
	const owner = doc.fields[question];
	const auxiliary = doc.fields[destination];
	if (owner.kind !== "text" || auxiliary.kind !== "int")
		throw new Error("Expected a text owner and a number input.");
	expect(androidAppAnswerProblem(doc, form.uuid, owner)).toBeUndefined();
	expect(androidAppAnswerProblem(doc, form.uuid, auxiliary)).toBeUndefined();
	const incompatible: Field[] = [
		{ ...owner, sendTopics: ["updates"] },
		{ ...auxiliary, inputWidth: "short" },
	];
	for (const field of incompatible) {
		expect(androidAppAnswerProblem(doc, form.uuid, field)).toMatch(
			"remove the question’s appearance settings",
		);
	}
});
