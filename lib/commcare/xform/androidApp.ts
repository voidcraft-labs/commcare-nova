import type { Element } from "domhandler";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { Field } from "@/lib/domain/fields";
import { androidAppInputMember } from "@/lib/domain/fields/androidApp";
import { el, type WireElementContext, xel } from "../elementBuilders";
import { type DisplaySettings, writeFieldAppearance } from "./appearance";
import type { FormExpressionEmission } from "./formExpressions";

export const PRINT_ACTION = "org.commcare.dalvik.action.PRINT";

/** Vellum's ordinary key/value editor stores each argument or result name
 * as an object property, and calls its own-property method before each pair. */
export function uneditableAndroidAppName(
	pairs: readonly { readonly name: string }[],
): string | undefined {
	return pairs.find(
		(pair, index) =>
			pair.name === "__proto__" ||
			(pair.name === "hasOwnProperty" && index < pairs.length - 1),
	)?.name;
}

/** Emit before collecting the secondary instances. A sent expression can
 * introduce an instance even when no bind or body control reads it. */
export function androidAppHeadElements(
	doc: BlueprintDoc,
	expressions: FormExpressionEmission,
	context: WireElementContext,
): Element[] {
	const elements: Element[] = [];
	for (const uuid of expressions.form.fields.keys()) {
		const field = doc.fields[uuid];
		if (field?.kind !== "text" || field.androidApp?.kind !== "open-app")
			continue;
		const { action, send, receive } = field.androidApp;
		elements.push(
			el(
				"odkx:intent",
				{
					"xmlns:odkx": "http://opendatakit.org/xforms",
					id: field.id,
					class: action,
				},
				[
					...send.map(({ name, value }, index) =>
						xel(
							"extra",
							{
								attributes: { key: name },
								xpath: {
									ref: expressions.lower(value, {
										entity: "field",
										uuid,
										slot: "android_app_input",
										member: androidAppInputMember(send, index),
									}),
								},
							},
							context,
						),
					),
					...receive.map(({ name, question }) => {
						const path = expressions.projection.path({
							kind: "field",
							uuid: question,
						});
						if (!path)
							throw new Error(
								`Question ${field.id} has no destination for ${name}.`,
							);
						return xel(
							"response",
							{ attributes: { key: name }, xpath: { ref: path.toWire() } },
							context,
						);
					}),
				],
			),
		);
	}
	return elements;
}

/** Native response refs are contextualized against the question that was
 * opened. An inner or unrelated repeat has no single row there. */
export function androidAppAnswerProblem(
	doc: BlueprintDoc,
	formUuid: Field["uuid"],
	field: Field,
): string | undefined {
	const answer = "androidApp" in field ? field.androidApp : undefined;
	if (answer === undefined) return undefined;
	const structure = formStructure(doc, formUuid);
	if (!structure) return "The Android app question needs to belong to a form.";
	if (writeFieldAppearance(field.kind, field as DisplaySettings) !== undefined)
		return "This question uses the Android app to enter its answer. You can remove the question’s appearance settings or the Android app.";
	const source =
		answer.kind === "use-question" ? doc.fields[answer.question] : field;
	if (
		!source ||
		!structure.fields.has(source.uuid) ||
		source.kind !== "text" ||
		source.androidApp?.kind !== "open-app"
	)
		return "Choose a question in this form that opens an Android app.";
	const { action, receive } = source.androidApp;
	if (source.uuid === field.uuid) {
		const unusable =
			uneditableAndroidAppName(source.androidApp.send) ??
			uneditableAndroidAppName(receive);
		if (unusable)
			return `CommCare HQ's form editor cannot keep the Android app value name "${unusable}" in this list. You can choose a different name.`;
		if (action === PRINT_ACTION)
			return "This action needs a print template. You can choose another Android app.";
		if (
			[...structure.fields.values()].some((other) => {
				const sibling = doc.fields[other.uuid];
				return (
					other.uuid !== source.uuid &&
					sibling?.kind === "text" &&
					sibling.androidApp?.kind === "open-app" &&
					sibling.id === source.id
				);
			})
		)
			return "Two Android app questions in this form share a question ID. You can give one a different ID.";
	}
	const repeatPath = (uuid: Field["uuid"]) => {
		const ancestors = new Set<Field["uuid"]>();
		let parent = structure.fields.get(uuid)?.parent;
		while (parent && structure.fields.has(parent)) {
			const ancestor = structure.fields.get(parent);
			if (ancestor?.kind === "repeat") ancestors.add(parent);
			parent = ancestor?.parent;
		}
		return ancestors;
	};
	const invokingRows = repeatPath(field.uuid);
	for (const result of receive) {
		const target = structure.fields.get(result.question);
		if (!target || ["group", "repeat", "section"].includes(target.kind))
			return `Choose a question in this form for the result "${result.name}".`;
		if ([...repeatPath(target.uuid)].some((row) => !invokingRows.has(row)))
			return `The result "${result.name}" needs a question in the current row or outside its repeat.`;
	}
	return undefined;
}
