/**
 * A record slot's expression leaf a declared platform lacks: `here()` in a
 * case list's calculated column, in an app that runs in Web Apps.
 *
 * Contract: the finding keeps its slot's code, so it stays located at its
 * module and outside the scope-exempt set (a scoped commit of another module
 * never meets it); it carries the checker's `platform-unavailable` with the
 * feature and the platform; its message is the platform refusal with the
 * column as its subject, not wrapped in operand-type advice; the builder and
 * the editor each speak it in their own voice. The slot rule still comes
 * first: `here()` outside a calculated column keeps its own reason whatever
 * the declaration.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { presentCheckErrorForEditor } from "@/components/builder/shared/checkErrorPresentation";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	calculatedColumn,
	NEW_APP_SETTINGS,
	type Platform,
	proseText,
} from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import type { ValidationError } from "../errors";
import { errorWithinScope, runValidation } from "../runner";

const MODULE = testUuid("record-platform-module");
const COLUMN = testUuid("record-platform-column");
const HIDDEN = testUuid("record-platform-hidden");

function patients(runsOnlyOn?: Platform): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [
		...config.columns,
		calculatedColumn(COLUMN, "Distance", { kind: "here" }),
	];
	config.listColumnOrder = config.columns.map((column) => column.uuid);
	config.detailColumnOrder = config.columns.map((column) => column.uuid);
	return buildDoc({
		appName: "Here",
		appSettings: {
			...NEW_APP_SETTINGS,
			...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
		},
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

function platformFindings(doc: BlueprintDoc): ValidationError[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) => error.details?.checkReason === "platform-unavailable",
	);
}

describe("here() in a calculated column of an app that runs in Web Apps", () => {
	const [finding, ...rest] = platformFindings(patients());

	it("keeps the column's code and carries the platform refusal", () => {
		expect(rest).toEqual([]);
		expect(finding?.code).toBe("CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR");
		expect(finding?.details).toMatchObject({
			checkCode: "arm-unavailable",
			checkReason: "platform-unavailable",
			feature: "case-list-here",
			platform: "web-apps",
			slotCode: "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			columnUuid: COLUMN,
		});
	});

	it("speaks to the agent with the column as its subject", () => {
		expect(finding?.message).toBe(
			'Calculated column "Distance" in module "Patients" reads here(), the worker\'s location, and the app runs in Web Apps and on Android. Web Apps doesn\'t know where the worker is, so here() reads blank there, or a fixed place while the list is built. You can take here() out of this value, or, if workers use only the CommCare app on Android, set the app to run only on Android (updateApp/update_app, runs_only_on "android").',
		);
	});

	it("speaks to the builder and the editor in their own voices", () => {
		expect(userFacingError(finding as ValidationError)).toBe(
			"A calculated value in \"Patients\" uses the worker's location, which Web Apps doesn't know. You can take it out of the value, or set the app to run only on Android in App settings.",
		);
		const doc = patients();
		const ctx = slotContext(
			doc,
			{
				entity: "module",
				uuid: MODULE,
				slot: "case_list_column_expression",
				member: { columnUuid: COLUMN },
			},
			new Map(),
		);
		if (ctx === undefined) throw new Error("The column has no context.");
		const [error] = checkExpression({ kind: "here" }, ctx).errors;
		expect(error?.platform).toEqual({
			feature: "case-list-here",
			platform: "web-apps",
		});
		expect(presentCheckErrorForEditor(error as never)).toBe(
			"Not available in Web Apps, where this app runs",
		);
	});

	it("stays located at its module, so a scoped commit elsewhere never meets it", () => {
		expect(
			errorWithinScope(finding as ValidationError, {
				moduleUuids: new Set([testUuid("another-module")]),
			}),
		).toBe(false);
		expect(
			errorWithinScope(finding as ValidationError, {
				moduleUuids: new Set([MODULE]),
			}),
		).toBe(true);
	});
});

it("finds nothing for the same column in an app that runs only on Android", () => {
	expect(platformFindings(patients("android"))).toEqual([]);
});

it("keeps here()'s own reason in a form's calculate, whatever the declaration", () => {
	for (const runsOnlyOn of [undefined, "web-apps", "android"] as const) {
		const doc = buildDoc({
			appName: "Form here",
			appSettings: {
				...NEW_APP_SETTINGS,
				...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
			},
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
								f({
									kind: "hidden",
									id: "where",
									uuid: HIDDEN,
									calculate: "1",
								}),
							],
						},
					],
				},
			],
		});
		const field = doc.fields[HIDDEN];
		if (field === undefined) throw new Error("No hidden value.");
		const ctx = slotContext(
			doc,
			{ entity: "field", uuid: HIDDEN, slot: "calculate" },
			new Map(),
		);
		if (ctx === undefined) throw new Error("The calculate has no context.");
		expect(
			checkExpression({ kind: "here" }, ctx).errors.map(
				(error) => error.reason,
			),
		).toContain("here");
	}
});
