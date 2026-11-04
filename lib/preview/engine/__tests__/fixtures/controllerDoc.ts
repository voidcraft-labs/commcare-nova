import {
	lowerFixtureCaseWrites,
	resolveDocExpressions,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation } from "@/lib/doc/types";
import type { Field, Uuid } from "@/lib/domain";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import type { Expression } from "@/lib/domain/expression/types";
import { assertAdmittedPreviewDoc } from "../../../__tests__/fixtures/admittedDoc";

type SourceSlot =
	| "calculate"
	| "relevant"
	| "required"
	| "validate"
	| "default_value"
	| "repeat_count";
type FieldSource<T> = T extends Field
	? {
			[K in keyof T]: K extends SourceSlot
				? T[K] | string
				: K extends "data_source"
					? { ids_query: Expression | string }
					: T[K];
		}
	: never;
/** A field may say where its answer is saved (`caseWrite`), which the
 * fixture lowers into its form's case operations as `buildDoc` does. */
export type ControllerFieldSource = FieldSource<Field> & {
	caseWrite?: { caseType: string; property: string };
};
export type ControllerDocSource = Omit<PersistableDoc, "fields"> & {
	fields: Record<string, ControllerFieldSource>;
};

/** Sources are explicit fixture inputs. Resolve them only after all fields,
 * owners, catalogs and ordering exist, then admit the canonical document. */
export function admittedControllerDoc(
	input: ControllerDocSource,
): PersistableDoc {
	// The existing fixture resolver accepts the staged shape at its boundary;
	// no running engine or document store sees these source strings.
	const source = structuredClone(input);
	const caseWrites = new Map<Uuid, { caseType: string; property: string }>();
	for (const field of Object.values(source.fields)) {
		if (field.caseWrite === undefined) continue;
		caseWrites.set(field.uuid, field.caseWrite);
		delete field.caseWrite;
	}
	const doc = hydratePersistedBlueprint(source as PersistableDoc);
	resolveDocExpressions(doc);
	lowerFixtureCaseWrites(doc, caseWrites);
	assertAdmittedPreviewDoc(doc);
	return doc;
}

export function applyControllerEdit(
	store: BlueprintDocStore,
	mutations: Mutation[],
): void {
	const verdict = mutationCommitVerdict(
		store.getState(),
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok)
		throw new Error(
			`Unreachable controller edit: ${JSON.stringify(verdict.findings)}`,
		);
	store.getState().applyMany(mutations);
}
