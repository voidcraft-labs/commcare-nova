import type { CaseType } from "@/lib/domain";
import {
	type AutomationMessagePart,
	type AutomationMessageTemplate,
	automationMessagePartSchema,
	automationMessageTemplateSchema,
} from "@/lib/domain/automations";
import { parseInterpolatedText, printInterpolatedText } from "./text";

export function parseAuthoringMessage(
	source: string,
	caseType: string,
	caseTypes: readonly CaseType[],
): AutomationMessageTemplate {
	const root = caseTypes.find((type) => type.name === caseType);
	const parts = parseInterpolatedText<AutomationMessagePart>(source, (name) => {
		const [scope, property, extra] = name.replace(/^#/, "").split("/");
		if (!property || extra !== undefined)
			throw new Error(`{{${name}}} must name one message value.`);
		if (scope === "recipient" || scope === "case-owner")
			return automationMessagePartSchema.parse({
				kind: "context-property",
				context: scope,
				property,
			});
		if (scope !== "case" && scope !== "parent" && scope !== "host")
			throw new Error(`Unknown message scope: ${scope}.`);
		const target =
			scope === "case"
				? root
				: root?.parent_type &&
						(scope === "host"
							? root.relationship === "extension"
							: root.relationship !== "extension")
					? caseTypes.find((type) => type.name === root.parent_type)
					: undefined;
		if (!target)
			throw new Error(`There is no ${scope} record for ${caseType}.`);
		// The canonical automation validator owns property availability and
		// message-specific shadowing. Binding owns only the reference identity.
		return automationMessagePartSchema.parse({
			kind: "case-property",
			scope,
			caseType: target.name,
			property,
		});
	});
	return automationMessageTemplateSchema.parse({ parts });
}

export function printAuthoringMessage(
	value: AutomationMessageTemplate,
): string {
	return printInterpolatedText(value.parts, (part) => {
		return `#${part.kind === "case-property" ? part.scope : part.context}/${part.property}`;
	});
}
