/**
 * Four prints of a date-and-time case property, each driven through the
 * production emitters and held to the repo's wire oracles
 * (`checkCompilerEvidence`): a `datetime-coerce` and a `format-date` with the
 * short preset in a case list's calculated column, a case menu with no case
 * list, and a form's display condition comparing the property with `now()`,
 * which the reader of CommCare HQ's apps also reads back from both spellings
 * HQ can hold.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { deviceInstantText } from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, calculatedColumn, proseText } from "@/lib/domain";
import {
	datetimeCoerce,
	type Expression,
	formatDate,
	gt,
	now,
	prop,
	term,
} from "@/lib/domain/expression";
import { readHqApp } from "../reader";
import { exportedBody, inputFor } from "../reader/__tests__/novaExport";
import { checkCompilerEvidence } from "./compilerEvidence";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import {
	onlyXml,
	readXmlEvidence,
	type XmlEvidence,
	xmlChildren,
} from "./xmlEvidence";

const SEEN = term(prop("visit", "seen"));
const SEEN_LATER_THAN_NOW = gt(SEEN, now());

/** A follow-up of `visit` cases, `seen` a date and time, in a menu with
 *  `module`'s case list. */
function visitDoc(
	module: { readonly caseListConfig?: ReturnType<typeof caseListConfig> },
	displayCondition?: Expression,
): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				...module,
				forms: [
					{
						name: "Check",
						type: "followup",
						...(displayCondition === undefined ? {} : { displayCondition }),
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
}

/** The case list of `Name` and one calculated column of `expression`. */
function withCalculatedColumn(expression: Expression) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	const column = calculatedColumn(testUuid("print-seen"), "Seen", expression);
	return {
		...config,
		columns: [...config.columns, column],
		listColumnOrder: [...config.listColumnOrder, column.uuid],
		detailColumnOrder: [...config.detailColumnOrder, column.uuid],
	};
}

function localSuite(doc: BlueprintDoc): XmlEvidence {
	const zip = new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
		}),
	);
	const suite = zip.getEntry("suite.xml");
	if (suite === null) throw new Error("The archive has no suite.xml.");
	return readXmlEvidence(suite.getData().toString("utf8"));
}

/** Every element named `name` under `node`, at any depth. */
function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return node.children.flatMap((child) => [
		...(child.name === name ? [child] : []),
		...descendants(child, name),
	]);
}

/** The XPath the local short detail's last field computes. */
function lastShortFieldXPath(doc: BlueprintDoc): string | undefined {
	const detail = xmlChildren(localSuite(doc), "detail").find(
		(one) => one.attributes.id === "m0_case_short",
	);
	if (detail === undefined) throw new Error("No short detail for m0.");
	const field = xmlChildren(detail, "field").at(-1);
	if (field === undefined) throw new Error("The short detail has no field.");
	return onlyXml(descendants(field, "variable")).children[0]?.attributes
		.function;
}

/** The short detail column HQ JSON writes last for the first menu. */
function lastHqShortColumn(doc: BlueprintDoc) {
	return expandDoc(doc).modules[0]?.case_details.short.columns.at(-1);
}

/** The case property `seen` as a case list column reads it. */
const SEEN_WIRE = w.context([w.step("seen")]);

describe("a datetime-coerce of a date-and-time property", () => {
	it("prints the stored text itself, which already names the moment, in both exports", () => {
		const doc = visitDoc({
			caseListConfig: withCalculatedColumn(datetimeCoerce(SEEN)),
		});
		checkCompilerEvidence(doc);
		expect(lastHqShortColumn(doc)).toMatchObject({
			field: "seen",
			useXpathExpression: true,
		});
		expect(lastShortFieldXPath(doc)).toBe("seen");
	});
});

describe("a format-date of a date-and-time property with the short preset", () => {
	it("formats the device's own date for the moment with Core's %m/%d/%Y", () => {
		const doc = visitDoc({
			caseListConfig: withCalculatedColumn(formatDate(SEEN, "short")),
		});
		checkCompilerEvidence(doc);
		// Core's `DateUtils.format` reads `%m`, `%d` and `%Y`; the stored UTC
		// text is first respelled in the device's zone, since Core's parse keeps
		// the written date (`instant.ts::deviceInstantText`).
		const expected = serializeWire(
			w.call("format-date", [deviceInstantText(SEEN_WIRE), w.str("%m/%d/%Y")]),
			{ target: "suite" },
		).text;
		expect(lastShortFieldXPath(doc)).toBe(expected);
		expect(lastHqShortColumn(doc)?.field).toBe(expected);
	});
});

describe("a case menu with no case list", () => {
	it("is refused at the gate, so no export writes a detail with no field to choose its case from", () => {
		const errors = runValidation(visitDoc({}), LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.map((error) => error.code)).toEqual([
			"MISSING_CASE_LIST_COLUMNS",
		]);
	});
});

describe("a form's display condition comparing a date-and-time property with now()", () => {
	const doc = visitDoc(
		{
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		},
		SEEN_LATER_THAN_NOW,
	);

	it("prints in both exports, each held by its oracle", () => {
		checkCompilerEvidence(doc);
		expect(expandDoc(doc).modules[0]?.forms[0]?.form_filter).toBeTruthy();
		const menu = xmlChildren(localSuite(doc), "menu").find(
			(one) => one.attributes.id === "m0",
		);
		const command = menu?.children.find((one) => one.attributes.id === "m0-f0");
		expect(command?.attributes.relevant).toBeTruthy();
	});

	/** The condition a reading of `body` holds on the form `Check`. */
	async function readCondition(body: Record<string, unknown>) {
		const outcome = readHqApp(await inputFor(body));
		if (outcome.kind !== "read")
			throw new Error(
				`The reading is an account: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
			);
		return Object.values(outcome.draft.doc.forms).find(
			(form) => form.name === "Check",
		)?.displayCondition;
	}

	it("reads back from Nova's own lowered print", async () => {
		expect(await readCondition(exportedBody(doc))).toEqual(SEEN_LATER_THAN_NOW);
	});

	it("reads back from the bare comparison a person writes in CommCare HQ", async () => {
		const body = exportedBody(doc, {
			modules: (modules) =>
				modules.map((module) => ({
					...module,
					forms: (module.forms as Record<string, unknown>[]).map((form) => ({
						...form,
						form_filter: "#case/seen > now()",
					})),
				})),
		});
		expect(await readCondition(body)).toEqual(SEEN_LATER_THAN_NOW);
	});
});
