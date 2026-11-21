// A form's case actions as Nova writes them before any case change is added,
// held to what CommCare HQ stores for a form its own pages create (the
// apps the proof lane retains under `proof/hq-apps/`, made by HQ's pages at
// its pin). A key Nova writes at a value other than HQ's is changed on every
// form of an app Nova brings in from HQ when it publishes it back, a change
// the first-publish register names nowhere: Nova once wrote each condition's
// operator null and the open action's name path blank where HQ stores `=`
// and null.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alwaysCondition, emptyFormActions, neverCondition } from "../hqShells";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function storedForms(base: string): { requires: string; actions: Json }[] {
	const app = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				"..",
				"proof",
				"hq-apps",
				base,
				"app.json",
			),
			"utf8",
		),
	) as { modules: { forms: { requires: string; actions: Json }[] }[] };
	return app.modules.flatMap((module) => module.forms);
}

/** Each pointer Nova writes, with the value Nova writes there and the value HQ stores there. */
function written(
	nova: unknown,
	hq: Json | undefined,
	at = "",
): { at: string; nova: unknown; hq: Json | undefined }[] {
	if (
		typeof nova === "object" &&
		nova !== null &&
		!Array.isArray(nova) &&
		Object.keys(nova).length > 0
	) {
		const held =
			typeof hq === "object" && hq !== null && !Array.isArray(hq)
				? hq
				: undefined;
		return Object.entries(nova).flatMap(([key, value]) =>
			written(value, held?.[key], `${at}/${key}`),
		);
	}
	return [{ at, nova, hq }];
}

describe("the shells of a form's case actions", () => {
	it("writes a form's actions before any case change as CommCare HQ stores a form its pages create", () => {
		// hq-lookups' one form is a survey HQ's pages made and no case page saved.
		const [survey] = storedForms("hq-lookups");
		expect(survey?.requires).toBe("none");
		const pairs = written(emptyFormActions(), survey?.actions);
		expect(pairs.length).toBeGreaterThan(0);
		for (const pair of pairs) expect(pair.nova, pair.at).toEqual(pair.hq);
	});

	it("writes an always and a never condition as HQ stores them on a registration form its pages create", () => {
		const registration = storedForms("hq-plain").find(
			(form) => form.requires === "none",
		)?.actions as
			| {
					open_case: { condition: Json };
					update_case: { condition: Json };
					close_case: { condition: Json };
			  }
			| undefined;
		expect(registration?.update_case.condition).toEqual(alwaysCondition());
		expect(registration?.open_case.condition).toEqual(alwaysCondition());
		expect(registration?.close_case.condition).toEqual(neverCondition());
	});
});
