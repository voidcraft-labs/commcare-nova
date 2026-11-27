import { produce } from "immer";
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { resourcedDocument } from "@/lib/commcare/reader/languages";
import { applyMutations } from "@/lib/doc/mutations";
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
	{ en: "", es: "" },
	{ es: "" },
])(
	"preserves each configured form button through a source change (%j)",
	async (held) => {
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
			held.es === "" ? (held.en ?? "Submit") : (held.es ?? "Submit"),
		);
		expect(expandDoc(read.doc).modules[0]?.forms[0]?.submit_label).toEqual(
			held,
		);
		const fromRead = resourcedDocument(read.doc, "spa");
		const fromSaved = produce(read.doc, (draft) => {
			applyMutations(draft, [
				{ kind: "rebaseSourceLanguage", from: "eng", to: "spa" },
			]);
		});
		for (const rebased of [fromRead, fromSaved]) {
			expect(rebased.localization?.sourceLanguage).toBe("spa");
			expect(rebased.forms[form.uuid].submitLabel?.text).toBe(held.es);
			for (const language of ["eng", "spa"] as const)
				expect(formSubmitWording(rebased, form.uuid, language)).toBe(
					formSubmitWording(read.doc, form.uuid, language),
				);
			expect(expandDoc(rebased).modules[0]?.forms[0]?.submit_label).toEqual(
				held,
			);
		}
	},
);
