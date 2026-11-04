/**
 * Documents with an advanced menu, for the XForm and suite oracle corpora.
 *
 * Over a document `suiteDocArbitrary` draws, a form of one menu creates a
 * case of another menu's type, outside any repeat, and its one after-submit
 * link opens a follow-up form of that type. The link carries the new case
 * to the follow-up (`formLinkProjection.ts::linkCarriedCreates`), and a
 * basic form gives such a create no session datum, so the creating form's
 * menu is emitted advanced (`moduleKind.ts::emittedModuleKind`) unless one
 * of its blockers keeps it basic. Only draws the commit gate admits are
 * kept.
 *
 * The edit is applied after the draw with no random call of its own, so a
 * draw of `suiteDocArbitrary` is the same whether or not this arbitrary
 * reads it. The proof sample does not use it.
 */
import type * as fc from "fast-check";
import { testUuid } from "@/__tests__/helpers/uuid";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseOperation,
	type FormLink,
	moduleOpensOnSearch,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

/** The create the edit adds, and the link that carries it. */
export const CARRIED_CREATE = testUuid("advanced-fuzz-carried-create");
const CARRYING_LINK = testUuid("advanced-fuzz-carrying-link");

/** A follow-up form of a top-level menu that opens on its list: a link's
 *  target whose one case datum the carried create can supply. */
function linkTarget(
	doc: BlueprintDoc,
): { moduleUuid: Uuid; formUuid: Uuid; caseType: string } | undefined {
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (
			mod?.caseType === undefined ||
			mod.parentCaseModuleUuid !== undefined ||
			mod.parentModuleUuid !== undefined ||
			moduleOpensOnSearch(mod)
		)
			continue;
		const formUuid = (doc.formOrder[moduleUuid] ?? []).find(
			(uuid) => doc.forms[uuid]?.type === "followup",
		);
		if (formUuid !== undefined)
			return { moduleUuid, formUuid, caseType: mod.caseType };
	}
	return undefined;
}

/** A form of another menu's type that works on a case and holds a root
 *  `case_name` question, the create's name. */
function linkSource(
	doc: BlueprintDoc,
	caseType: string,
): { formUuid: Uuid; nameField: Uuid } | undefined {
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined || mod.caseType === caseType) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (doc.forms[formUuid]?.type === "survey") continue;
			const nameField = (doc.fieldOrder[formUuid] ?? []).find(
				(uuid) => doc.fields[uuid]?.id === "case_name",
			);
			if (nameField !== undefined) return { formUuid, nameField };
		}
	}
	return undefined;
}

/** The document with the carried create and its link, or `undefined` where
 *  the draw holds no target and source for them. */
export function withCarriedCreate(
	drawn: BlueprintDoc,
): BlueprintDoc | undefined {
	const doc = structuredClone(drawn);
	const target = linkTarget(doc);
	if (target === undefined) return undefined;
	const source = linkSource(doc, target.caseType);
	if (source === undefined) return undefined;
	const form = doc.forms[source.formUuid];
	if (form === undefined) return undefined;
	const name = {
		kind: "term",
		term: { kind: "field", uuid: source.nameField },
	} as Expression;
	const create = {
		uuid: CARRIED_CREATE,
		id: `carried_${target.caseType}`,
		action: "create",
		caseType: target.caseType,
		target: { kind: "new" },
		name,
	} as CaseOperation;
	const link: FormLink = {
		uuid: CARRYING_LINK,
		target: {
			type: "form",
			moduleUuid: target.moduleUuid,
			formUuid: target.formUuid,
		},
	};
	doc.forms[source.formUuid] = {
		...form,
		caseOperations: [...(form.caseOperations ?? []), create],
		formLinks: [link],
	};
	rebuildFieldParent(doc);
	return doc;
}

/** Whether the commit gate admits the document. */
function admitted(doc: BlueprintDoc): boolean {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length === 0;
}

export const advancedDocArbitrary: fc.Arbitrary<BlueprintDoc> =
	suiteDocArbitrary
		.map(withCarriedCreate)
		.filter((doc): doc is BlueprintDoc => doc !== undefined && admitted(doc));
