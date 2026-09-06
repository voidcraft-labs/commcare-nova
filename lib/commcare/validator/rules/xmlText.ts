import type { BlueprintDoc } from "@/lib/domain";
import { xmlTextIssue } from "../../xmlText";
import { type ValidationError, validationError } from "../errors";

/**
 * Text inside an emitted definition must survive XML before any serializer
 * touches it. Walk stored values, including typed expression literals and
 * dormant translations, so edits cannot introduce a later export dead end.
 * Purpose notes, preview personas, and human-applied automations are not wire
 * definitions. Derived indexes are deliberately outside this inventory too.
 */
export function authoredXmlText(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const visit = (value: unknown, path: string, label: string): void => {
		if (typeof value === "string") {
			const character = xmlTextIssue(value);
			if (character !== undefined) {
				errors.push(
					validationError(
						"APP_TEXT_UNREPRESENTABLE",
						"app",
						`${label} contains an unsupported character (${character}). Remove that character so CommCare can preserve the text.`,
						{},
						{ path, character },
					),
				);
			}
		} else if (Array.isArray(value)) {
			value.forEach((child, index) => {
				visit(child, `${path}[${index}]`, label);
			});
		} else if (value !== null && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				visit(child, `${path}.${key}`, label);
			}
		}
	};
	visit(doc.appName, "appName", "The app name");
	visit(doc.caseTypes, "caseTypes", "The case information");
	for (const [language, entries] of Object.entries(
		doc.localization?.translations ?? {},
	)) {
		for (const [unit, entry] of Object.entries(entries)) {
			visit(
				entry.value,
				`localization.translations.${language}.${unit}.value`,
				"The translated text",
			);
		}
	}
	for (const [id, module] of Object.entries(doc.modules)) {
		const { purpose: _purpose, ...definition } = module;
		visit(definition, `modules.${id}`, `The module "${module.name}"`);
	}
	for (const [id, form] of Object.entries(doc.forms)) {
		const { purpose: _purpose, ...definition } = form;
		visit(definition, `forms.${id}`, `The form "${form.name}"`);
	}
	for (const [id, field] of Object.entries(doc.fields)) {
		visit(field, `fields.${id}`, `The question "${field.id}"`);
	}
	return errors;
}
