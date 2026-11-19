/**
 * The signature of a difference acceptance or a plan of changes made in
 * CommCare HQ finds: the check, then segments from closed vocabularies,
 * joined with `/` and cut at a whole segment within 80 characters. A
 * signature holds no word of any app (a name, an id, a label, a choice's
 * value, a case type), so it may go to the log and to Sentry, which groups
 * one defect of the reader under one title however many apps meet it.
 *
 * Pure.
 */

import { z } from "zod";
import { type SourceTable, tableOf } from "@/lib/commcare/sourceKeys";
import { automationSchema } from "@/lib/domain/automations";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { fieldSchema } from "@/lib/domain/fields";
import { formSchema } from "@/lib/domain/forms";
import { moduleSchema } from "@/lib/domain/modules";
import {
	locationPropertySchema,
	organizationLevelSchema,
} from "@/lib/domain/organization";
import {
	personaSchema,
	userPropertySchema,
	userTypeSchema,
} from "@/lib/domain/users";
import type { HqChangePlanCheck } from "../hqChanges/plan";
import type { AcceptanceCheck } from "./acceptance";

/** The most characters a signature holds. */
export const SIGNATURE_MAX_LENGTH = 80;

/** Every property name some object of `value`, a JSON Schema, declares. */
function declaredPropertyNames(value: unknown, into: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) declaredPropertyNames(item, into);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, member] of Object.entries(value)) {
		if (
			key === "properties" &&
			typeof member === "object" &&
			member !== null &&
			!Array.isArray(member)
		)
			for (const name of Object.keys(member)) into.add(name);
		declaredPropertyNames(member, into);
	}
}

/**
 * The schemas `lib/domain/blueprint.ts` composes the document of: the
 * document's own, and the value schema of each identity-keyed collection,
 * which the document schema holds behind a record check that no projection
 * can see into.
 */
const DOCUMENT_SCHEMAS: readonly z.ZodType[] = [
	blueprintDocSchema,
	moduleSchema,
	formSchema,
	fieldSchema,
	userPropertySchema,
	userTypeSchema,
	personaSchema,
	organizationLevelSchema,
	locationPropertySchema,
	automationSchema,
];

/**
 * The property names of Nova's document schema, collected once from
 * `lib/domain/blueprint.ts`'s schemas: every key some object of the document
 * declares, at any depth. A record's own keys (a uuid, a language, a name)
 * are no property the schema declares, so none is here.
 */
export const DOCUMENT_SCHEMA_KEYS: ReadonlySet<string> = (() => {
	const names = new Set<string>();
	for (const schema of DOCUMENT_SCHEMAS)
		declaredPropertyNames(
			z.toJSONSchema(schema, {
				io: "input",
				unrepresentable: "any",
				cycles: "ref",
			}),
			names,
		);
	return names;
})();

/** The top-level keys a signature names in its own words. */
const TOP_LEVEL_WORDS: SourceTable<string> = tableOf({
	modules: "menu",
	forms: "form",
	fields: "question",
	caseTypes: "case-type",
	localization: "translations",
});

/**
 * A document path as content-free segments: the top-level key, in its own
 * word where it has one (`modules` is `menu`, `forms` is `form`, `fields` is
 * `question`, `caseTypes` is `case-type`, `localization` is
 * `translations`), then every later segment that is a property name of the
 * document schema, in order. A uuid, an array position, a language code, a
 * case type's or a property's name and any other record key is dropped.
 */
export function documentPathKinds(path: readonly string[]): readonly string[] {
	const [top, ...rest] = path;
	if (top === undefined) return [];
	return [
		TOP_LEVEL_WORDS.get(top) ??
			(DOCUMENT_SCHEMA_KEYS.has(top) ? top : "document"),
		...rest.filter((segment) => DOCUMENT_SCHEMA_KEYS.has(segment)),
	];
}

/**
 * The check, then its segments, joined with `/` and cut at the last whole
 * segment within 80 characters. The check always stands: every signature
 * begins with a member of `ACCEPTANCE_CHECKS` or of `HQ_CHANGE_PLAN_CHECKS`.
 */
export function differenceSignature(
	check: AcceptanceCheck | HqChangePlanCheck,
	segments: readonly string[],
): string {
	let signature: string = check;
	for (const segment of segments) {
		const next = `${signature}/${segment}`;
		if (next.length > SIGNATURE_MAX_LENGTH) break;
		signature = next;
	}
	return signature;
}
