// lib/commcare/reader/identityMap.ts
//
// The projection of a Nova document onto the external keys a reading of its
// CommCare HQ app would mint under: every entity of a kind HQ's app holds,
// with the key `identity.ts::externalKey` spells for it and the UUID the
// document gives it. Handed to `matchingResolver`, it makes a reading of the
// app give back the document's own UUIDs. It is computed wherever it is
// needed and stored nowhere.

import {
	type BasicPlacement,
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	type Form,
	type FormLinkTarget,
	formLinkEntries,
	orderedColumns,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import {
	type FormStructure,
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import { planPlacements } from "../placement";
import type { WireIdentity } from "../wireIdentity";
import { calculatedAttributeField } from "./caseList/attributeColumns";
import {
	type CaseOperationPlaceKey,
	type ExternalKey,
	externalKey,
	externalKeyText,
	type FormLinkTargetKey,
	type IdentityMapEntry,
	matchingUuidOf,
	sortIdentityMapEntries,
} from "./identity";

/**
 * The UUID a re-read of `doc`'s export gives an entity of `key`, told
 * `externalIdentityMap(doc, identity)` through `matchingResolver`: the
 * document's own UUID where it holds the key, else a UUID it holds under no
 * key (`identity.ts::freeEntityUuid`). A canonical row that gives an entity
 * the UUID a re-read gives it asks here, never `mintEntityUuid` directly: a
 * document holds an entity renamed in Nova (a column whose property changed,
 * an ordinal a removal moved) under the UUID its old key mints, and a re-read
 * gives a new entity of that old key another one. The map is built on the
 * first call.
 */
export function reReadUuidOf(
	doc: BlueprintDoc,
	identity: WireIdentity,
): (key: ExternalKey) => Uuid {
	let uuidOf: ((key: ExternalKey) => Uuid) | undefined;
	return (key) => {
		uuidOf ??= matchingUuidOf(doc.appId, externalIdentityMap(doc, identity));
		return uuidOf(key);
	};
}

/**
 * Every entity of `doc` that has an external key, with that key, ordered by
 * `externalKeyText`.
 *
 * Total over a document the commit gate admits: it reads no store and
 * parses nothing. A menu the emission plan adds is not an entity and has no
 * entry. Ids are unique among siblings, option values within a select and
 * input names within a module, and the ordinal kinds count among equals, so
 * no two entities of an admitted document share a key; a document that holds
 * two (two worker properties of one slug, say) is refused here rather than
 * mapped to one of them.
 */
export function externalIdentityMap(
	doc: BlueprintDoc,
	identity: WireIdentity,
): readonly IdentityMapEntry[] {
	const entries: IdentityMapEntry[] = [];
	const add = (key: ExternalKey, uuid: Uuid): void => {
		entries.push({ kind: key.kind, parts: key.parts, uuid });
	};

	for (const module of Object.values(doc.modules)) {
		const uniqueId = identity.moduleUniqueId(module.uuid);
		add(externalKey.module(uniqueId), module.uuid);
		if (module.entryPoint)
			add(
				externalKey.entryPoint("module", uniqueId, "menu"),
				module.entryPoint.uuid,
			);
		if (module.caseListEntryPoint)
			add(
				externalKey.entryPoint("module", uniqueId, "case-list"),
				module.caseListEntryPoint.uuid,
			);
		const config = module.caseListConfig;
		if (config !== undefined) {
			const columnCounts = new Map<string, number>();
			for (const column of orderedColumns(config, "list")) {
				// A calculated column that reads one attribute alone is read as the
				// plain column over it (`caseList/attributeColumns.ts`).
				const attribute = calculatedAttributeField(column, module.caseType);
				const kind = attribute === undefined ? column.kind : "plain";
				const field =
					attribute ?? (column.kind === "calculated" ? "" : column.field);
				const n = nextOrdinal(columnCounts, JSON.stringify([kind, field]));
				add(externalKey.caseListColumn(uniqueId, kind, field, n), column.uuid);
			}
			for (const input of config.searchInputs)
				add(externalKey.searchInput(uniqueId, input.name), input.uuid);
		}
	}

	for (const form of Object.values(doc.forms)) {
		const xmlns = identity.formXmlns(form);
		add(externalKey.form(xmlns), form.uuid);
		if (form.entryPoint)
			add(externalKey.entryPoint("form", xmlns), form.entryPoint.uuid);
		const structure = formStructure(doc, form.uuid);
		if (structure === undefined)
			throw new Error(
				`Nova could not map form ${form.uuid} to the keys a reading of its CommCare HQ app gives: no menu lists it. A document the commit gate admits lists every form in one menu.`,
			);
		for (const field of structure.fields.values()) {
			const path = authoredPath(structure, field.uuid);
			add(externalKey.field(xmlns, path), field.uuid);
			if (field.choices?.kind === "inline")
				for (const option of field.choices.options)
					add(externalKey.selectOption(xmlns, path, option.value), option.uuid);
		}
		if (!form.caseSelections)
			for (const [uuid, tag] of Object.entries(form.heldSelectionTags ?? {}))
				add(externalKey.formSelection(form.uuid, tag), uuid as Uuid);
		for (const row of form.caseSelections ?? [])
			add(externalKey.formSelection(form.uuid, row.tag), row.uuid);
		for (const row of form.computedDatums ?? [])
			add(externalKey.entryValue(form.uuid, row.key), row.uuid);
		addCaseOperations(doc, form, xmlns, structure, add);
		const linkCounts = new Map<string, number>();
		for (const { link } of formLinkEntries(form)) {
			const target = linkTargetKey(doc, identity, link.target);
			const n = nextOrdinal(linkCounts, JSON.stringify(target));
			add(externalKey.formLink(xmlns, target, n), link.uuid);
		}
	}

	for (const property of Object.values(doc.userProperties ?? {}))
		add(externalKey.userProperty(property.slug), property.uuid);
	for (const level of Object.values(doc.organizationLevels ?? {}))
		add(externalKey.organizationLevel(level.code), level.uuid);
	for (const property of Object.values(doc.locationProperties ?? {}))
		add(externalKey.locationProperty(property.slug), property.uuid);

	const seen = new Set<string>();
	for (const entry of entries) {
		const text = externalKeyText(entry);
		if (seen.has(text))
			throw new Error(
				`Nova could not map the document to the keys a reading of its CommCare HQ app gives: two of its entities share one ${entry.kind} key, so a reading could not tell them apart. A document the commit gate admits holds no two entities of one key; look at the document's ${entry.kind} entities.`,
			);
		seen.add(text);
	}
	return sortIdentityMapEntries(entries);
}

/** The next 0-based ordinal of `equalityKey` among the entities counted so far. */
function nextOrdinal(counts: Map<string, number>, equalityKey: string): number {
	const n = counts.get(equalityKey) ?? 0;
	counts.set(equalityKey, n + 1);
	return n;
}

function authoredPath(structure: FormStructure, uuid: Uuid): readonly string[] {
	const path = formFieldPath(structure, uuid);
	if (path === undefined)
		throw new Error(
			`Nova could not find the path of question ${uuid} in form ${structure.formUuid}. Every question of a form the commit gate admits sits on a path from the form's root.`,
		);
	return path;
}

function addCaseOperations(
	doc: BlueprintDoc,
	form: Form,
	xmlns: string,
	structure: FormStructure,
	add: (key: ExternalKey, uuid: Uuid) => void,
): void {
	const operations = form.caseOperations ?? [];
	if (operations.length === 0) return;
	const { placements } = planPlacements(doc, form.uuid);
	const counts = new Map<string, number>();
	for (const operation of operations) {
		const planned = placements.get(operation.uuid);
		if (planned === undefined)
			throw new Error(
				`Nova found no place for case operation ${operation.uuid} of form ${form.uuid}. The plan of a form's case changes places every operation.`,
			);
		const place = placeKey(structure, operation, planned.placement);
		const n = nextOrdinal(counts, JSON.stringify([place, operation.action]));
		add(
			externalKey.caseOperation(xmlns, place, operation.action, n),
			operation.uuid,
		);
	}
}

/** A case operation's `place`, from the placement it takes. */
function placeKey(
	structure: FormStructure,
	operation: CaseOperation,
	placement: CasePlacement,
): CaseOperationPlaceKey {
	switch (placement.kind) {
		case "basic":
			return basicPlaceKey(structure, operation, placement);
		case "advanced":
			return ["advanced", placement.tag];
		case "save-to-case":
			return [
				"save-to-case",
				placement.repeat === undefined
					? []
					: authoredPath(structure, placement.repeat),
				placement.path,
			];
	}
}

function basicPlaceKey(
	structure: FormStructure,
	operation: CaseOperation,
	placement: BasicPlacement,
): CaseOperationPlaceKey {
	switch (placement.slot) {
		case "own":
			return ["basic", "own"];
		case "usercase":
			return ["basic", "usercase"];
		case "subcase":
			return ["basic", "subcase", placement.index];
		case "subcase-row": {
			const repeat = operation.forEach?.repeat;
			if (repeat === undefined)
				throw new Error(
					`Nova placed case operation ${operation.uuid} in a repeat's row, and it runs in no repeat. A row's subcase is a create that runs per row.`,
				);
			return ["basic", "subcase-row", authoredPath(structure, repeat)];
		}
	}
}

function linkTargetKey(
	doc: BlueprintDoc,
	identity: WireIdentity,
	target: FormLinkTarget,
): FormLinkTargetKey {
	switch (target.type) {
		case "form": {
			const targetForm = ownRecordValue(doc.forms, target.formUuid);
			if (targetForm === undefined)
				throw new Error(
					`Nova could not map an after-submit link to form ${target.formUuid}: the document holds no such form. A document the commit gate admits links only to its own forms.`,
				);
			return ["form", identity.formXmlns(targetForm)];
		}
		case "module":
			return ["module", identity.moduleUniqueId(target.moduleUuid)];
		case "this-form":
			return ["this-form"];
	}
}
