/**
 * Step `question-ids`: renames each field whose id the question-id grammar
 * refuses (`lib/domain/questionId.ts::questionIdProblem`), whatever its
 * kind, since a question, a Hidden Value, a group, a repeat and a section
 * each name a data node: a leading underscore, a first character that is no
 * letter, a leading `XML`, `meta`, `case`, `registration` or `script` in any
 * case, and `instance`, `bind` or `parsererror`. HQ's form builder can't
 * keep a form holding one (part 08 of step 2's plan, Defect 15, Findings 43
 * and 70).
 *
 * It also renames each root field whose id is one of its form's Connect
 * block ids while the app has a Connect mode
 * (`FIELD_ID_NAMES_CONNECT_BLOCK`): the block's wrapper and the field would
 * be two elements of one name in the form's data root. The field moves, not
 * the block, since a block id is the deliver or learn unit Connect keys on.
 *
 * Within each parent, the ids kept are taken first; each renamed id becomes
 * `editorSafeQuestionId(id)`, suffixed until free among its siblings
 * (`suffixUntilFree`), in document order. At a form's root the form's
 * Connect block ids are taken too, since their wrappers sit beside the root
 * fields, so a clashing `e2_consent` becomes `e2_consent_2`, the id the
 * finding offers. A reference leaf
 * stores the field's uuid and prints its new name by construction; a path
 * written as text is rewritten by the shared module before the ids are
 * written, and one it cannot follow is the blocker `unresolved-relative-path`.
 *
 * One `question-renamed` line per field, naming the field, with its form,
 * its kind (question, group, repeat or section) and the old and new ids.
 */

import { asUuid } from "@/lib/domain";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import {
	editorSafeQuestionId,
	questionIdProblem,
} from "@/lib/domain/questionId";
import type { RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange, StepBlocker } from "../transform";
import {
	fieldNodeKey,
	fieldUuidsUnder,
	type NodeRename,
	rawRootNames,
	rawText,
	rewriteFormRelativePaths,
	type UnresolvedName,
} from "./relativePaths";

/** The noun a rename notice uses for a field of this kind. */
function renamedKind(kind: string): string {
	return kind === "group" || kind === "repeat" || kind === "section"
		? kind
		: "question";
}

/** Each refused id under one parent, with the free id it becomes. At the
 * form's root, the form's Connect block ids are taken too, and a field named
 * like one of them is renamed while the app has a Connect mode, the one case
 * the validator reads the blocks in. */
function siblingRenames(
	document: RawDocument,
	formUuid: string,
	parent: string,
): { uuid: string; from: string; to: string }[] {
	const children = (document.fieldOrder[parent] ?? []).flatMap((uuid) => {
		const field = document.fields[uuid];
		return field === undefined ? [] : [{ uuid, id: rawText(field.id) }];
	});
	const connectIds =
		parent === formUuid
			? rawRootNames(document, formUuid).connectIds
			: new Set<string>();
	const namesBlock = (id: string) =>
		document.connectType !== null && connectIds.has(id);
	const renamed = (id: string) =>
		questionIdProblem(id) !== undefined || namesBlock(id);
	const taken = new Set([
		...children.filter((child) => !renamed(child.id)).map((child) => child.id),
		...connectIds,
	]);
	const renames: { uuid: string; from: string; to: string }[] = [];
	for (const child of children) {
		if (!renamed(child.id)) continue;
		const to = suffixUntilFree(editorSafeQuestionId(child.id), taken);
		taken.add(to);
		renames.push({ uuid: child.uuid, from: child.id, to });
	}
	return renames;
}

/** A blocker for each path step the rewrite could not follow. */
export function unresolvedPathBlockers(
	document: RawDocument,
	formUuid: string,
	unresolved: readonly UnresolvedName[],
): StepBlocker[] {
	const form = document.forms[formUuid];
	return unresolved.map((name) => ({
		code: "unresolved-relative-path",
		entity:
			name.carrier.kind === "field"
				? {
						type: "field",
						uuid: asUuid(name.carrier.fieldUuid),
						nameAtMigration: rawText(
							document.fields[name.carrier.fieldUuid]?.id,
						),
					}
				: {
						type: "form",
						uuid: asUuid(formUuid),
						nameAtMigration: rawText(form?.name),
					},
		detail: {
			form: rawText(form?.name),
			slot: name.slot,
			name: name.name,
			expression: name.expression,
		},
	}));
}

export const questionIdsStep: CutoverStep = {
	id: "question-ids",
	apply(document, _context, blockers = []) {
		const changes: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				if (document.forms[formUuid] === undefined) continue;
				const parents = [
					formUuid,
					...fieldUuidsUnder(document, formUuid).filter(
						(uuid) => document.fieldOrder[uuid] !== undefined,
					),
				];
				const renames = parents.flatMap((parent) =>
					siblingRenames(document, formUuid, parent),
				);
				if (renames.length === 0) continue;
				const unresolved = rewriteFormRelativePaths(
					document,
					formUuid,
					renames.map(
						(rename): NodeRename => ({
							key: fieldNodeKey(rename.uuid),
							from: rename.from,
							to: rename.to,
						}),
					),
				);
				blockers.push(
					...unresolvedPathBlockers(document, formUuid, unresolved),
				);
				for (const rename of renames) {
					const field = document.fields[rename.uuid];
					if (field === undefined) continue;
					(field as { id: string }).id = rename.to;
					changes.push({
						reason: "question-renamed",
						entity: {
							type: "field",
							uuid: asUuid(rename.uuid),
							nameAtMigration: rename.to,
						},
						detail: {
							form: rawText(document.forms[formUuid]?.name),
							kind: renamedKind(rawText(field.kind)),
							from: rename.from,
							to: rename.to,
						},
					});
				}
			}
		}
		return changes;
	},
};
