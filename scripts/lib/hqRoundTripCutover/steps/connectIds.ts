/**
 * Step `connect-ids`: renames each Connect block id the grammar refuses
 * (`lib/commcare/connectSlugs.ts::connectIdProblem`): what HQ's form builder
 * can't keep in a question id, and the five names CommCare Connect's
 * receiver reads as its own keys (part 08 of step 2's plan, Defect 15 and
 * Finding 60). A block's id is its wrapper's name in the form's data, so a
 * path written as text that reaches it is rewritten by the shared module.
 *
 * Ids are unique across the app. The ids the grammar admits are taken first,
 * and each refused id becomes `freeConnectId(id, taken)`: editor-safe, free
 * among every Connect id of the app and its own form's root fields (whose
 * elements sit beside the block's wrapper), and cut at the tail so the id
 * with its suffix fits 50 characters. `_1st_visit` becomes `q1st_visit`, the same
 * length, so only a collision's suffix cuts a 50-character id.
 *
 * One `connect-block-renamed` line per block, naming its form, with the
 * block's kind and the old and new ids. Connect reads a renamed block as a
 * new one, which the line says, and the report lists each deployment of an
 * app whose deliver unit, learn module or task this step renames.
 */

import { connectIdProblem, freeConnectId } from "@/lib/commcare/connectSlugs";
import { asUuid } from "@/lib/domain";
import type { CutoverStep, DocumentChange } from "../transform";
import { unresolvedPathBlockers } from "./questionIds";
import {
	connectNodeKey,
	isRecord,
	rawRootNames,
	rawText,
	rewriteFormRelativePaths,
} from "./relativePaths";

/** The four Connect blocks a form can hold, in the order a form lists them. */
export const CONNECT_BLOCK_KINDS = [
	"learn_module",
	"assessment",
	"deliver_unit",
	"task",
] as const;

export const connectIdsStep: CutoverStep = {
	id: "connect-ids",
	apply(document, _context, blockers = []) {
		const blocks: { formUuid: string; kind: string; id: string }[] = [];
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const connect = document.forms[formUuid]?.connect;
				if (!isRecord(connect)) continue;
				for (const kind of CONNECT_BLOCK_KINDS) {
					const block = connect[kind];
					if (isRecord(block) && typeof block.id === "string") {
						blocks.push({ formUuid, kind, id: block.id });
					}
				}
			}
		}
		const refused = (id: string) => connectIdProblem(id)?.kind === "format";
		const taken = new Set(
			blocks.filter((block) => !refused(block.id)).map((block) => block.id),
		);
		const renames = blocks.flatMap((block) => {
			if (!refused(block.id)) return [];
			const to = freeConnectId(
				block.id,
				new Set([...taken, ...rawRootNames(document, block.formUuid).fieldIds]),
			);
			taken.add(to);
			return [{ ...block, to }];
		});

		const changes: DocumentChange[] = [];
		const forms = [...new Set(renames.map((rename) => rename.formUuid))];
		for (const formUuid of forms) {
			const form = document.forms[formUuid];
			const inForm = renames.filter((rename) => rename.formUuid === formUuid);
			blockers.push(
				...unresolvedPathBlockers(
					document,
					formUuid,
					rewriteFormRelativePaths(
						document,
						formUuid,
						inForm.map((rename) => ({
							key: connectNodeKey(rename.kind),
							from: rename.id,
							to: rename.to,
						})),
					),
				),
			);
			const connect = form?.connect;
			if (form === undefined || !isRecord(connect)) continue;
			for (const rename of inForm) {
				const block = connect[rename.kind];
				if (!isRecord(block)) continue;
				(block as { id: string }).id = rename.to;
				changes.push({
					reason: "connect-block-renamed",
					entity: {
						type: "form",
						uuid: asUuid(formUuid),
						nameAtMigration: rawText(form.name),
					},
					detail: { block: rename.kind, from: rename.id, to: rename.to },
				});
			}
		}
		return changes;
	},
};
