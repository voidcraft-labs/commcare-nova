import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { targetedDocument, targetedUuid } from "../build";

/** Core's setvalue casts to its destination after wrapData. A calculate
 * writes the wrapped value itself, so even two integer nodes can carry a
 * different scalar class when one expression returns text. */
export function hiddenAnswerTypes() {
	const id = "targeted-hidden-answer-types";
	const form = targetedUuid(id, "readings");
	const doc = buildDoc({
		appId: id,
		appName: "Visit readings",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								id: "opening_count",
								answerType: "int",
								default_value: "'0003'",
							}),
							f({
								kind: "hidden",
								id: "source_code",
								answerType: "int",
								calculate: "'0003'",
							}),
							f({
								kind: "hidden",
								id: "whole_count",
								answerType: "int",
								calculate: "2.75",
							}),
							f({
								kind: "hidden",
								id: "large_count",
								answerType: "long",
								calculate: "3000000000.75",
							}),
							f({
								kind: "hidden",
								id: "has_note",
								answerType: "boolean",
								calculate: "'false'",
							}),
							f({ kind: "text", id: "note", label: "Note" }),
						],
					},
				],
			},
		],
	});
	const assertions = [
		["string(/data/opening_count)", "3"],
		["string(/data/source_code)", "0003"],
		["string(/data/whole_count)", "2"],
		["string(/data/large_count = 3000000000)", "true"],
		["string(/data/has_note = true())", "true"],
	] as const;
	return targetedDocument({
		id,
		doc,
		rows: ["A hidden value can have its own answer type"],
		expected: {
			intent: (["local", "A"] as const).map((target) => ({
				id: `typed-hidden-answers-${target}`,
				export: target,
				form,
				request: { expressions: assertions.map(([expression]) => expression) },
				expect: assertions.map(([, value], index) => ({
					pointer: `/values/${index}/value`,
					value,
				})),
			})),
		},
	});
}
