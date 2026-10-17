/**
 * Step `case-operation-ids`: renames each case operation whose id is
 * `instance`, `bind` or `parsererror`, the names HQ's form builder can't
 * open a form holding (`lib/domain/questionId.ts::caseOperationIdNameProblem`;
 * part 08 of step 2's plan, Finding 43). A case operation id keeps its own
 * grammar otherwise: a leading underscore, a leading `XML` and `meta` stay,
 * since HQ's form builder keeps a Save to Case block's wrapper so named.
 *
 * Within each form the ids that stay are taken first, and each refused id
 * becomes `q_<id>`, suffixed until free (`freeCaseOperationName`), the name
 * the refusal offers. Every reference to an operation stores its uuid. A
 * link identifier is never renamed: it is the index name on cases that
 * exist, so a reserved one is the plan's blocker `link-identifier-reserved`.
 *
 * One `case-operation-renamed` line per operation, naming its form, with the
 * old and new ids.
 */

import { asUuid } from "@/lib/domain";
import {
	caseOperationIdNameProblem,
	freeCaseOperationName,
} from "@/lib/domain/questionId";
import type { CutoverStep, DocumentChange } from "../transform";
import { unresolvedPathBlockers } from "./questionIds";
import {
	isRecord,
	operationNodeKey,
	rawText,
	rewriteFormRelativePaths,
} from "./relativePaths";

export const caseOperationIdsStep: CutoverStep = {
	id: "case-operation-ids",
	apply(document, _context, blockers = []) {
		const changes: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined || !Array.isArray(form.caseOperations)) {
					continue;
				}
				const operations = form.caseOperations.filter(isRecord);
				const taken = new Set(
					operations
						.map((operation) => rawText(operation.id))
						.filter((id) => caseOperationIdNameProblem(id) === undefined),
				);
				const renames: { uuid: string; from: string; to: string }[] = [];
				for (const operation of operations) {
					const from = rawText(operation.id);
					if (caseOperationIdNameProblem(from) === undefined) continue;
					const to = freeCaseOperationName(from, taken);
					taken.add(to);
					renames.push({ uuid: rawText(operation.uuid), from, to });
				}
				if (renames.length === 0) continue;
				blockers.push(
					...unresolvedPathBlockers(
						document,
						formUuid,
						rewriteFormRelativePaths(
							document,
							formUuid,
							renames.map((rename) => ({
								key: operationNodeKey(rename.uuid),
								from: rename.from,
								to: rename.to,
							})),
						),
					),
				);
				for (const rename of renames) {
					const operation = operations.find(
						(candidate) => candidate.uuid === rename.uuid,
					);
					if (operation === undefined) continue;
					(operation as { id: string }).id = rename.to;
					changes.push({
						reason: "case-operation-renamed",
						entity: {
							type: "form",
							uuid: asUuid(formUuid),
							nameAtMigration: rawText(form.name),
						},
						detail: { from: rename.from, to: rename.to },
					});
				}
			}
		}
		return changes;
	},
};
