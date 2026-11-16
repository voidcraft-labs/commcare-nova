/**
 * A validation message no constraint can fail. The domain admits a message on
 * a question with no validation condition; no runtime shows one, since a
 * message is read only for an answer that fails a constraint, so the emitter
 * writes none (`constraintMessage.ts::bindCarriesConstraint`) and the reader's canonical
 * choice `validation-message-with-no-condition-is-absent` removes it, with its
 * translations, from the document the reading is compared with. A question
 * that names a case carries the check of that name on its constraint, so its
 * message is written and read back.
 *
 * Plausible failures: the emitter writing the message beside no constraint,
 * which the reader refuses (`validation-message-without-a-validation-condition`)
 * on Nova's own export; the canonical choice removing a message a case name's
 * check can show, or leaving a translation of a message it removed.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, type Field, proseText } from "@/lib/domain";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { readHqApp } from "../../index";

const ROW = "validation-message-with-no-condition-is-absent";

/** A registration whose case name `name`, a note `note` and a count `count` each hold a message;
 *  only `count` holds a validation condition. */
function messagesApp(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
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
								id: "name",
								label: proseText("Name"),
								validate_msg: proseText("Write a name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								validate_msg: proseText("Never shown"),
							}),
							f({
								kind: "int",
								id: "count",
								label: proseText("Count"),
								validate: ". > 0",
								validate_msg: proseText("Count one or more"),
							}),
						],
					},
				],
			},
		],
	});
}

function fieldById(doc: BlueprintDoc, id: string): Field {
	const found = Object.values(doc.fields).find((field) => field.id === id);
	if (found === undefined) throw new Error(`No field ${id}.`);
	return found;
}

function messageOf(doc: BlueprintDoc, id: string): unknown {
	return (fieldById(doc, id) as { validate_msg?: unknown }).validate_msg;
}

function canonicalChoice() {
	const found = READER_CANONICAL_CHOICES.find((one) => one.id === ROW);
	if (found === undefined) throw new Error(`No canonical choice ${ROW}.`);
	return found;
}

describe("a validation message no constraint can fail", () => {
	it("reads Nova's export with no finding: no message where nothing can fail, and the others", async () => {
		const outcome = readHqApp(await inputFor(exportedBody(messagesApp())));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = outcome.draft.doc;
		expect(messageOf(read, "note")).toBeUndefined();
		expect(messageOf(read, "name")).toEqual(proseText("Write a name"));
		expect(messageOf(read, "count")).toEqual(proseText("Count one or more"));
	});

	it("is removed by the canonical choice with its translations, and the other messages stay", () => {
		const doc = messagesApp();
		const unit = (id: string) =>
			makeTranslationUnitId("field", fieldById(doc, id).uuid, "validate_msg");
		const entry = (text: string, source: string) => ({
			value: proseText(text),
			sourceFingerprint: translationSourceFingerprint(
				"prose",
				proseText(source),
			),
			origin: "human" as const,
			review: "reviewed" as const,
			translatedFrom: "eng",
		});
		const localized = produce(doc, (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fra" },
				translations: {
					fra: {
						[unit("note")]: entry("Jamais vu", "Never shown"),
						[unit("name")]: entry("Écrivez un nom", "Write a name"),
					},
				},
			} as never;
		});
		const canon = canonicalChoice().apply(localized);
		expect(canonicalChoice().kind).toBe("not-carried");
		expect(messageOf(canon, "note")).toBeUndefined();
		expect(messageOf(canon, "name")).toEqual(proseText("Write a name"));
		expect(messageOf(canon, "count")).toEqual(proseText("Count one or more"));
		expect(canon.localization?.translations.fra).toEqual({
			[unit("name")]: entry("Écrivez un nom", "Write a name"),
		});
		expect(messageOf(localized, "note")).toEqual(proseText("Never shown"));
	});

	it("gives back the document where every message can show", () => {
		const doc = produce(messagesApp(), (draft) => {
			const note = Object.values(draft.fields).find((one) => one.id === "note");
			if (note !== undefined)
				delete (note as { validate_msg?: unknown }).validate_msg;
		});
		expect(canonicalChoice().apply(doc)).toBe(doc);
	});

	it("reads back a sibling's lifted counts where a protected message with no condition would have taken one's name", async () => {
		// `x_1`'s carrier would be `nova_constraint_message_x_1`, the base of `message_x`'s
		// second lifted count; no carrier is written, so none is reserved, in the document or in
		// its reading.
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({ kind: "text", id: "other", label: proseText("Other") }),
								f({
									kind: "text",
									id: "x_1",
									label: proseText("X"),
									// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
									validate_msg: proseText("Write ${1}"),
								}),
								f({
									kind: "text",
									id: "message_x",
									label: proseText("Message"),
									validate:
										"count(#form/other[. = 'yes']) > 0 and count(#form/other[. = 'no']) = 0",
								}),
							],
						},
					],
				},
			],
		});
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const read = outcome.draft.doc;
		const ids = (one: BlueprintDoc) =>
			Object.values(one.fields)
				.map((field) => field.id)
				.sort();
		expect(ids(read)).toEqual(["message_x", "other", "x_1"]);
		expect(messageOf(read, "x_1")).toBeUndefined();
		expect(ids(read)).toEqual(ids(canonicalChoice().apply(doc)));
	});
});
