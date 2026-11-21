/**
 * The type CommCare HQ's question reader gives a control (`hqQuestionType.ts`, a port of
 * `xform.py::_infer_vellum_type` over `VELLUM_TYPE_INDEX`), which the lane records as each
 * question's `mug:` use and the reader records at the question's data node.
 *
 * Contract: every vector below is what HQ's own `_infer_vellum_type` at the pin answered for
 * the same control, run over HQ's own `xform.py`. Plausible failure: the reader records Vellum's
 * type where HQ's reader gives another (a Signature, which HQ reads as an Image; a Question List
 * whose appearance is `Field-List`, which HQ reads as a Group; an input typed `int` with no
 * `xsd:`, which HQ reads as a Text), so the lane's parity finds the reader's record unseen beside
 * an unclaimed use; and the kind table naming no claim under a type HQ gives one of its rows.
 */

import { describe, expect, it } from "vitest";
import { X } from "../claims";
import { hqQuestionType } from "../hqQuestionType";

/** `[tag, bind type, mediatype, appearance, HQ's type]`, as HQ's `_infer_vellum_type` answered. */
const HQ_ANSWERS: readonly (readonly [
	string,
	string | null,
	string | null,
	string | null,
	string | null,
])[] = [
	["input", "xsd:string", null, null, "Text"],
	["input", "xsd:string", null, "numeric", "PhoneNumber"],
	["input", "xsd:string", null, "Numeric", "Text"],
	["input", "xsd:string", null, "", "Text"],
	["input", null, null, null, "Text"],
	["input", null, null, "numeric", "PhoneNumber"],
	["input", "string", null, null, "Text"],
	["input", "xsd:int", null, null, "Int"],
	["input", "int", null, null, "Text"],
	["input", "xsd:integer", null, null, "Int"],
	["input", "integer", null, null, "Text"],
	["input", "xsd:double", null, null, "Double"],
	["input", "double", null, null, "Text"],
	["input", "xsd:date", null, null, "Date"],
	["input", "date", null, null, "Text"],
	["input", "xsd:time", null, null, "Time"],
	["input", "time", null, null, "Text"],
	["input", "xsd:dateTime", null, null, "DateTime"],
	["input", "dateTime", null, null, "Text"],
	["input", "geopoint", null, null, "Geopoint"],
	["input", "xsd:geopoint", null, null, "Text"],
	["input", "barcode", null, null, "Barcode"],
	["input", "xsd:barcode", null, null, "Text"],
	["input", "xsd:long", null, null, "Long"],
	["input", "intent", null, null, "AndroidIntent"],
	["input", "xsd:decimal", null, null, "Text"],
	["secret", "xsd:string", null, null, "Secret"],
	["secret", null, null, "numeric", "Secret"],
	["secret", "string", null, null, "Secret"],
	["select1", null, null, null, "Select"],
	["select1", "xsd:string", null, "minimal", "Select"],
	["select", "xsd:int", null, null, "MSelect"],
	["trigger", null, null, "minimal", "Trigger"],
	["trigger", null, null, null, "Trigger"],
	["upload", "binary", "image/*", null, "Image"],
	["upload", "binary", "image/*", "signature", "Image"],
	["upload", "binary", "image/*", "face", "Image"],
	["upload", "xsd:binary", "image/*", null, null],
	["upload", null, "image/*", null, null],
	["upload", "binary", "audio/*", null, "Audio"],
	["upload", "binary", "video/*", null, "Video"],
	["upload", "binary", "application/*,text/*", null, "Document"],
	["upload", "binary", "image/png", null, null],
	["group", null, null, null, "Group"],
	["group", null, null, "field-list", "FieldList"],
	["group", null, null, "Field-List", "Group"],
	["group", null, null, "FIELD-LIST", "Group"],
	["group", "xsd:string", null, "field-list", "FieldList"],
	["group", null, null, "compact", "Group"],
	["repeat", null, null, null, "Repeat"],
	["repeat", null, null, "field-list", "Repeat"],
];

describe("the type CommCare HQ's question reader gives a control", () => {
	it("is HQ's own answer for each control", () => {
		for (const [tag, type, mediaType, appearance, expected] of HQ_ANSWERS)
			expect(
				hqQuestionType({
					tag,
					type: type ?? undefined,
					mediaType: mediaType ?? undefined,
					appearance: appearance ?? undefined,
				}),
				`${tag} ${type} ${mediaType} ${appearance}`,
			).toBe(expected);
	});

	it("is a type each kind row the reader holds a question by claims its node under", () => {
		/** Each held kind with the controls of it HQ types otherwise than the row's own type. */
		const respelled = (
			sites: (typeof X.kind)[keyof typeof X.kind],
			tag: string,
			types: readonly string[],
		) => {
			for (const type of types) {
				const hq = hqQuestionType({
					tag,
					type,
					mediaType: undefined,
					appearance: undefined,
				});
				expect(hq).not.toBeNull();
				const key = `mug:${hq}`;
				const claim =
					sites.node.key === key ? sites.node : sites.nodeAs?.[hq as string];
				expect(claim?.key, `${tag} ${type}`).toBe(key);
			}
		};
		respelled(X.kind.int, "input", [
			"xsd:int",
			"int",
			"xsd:integer",
			"integer",
		]);
		respelled(X.kind.decimal, "input", ["xsd:double", "double"]);
		respelled(X.kind.date, "input", ["xsd:date", "date"]);
		respelled(X.kind.time, "input", ["xsd:time", "time"]);
		respelled(X.kind.datetime, "input", ["xsd:dateTime", "dateTime"]);
		respelled(X.kind.geopoint, "input", ["geopoint", "xsd:geopoint"]);
		respelled(X.kind.barcode, "input", ["barcode", "xsd:barcode"]);
		expect(X.kind.signature.node.key).toBe(
			`mug:${hqQuestionType({ tag: "upload", type: "binary", mediaType: "image/*", appearance: "signature" })}`,
		);
		for (const list of [
			X.questionList,
			X.unlabelledQuestionList,
			X.sectionQuestionList,
		]) {
			expect(list.node.key).toBe("mug:FieldList");
			expect(list.nodeAsGroup.key).toBe(
				`mug:${hqQuestionType({ tag: "group", type: undefined, mediaType: undefined, appearance: "Field-List" })}`,
			);
		}
	});
});
