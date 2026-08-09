/**
 * Handle declarations on the SHARED structural creation tools.
 *
 * The executor wire widens every handle-eligible identity slot to
 * `uuid | { handle }`. A creation slot has one extra responsibility beyond a
 * reference slot: it must bind that handle before the workspace resolves the
 * complete input through the original canonical schema. Keep this list closed
 * and explicit so target, parent, and anchor slots never accidentally mint an
 * entity. Inline-option replacement slots preserve a bound option handle or
 * bind a new one, because the same canonical slot supports both operations.
 */

import { asHandleRef, type StagedHandleDeclaration } from "./handles";
import type { StagedEntityKind } from "./schemas";

type HandleDeclarer = (input: unknown) => readonly StagedHandleDeclaration[];

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function array(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function declaration(
	value: unknown,
	entityKind: StagedEntityKind,
	referenceIfBound = false,
): readonly StagedHandleDeclaration[] {
	const handle = asHandleRef(value);
	return handle === null
		? []
		: [{ handle, entityKind, ...(referenceIfBound && { referenceIfBound }) }];
}

function declarationsAt(
	input: unknown,
	key: string,
	entityKind: StagedEntityKind,
): readonly StagedHandleDeclaration[] {
	const record = object(input);
	return declaration(record?.[key], entityKind);
}

function optionDeclarations(
	optionsSourceValue: unknown,
	referenceIfBound = false,
): readonly StagedHandleDeclaration[] {
	const declarations: StagedHandleDeclaration[] = [];
	const optionsSource = object(optionsSourceValue);
	if (optionsSource?.kind === "inline") {
		for (const optionValue of array(optionsSource.options)) {
			const option = object(optionValue);
			declarations.push(
				...declaration(option?.optionUuid, "option", referenceIfBound),
			);
		}
	}
	return declarations;
}

function fieldDeclarations(
	fields: unknown,
): readonly StagedHandleDeclaration[] {
	const declarations: StagedHandleDeclaration[] = [];
	for (const fieldValue of array(fields)) {
		const field = object(fieldValue);
		if (field === null) continue;
		declarations.push(...declaration(field.fieldUuid, "field"));
		declarations.push(...optionDeclarations(field.optionsSource));
	}
	return declarations;
}

function itemDeclarations(
	items: unknown,
	key: string,
	entityKind: StagedEntityKind,
): readonly StagedHandleDeclaration[] {
	return array(items).flatMap((item) => declarationsAt(item, key, entityKind));
}

const SHARED_HANDLE_DECLARERS: Readonly<Record<string, HandleDeclarer>> = {
	createModule(input) {
		const root = object(input);
		const declarations: StagedHandleDeclaration[] = [
			...declarationsAt(root, "moduleUuid", "module"),
		];
		for (const formValue of array(root?.forms)) {
			const form = object(formValue);
			if (form === null) continue;
			declarations.push(...declaration(form.formUuid, "form"));
			declarations.push(...fieldDeclarations(form.fields));
		}
		declarations.push(
			...itemDeclarations(
				root?.case_list_columns,
				"columnUuid",
				"case_list_column",
			),
		);
		return declarations;
	},
	createForm(input) {
		const root = object(input);
		return [
			...declarationsAt(root, "formUuid", "form"),
			...fieldDeclarations(root?.fields),
		];
	},
	addFields(input) {
		return fieldDeclarations(object(input)?.fields);
	},
	addCaseListColumns(input) {
		return itemDeclarations(
			object(input)?.columns,
			"columnUuid",
			"case_list_column",
		);
	},
	addSearchInputs(input) {
		return itemDeclarations(
			object(input)?.searchInputs,
			"searchInputUuid",
			"search_input",
		);
	},
	addCaseOperations(input) {
		return itemDeclarations(
			object(input)?.operations,
			"operationUuid",
			"case_operation",
		);
	},
	editField(input) {
		return optionDeclarations(
			object(object(input)?.updates)?.optionsSource,
			true,
		);
	},
	setFieldOptionsSource(input) {
		return optionDeclarations(object(input)?.source, true);
	},
};

/** The declaration reader for one shared tool, if that tool creates a
 * handle-capable structural identity. */
export function sharedHandleDeclarer(
	toolName: string,
): HandleDeclarer | undefined {
	return SHARED_HANDLE_DECLARERS[toolName];
}
