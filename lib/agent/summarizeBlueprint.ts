/**
 * Compact blueprint-summary renderer. Walks `BlueprintDoc` directly and
 * emits domain-vocabulary text (`field`, `kind`, `case_property`) — no
 * CommCare wire terms. The SA prompt composer and the MCP `get_app`
 * tool both consume this so the two surfaces show one canonical
 * domain-vocabulary view of an app.
 */

import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { isContainer } from "@/lib/domain";

/**
 * Render a field and its children as nested bullet lines. Shows `id`,
 * `kind`, and the `label` / `case_property` hints when present. Nested
 * containers indent their children by two spaces per level so depth is
 * visually obvious.
 */
function summarizeField(
	doc: BlueprintDoc,
	uuid: Uuid,
	indent: string,
): string | undefined {
	const field = doc.fields[uuid];
	if (!field) return undefined;
	// `label` is absent on hidden, `case_property` is absent on
	// structural/media kinds and on non-case fields — render each
	// piece only when it's meaningful.
	const pieces: string[] = [`${indent}- ${field.id} (${field.kind})`];
	if ("label" in field && field.label) pieces[0] += `: "${field.label}"`;
	if ("case_property" in field && field.case_property) {
		pieces[0] += ` → ${field.case_property}`;
	}
	if (isContainer(field)) {
		const children = doc.fieldOrder[uuid] ?? [];
		const childLines = children
			.map((c) => summarizeField(doc, c, `${indent}  `))
			.filter((s): s is string => typeof s === "string");
		if (childLines.length > 0) pieces.push(childLines.join("\n"));
	}
	return pieces.join("\n");
}

/** Summarize one form: name, type, field count, nested field list. */
function summarizeForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	formIndex: number,
): string {
	const form = doc.forms[formUuid];
	if (!form) return `  - Form ${formIndex}: <missing>`;
	const count = countFieldsUnder(doc, formUuid);
	const header = `  - Form ${formIndex}: "${form.name}" (${form.type}, ${count} field${count === 1 ? "" : "s"})`;
	const extras: string[] = [];
	if (form.postSubmit) extras.push(`    post_submit: ${form.postSubmit}`);
	if (form.connect) extras.push("    [Connect enabled]");
	if (form.closeCondition) {
		const op =
			form.closeCondition.operator === "selected" ? "has selected" : "=";
		extras.push(
			`    close_condition: ${form.closeCondition.field} ${op} "${form.closeCondition.answer}"`,
		);
	}
	const topLevelFields = doc.fieldOrder[formUuid] ?? [];
	const fieldSummary =
		topLevelFields.length > 0
			? topLevelFields
					.map((u) => summarizeField(doc, u, "    "))
					.filter((s): s is string => typeof s === "string")
					.join("\n")
			: "    (no fields)";
	return [header, ...extras, fieldSummary].join("\n");
}

/** Summarize a module: name, case type, forms. */
function summarizeModule(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	index: number,
): string {
	const mod = doc.modules[moduleUuid];
	if (!mod) return `- Module ${index}: <missing>`;
	const caseInfo = mod.caseType ? ` (case_type: ${mod.caseType})` : "";
	const listOnly = mod.caseListOnly ? " [case list only]" : "";
	const header = `- Module ${index}: "${mod.name}"${caseInfo}${listOnly}`;
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const forms = formUuids
		.map((fUuid, fi) => summarizeForm(doc, fUuid, fi))
		.join("\n");
	return forms ? `${header}\n${forms}` : header;
}

/**
 * Produce the compact text summary of the app that lands in the SA's
 * edit-mode prompt. Reads from the normalized doc directly.
 */
export function summarizeBlueprint(doc: BlueprintDoc): string {
	const lines: string[] = [];

	lines.push(`### App: "${doc.appName}"`);
	if (doc.connectType) lines.push(`Connect type: ${doc.connectType}`);

	if (doc.caseTypes?.length) {
		lines.push("");
		lines.push("**Case types:**");
		for (const ct of doc.caseTypes) {
			const props = ct.properties.map((p) => p.name).join(", ");
			const parentInfo = ct.parent_type ? ` (child of ${ct.parent_type})` : "";
			lines.push(`- ${ct.name}${parentInfo}: ${props}`);
		}
	}

	lines.push("");
	lines.push("**Structure:**");
	for (let i = 0; i < doc.moduleOrder.length; i++) {
		const moduleUuid = doc.moduleOrder[i];
		if (!moduleUuid) continue;
		lines.push(summarizeModule(doc, moduleUuid, i));
	}

	return lines.join("\n");
}
