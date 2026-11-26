/**
 * A basic menu whose case type the reading refuses and keeps.
 *
 * Contract: a basic menu of `commcare-user` is refused at the menu
 * (`case-type-commcare-user-or-user-owner-mapping-case-on-a-basic`), and the
 * reading keeps the type so its forms are read as written
 * (`menus/modules.ts::keepsRefusedCaseType`). Nova's writer plans no basic
 * form of such a menu, so its forms' actions are not planned again and
 * compared: the menu's one finding stands for them.
 *
 * The plausible failure: the comparison planning the form anyway, finding no
 * basic plan, and raising a second, `unrecognized` finding at the form's
 * actions (what the matrix row `hq-case-lists/worker-case-type-on-a-basic-menu`
 * showed).
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

it("refuses a basic menu of the worker's record once, at the menu, and nothing at its forms", async () => {
	const answer = JSON.parse(
		readFileSync("proof/hq-apps/hq-case-lists/app-source.json", "utf8"),
	) as { body: string };
	const body = JSON.parse(answer.body) as {
		modules: Record<string, unknown>[];
	};
	const menu = body.modules[1];
	if (menu === undefined) throw new Error("The base holds a second menu.");
	menu.case_type = "commcare-user";
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	expect(
		outcome.kind === "account"
			? outcome.findings.map((finding) => [finding.code, finding.place.kind])
			: [],
	).toEqual([
		[
			"menus-and-case-lists/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic",
			"menu",
		],
	]);
});
