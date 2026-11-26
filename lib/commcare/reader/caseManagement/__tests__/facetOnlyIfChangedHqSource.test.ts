/**
 * A follow-up's own owner saved only when changed, in an app HQ's own pages
 * made.
 *
 * Contract: in a project space with `SAVE_ONLY_EDITED_FORM_FIELDS`, HQ's
 * build compares an `owner_id` update with the casedb `case/owner_id` leaf
 * (`xform.py::XFormCaseBlock.add_case_updates`), so the reading holds it as
 * the own operation's `ownerOnlyIfChanged`, under
 * `update-mode-edit-on-a-case-s-name-or-owner`, with nothing refused. This
 * is the matrix row `hq-case-management/edit-mode-on-the-own-owner` read
 * through the production reader from the retained source.
 *
 * The plausible failure: the reading refusing the mode on the owner, as it
 * did while Nova saved a case's owner every time, or dropping it as inert.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

it("reads `edit` on a follow-up's own `owner_id` as the own operation's ownerOnlyIfChanged", async () => {
	const answer = JSON.parse(
		readFileSync("proof/hq-apps/hq-case-management/app-source.json", "utf8"),
	) as { body: string };
	const body = JSON.parse(answer.body) as {
		modules: {
			forms: {
				actions: { update_case: { update: Record<string, unknown> } };
			}[];
		}[];
	};
	const form = body.modules[1]?.forms[0];
	if (form === undefined) throw new Error("The base holds a follow-up form.");
	form.actions.update_case.update.owner_id = {
		question_path: "/data/status_note",
		update_mode: "edit",
		doc_type: "ConditionalCaseUpdate",
	};
	const outcome = readHqApp(
		await inputFor(body, { saveOnlyEditedApplied: true }),
	);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The reading refuses the app: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
		);
	const doc = outcome.draft.doc;
	const members = doc.moduleOrder[1];
	const followup =
		members === undefined
			? undefined
			: doc.forms[doc.formOrder[members]?.[0] ?? ""];
	expect(followup?.caseOperations?.[0]).toMatchObject({
		action: "own",
		ownerOnlyIfChanged: true,
	});
});
