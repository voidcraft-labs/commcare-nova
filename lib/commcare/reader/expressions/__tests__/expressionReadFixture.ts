/**
 * What a test of the expression reader hands it: a reading environment over
 * a document `buildDoc` made, and a registration of HQ's text in a real
 * slot of that document, in the mode the emitter prints the slot in unless
 * the test names HQ's own.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import type { PendingExpression, ReadMode } from "../../pendingExpressions";
import type { ExpressionReadEnv, GeneratedValue } from "../index";
import { slotReadMode } from "../readExpression";

export function readEnv(
	overrides: Partial<ExpressionReadEnv> = {},
): ExpressionReadEnv {
	return {
		lookup: new Map(),
		sourceNames: new Map(),
		itextUnits: new Map(),
		instanceSources: new Map(),
		generatedValues: new Map<Uuid, ReadonlyMap<string, GeneratedValue>>(),
		operationIdPaths: new Map(),
		// Every record tree these tests hold has a record spelling.
		recordDialect: () => undefined,
		entryFactsRefused: new Set(),
		...overrides,
	};
}

export function registration(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	text: string,
	mode: ReadMode = slotReadMode(doc, ref),
): PendingExpression {
	return { ref, text, mode, place: { kind: "app" }, key: `test:${ref.slot}` };
}

/** The one form of the one menu of a document. */
export function onlyForm(doc: BlueprintDoc): Uuid {
	const moduleUuid = doc.moduleOrder[0] as Uuid;
	return (doc.formOrder[moduleUuid] ?? [])[0] as Uuid;
}

/** A field of a form by its id. */
export function fieldNamed(doc: BlueprintDoc, id: string): Uuid {
	const found = Object.values(doc.fields).find((field) => field.id === id);
	if (found === undefined) throw new Error(`No field ${id} in the document.`);
	return found.uuid;
}
