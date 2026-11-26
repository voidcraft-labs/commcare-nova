import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import {
	formSubmitWording,
	localizeTranslationUnit,
	makeTranslationUnitId,
	snapshotTranslationUnits,
} from "@/lib/domain";
import { inSpanish, readMenusOf } from "./menuReading";

it.each([
	{ en: "Send visit", es: "" },
	{ es: "Enviar" },
	{ en: "Send visit", es: "Send visit" },
	{ en: "Send visit" },
])("reads and re-emits each configured form button (%j)", async (held) => {
	const doc = inSpanish(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
			],
		}),
		new Map(),
	);
	const read = await readMenusOf(doc, (app) => {
		const form = app.modules[0]?.forms[0];
		if (!form) throw new Error("Missing visit form");
		form.submit_label = held;
	});
	expect(read.findings).toEqual([]);
	if (!read.doc) throw new Error("The visit form could not be read");
	const form = Object.values(read.doc.forms)[0];
	if (!form) throw new Error("The visit form disappeared");
	const unit = snapshotTranslationUnits(read.doc).get(
		makeTranslationUnitId("form", form.uuid, "submit-label"),
	);
	if (!unit) throw new Error("Missing button translation unit");
	expect(localizeTranslationUnit(read.doc, "spa", unit).effective).toBe(
		held.es ?? "Submit",
	);
	expect(formSubmitWording(read.doc, form.uuid, "spa")).toBe(
		held.es === "" ? held.en : (held.es ?? "Submit"),
	);
	expect(expandDoc(read.doc).modules[0]?.forms[0]?.submit_label).toEqual(held);
});
