/**
 * An attachment question's starting value at the validator boundary.
 *
 * Contract: an image, audio, video, signature or file question keeps only a
 * blank starting value. Web Apps clears a starting file name as the form opens
 * and submits nothing for it, and Android looks for the named file in the
 * form's folder and can't open the form (`proof/webapps/test_worker_messages.py`,
 * `proof/android/test_worker_messages.py`), so a file name, or an expression
 * that can give one, is refused on every editor's gate, while a label keeps any
 * starting value.
 *
 * Plausible failure: the rule reads the value's text instead of the bound tree
 * (refusing `""` or admitting `concat('')`), or reaches labels and ordinary
 * questions, whose starting values work on both platforms.
 */
import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import { literal, term } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import type { Field } from "@/lib/domain/fields";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

function withDefault(
	kind: "image" | "file" | "signature" | "label" | "text",
	value: Expression,
) {
	const doc = formFixture();
	const field = doc.fields[ids.text];
	doc.fields[ids.text] = {
		uuid: field.uuid,
		id: field.id,
		kind,
		label: proseText("Attachment"),
		default_value: value,
	} as Field;
	return doc;
}

const fileName = term(literal("carry-forward.pdf"));

describe("an attachment question's starting value", () => {
	it.each(["image", "file", "signature"] as const)(
		"refuses a file name on a %s question",
		(kind) => {
			const errors = runValidation(
				withDefault(kind, fileName),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				code: "CAPTURE_DEFAULT_NOT_BLANK",
				location: { fieldUuid: ids.text, field: "default_value" },
			});
		},
	);

	it("refuses an expression that can give a file name", () => {
		const errors = runValidation(
			withDefault("image", { kind: "concat", parts: [term(literal(""))] }),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(errors.map((error) => error.code)).toEqual([
			"CAPTURE_DEFAULT_NOT_BLANK",
		]);
	});

	it("keeps a blank starting value on an attachment question", () => {
		expect(
			runValidation(
				withDefault("image", term(literal(""))),
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual([]);
	});

	it.each(["label", "text"] as const)(
		"keeps a written starting value on a %s",
		(kind) => {
			expect(
				runValidation(withDefault(kind, fileName), LOOKUP_CONTEXT_UNAVAILABLE),
			).toEqual([]);
		},
	);
});
