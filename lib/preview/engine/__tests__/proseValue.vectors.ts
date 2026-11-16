/**
 * The calculated values a label shows, with the text Preview prints for
 * each, shared by Preview's own test (`proseValue.test.ts`) and the proof
 * lane's native family `expression`, whose producer
 * (`proof/native/producers/emit-expression-evidence.ts`) compiles the same
 * form and whose Core test (`proof/native/core/ProseValueRuntimeTest.java`)
 * reads each label through Core, in every device zone, and requires the same
 * text. Core prints a value by XPath's string rule
 * (`XPathConditional.java::evalReadable` → `FunctionUtils.toString`): a date
 * as its ISO day, a number as XPath prints it, yes or no as `true` or
 * `false`.
 *
 * Every vector's text is the same in every zone: the date and time answer is
 * a wall clock, which a device reads in its own zone, and its formula prints
 * the wall clock back.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";

export const VECTOR_UUIDS = {
	form: testUuid("prose-value-vectors-form"),
	word: testUuid("prose-value-vectors-word"),
} as const;

/** The answers the form is given before its labels are read, by question id. */
export const PROSE_VALUE_ANSWERS = {
	word: "Ama",
	count: "3",
	amount: "1.5",
	visit: "2026-03-04",
	seen: "2026-03-04T10:30:00",
} as const;

export interface ProseValueVector {
	/** The vector's name, and the id of the question whose label holds it. */
	readonly id: string;
	/** The formula the label holds, in form text. */
	readonly formula: string;
	/** The text Preview shows for it, which Core must print. */
	readonly text: string;
}

export const PROSE_VALUE_VECTORS: readonly ProseValueVector[] = [
	{
		id: "a_text",
		formula: "concat(#form/word, ' and more')",
		text: "Ama and more",
	},
	{ id: "a_whole_number", formula: "#form/count + 1", text: "4" },
	{ id: "a_decimal", formula: "#form/amount * 3", text: "4.5" },
	{ id: "a_date", formula: "date(#form/visit)", text: "2026-03-04" },
	{
		id: "a_date_and_time",
		// Core's format-date of a node rounds a typed date and time to its day,
		// so the clock is read through coalesce, which hands the Date itself.
		formula: "format-date(coalesce(#form/seen, ''), '%Y-%m-%d %H:%M')",
		text: "2026-03-04 10:30",
	},
	{ id: "a_yes_or_no", formula: "#form/count > 2", text: "true" },
	{ id: "a_blank", formula: "concat(#form/note, '')", text: "" },
	{
		id: "a_formatted_date",
		formula: "format-date(date(#form/visit), '%e %b %Y')",
		text: "4 Mar 2026",
	},
];

/** The two validation messages Core composes with a value: one holding a
 *  formatted date alone, one holding a value beside a reference. Each
 *  question refuses the answer `0` and shows its message. */
export const PROSE_VALUE_MESSAGES = [
	{
		id: "checked_date",
		parts: [
			{ kind: "value", formula: "format-date(date(#form/visit), '%e %b %Y')" },
		],
		text: "4 Mar 2026",
	},
	{
		id: "checked_beside",
		parts: [
			{ kind: "reference", question: "word" },
			{ kind: "text", text: " on " },
			{ kind: "value", formula: "format-date(date(#form/visit), '%e %b %Y')" },
		],
		text: "Ama on 4 Mar 2026",
	},
] as const;

/** The survey every vector is read on: the answered questions, one label
 *  question per vector, and the two checked questions. */
export function proseValueVectorDoc(): BlueprintDoc {
	const answered = [
		f({
			kind: "text",
			uuid: VECTOR_UUIDS.word,
			id: "word",
			label: proseText("Word"),
		}),
		f({ kind: "int", id: "count", label: proseText("Count") }),
		f({ kind: "decimal", id: "amount", label: proseText("Amount") }),
		f({ kind: "date", id: "visit", label: proseText("Visit") }),
		f({ kind: "datetime", id: "seen", label: proseText("Seen") }),
		f({ kind: "text", id: "note", label: proseText("Note") }),
	];
	const labels = PROSE_VALUE_VECTORS.map((vector) =>
		f({
			kind: "label",
			id: vector.id,
			label: { parts: [{ kind: "value", expression: vector.formula }] },
		}),
	);
	const checked = PROSE_VALUE_MESSAGES.map((message) =>
		f({
			kind: "int",
			id: message.id,
			label: proseText(message.id),
			validate: ". > 0",
			validate_msg: {
				parts: message.parts.map((part) =>
					part.kind === "value"
						? { kind: "value", expression: part.formula }
						: part.kind === "reference"
							? { kind: "field-ref", uuid: VECTOR_UUIDS[part.question] }
							: { kind: "text", text: part.text },
				),
			},
		}),
	);
	return buildDoc({
		appId: "prose-value-vectors",
		appName: "Calculated values",
		modules: [
			{
				name: "Values",
				forms: [
					{
						uuid: VECTOR_UUIDS.form,
						name: "Values",
						type: "survey",
						fields: [...answered, ...labels, ...checked],
					},
				],
			},
		],
	});
}
