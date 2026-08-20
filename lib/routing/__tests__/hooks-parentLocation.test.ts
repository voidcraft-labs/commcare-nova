/**
 * Tests for `parentLocation` — the pure helper backing `useNavigate().up()`.
 *
 * Previously covered indirectly by a single `up`-on-form case in
 * `hooks-useNavigate.test.tsx`. That only exercised one branch of the
 * switch; this file walks every `kind` + sub-shape to lock down the
 * walk policy.
 *
 * Policy (reproduced from the `parentLocation` source):
 *   home                    → undefined (root has no parent)
 *   module                  → home
 *   cases (no caseId)       → module
 *   cases (with caseId)     → cases (drops the id, stays on list)
 *   form (no selection)     → module
 *   form (with selection)   → form (drops the selection, stays on form)
 *   form-links (no link)    → form
 *   form-links (with link)  → form-links (drops the link, stays on the list)
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";

import { parentLocation } from "@/lib/routing/hooks";

const MOD = testUuid("mod-1");
const FORM = testUuid("form-1");
const Q = testUuid("q-1");
const LINK = testUuid("link-1");

describe("parentLocation", () => {
	it("home → undefined (root has no parent)", () => {
		expect(parentLocation({ kind: "home" })).toBeUndefined();
	});

	it("module → home", () => {
		expect(parentLocation({ kind: "module", moduleUuid: MOD })).toEqual({
			kind: "home",
		});
	});

	it("cases (no caseId) → module", () => {
		expect(parentLocation({ kind: "cases", moduleUuid: MOD })).toEqual({
			kind: "module",
			moduleUuid: MOD,
		});
	});

	it("cases (with caseId) → cases without caseId", () => {
		/* One click on "up" drops just the case id — the user stays on
		 * the list rather than jumping all the way up to the module. */
		expect(
			parentLocation({ kind: "cases", moduleUuid: MOD, caseId: "abc" }),
		).toEqual({ kind: "cases", moduleUuid: MOD });
	});

	it("form (no selection) → module", () => {
		expect(
			parentLocation({ kind: "form", moduleUuid: MOD, formUuid: FORM }),
		).toEqual({ kind: "module", moduleUuid: MOD });
	});

	it("form (with selection) → same form with selection dropped", () => {
		/* Symmetric with `cases`: one click drops the innermost concept
		 * (the selection) before jumping up the tree. */
		expect(
			parentLocation({
				kind: "form",
				moduleUuid: MOD,
				formUuid: FORM,
				selectedUuid: Q,
			}),
		).toEqual({ kind: "form", moduleUuid: MOD, formUuid: FORM });
	});

	it("form-links (no link) → form", () => {
		expect(
			parentLocation({ kind: "form-links", moduleUuid: MOD, formUuid: FORM }),
		).toEqual({ kind: "form", moduleUuid: MOD, formUuid: FORM });
	});

	it("form-links (with link) → the list with the link dropped", () => {
		/* Same inward walk as a selected field or operation: one click drops
		 * the selection and stays on the list. */
		expect(
			parentLocation({
				kind: "form-links",
				moduleUuid: MOD,
				formUuid: FORM,
				linkUuid: LINK,
			}),
		).toEqual({ kind: "form-links", moduleUuid: MOD, formUuid: FORM });
	});
});
