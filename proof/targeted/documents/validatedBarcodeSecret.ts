/**
 * Defect 8: a barcode question and a secret question, each with a validation.
 *
 * Nova's gate admits `validate` on both kinds
 * (`lib/commcare/validator/rules/field.ts::KINDS_SUPPORTING_VALIDATION`), and
 * its emitter writes a constraint only for kinds
 * `lib/commcare/constants.ts::supportsValidation` names, which excludes both,
 * so Core accepts an answer the author's validation refuses
 * (`javarosa form/api/FormEntryController.java::answerQuestion`).
 *
 * Fixed values: each validation asks for exactly six characters, so a
 * three-character answer breaks it and a six-character one keeps it.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";

const ID = "targeted-validated-barcode-secret";
const uuid = (name: string) => targetedUuid(ID, name);

export function validatedBarcodeSecret() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Validated codes",
		modules: [
			{
				uuid: uuid("module"),
				name: "Codes",
				forms: [
					{
						uuid: form,
						name: "Scan",
						type: "survey",
						fields: [
							f({
								kind: "barcode",
								uuid: uuid("code"),
								id: "code",
								label: proseText("Code"),
								validate: "string-length(.) = 6",
								validate_msg: "A code has six characters.",
							}),
							f({
								kind: "secret",
								uuid: uuid("pin"),
								id: "pin",
								label: proseText("PIN"),
								validate: "string-length(.) = 6",
								validate_msg: "A PIN has six characters.",
							}),
						],
					},
				],
			},
		],
	});
	const request = {
		constraintChecks: [
			{ path: "/data/code", value: "abc" },
			{ path: "/data/code", value: "abcdef" },
			{ path: "/data/pin", value: "123" },
			{ path: "/data/pin", value: "123456" },
		],
	};
	const expectation = (exportName: "local" | "A") => ({
		id: `six-characters-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		request,
		expect: [
			{ pointer: "/constraints/0/result", value: "constraint" },
			{ pointer: "/constraints/1/result", value: "ok" },
			{ pointer: "/constraints/2/result", value: "constraint" },
			{ pointer: "/constraints/3/result", value: "ok" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["8"],
		doc,
		expected: { intent: [expectation("local"), expectation("A")] },
	});
}
