// components/builder/form-links/__tests__/refusalCopy.test.ts
//
// Every refusal reads as a sentence about the rule the planner enforces,
// and no refusal implies one it does not. The sentences are part 07 §3.11's
// where it gives them, word for word.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormLinkRefusal } from "@/lib/doc/formLinkMutations";
import type { Uuid } from "@/lib/doc/types";
import {
	formLinkRefusalReason,
	NO_OTHERWISE_LINK_REASON,
	OTHERWISE_UNREACHABLE_REASON,
	otherwiseUnavailableReason,
	planRefusal,
	removalQuestion,
	submenuNotOfferedReason,
	targetRefusal,
	targetRefusalReason,
} from "../refusalCopy";

const PARENT = testUuid("mod-parent");
const CHILD = testUuid("mod-child");
const NAMES: Record<string, string> = { [PARENT]: "Households" };
const menuNameOf = (uuid: Uuid) => NAMES[uuid];

describe("target refusals", () => {
	it("names the menu to choose instead of a submenu CommCare HQ doesn't offer", () => {
		expect(
			targetRefusalReason(
				{
					ok: false,
					reason: "not-offered",
					menuUuid: CHILD,
					parentUuid: PARENT,
				},
				menuNameOf,
			),
		).toBe(
			"CommCare HQ can't link to this submenu from here. You can choose Households or a form inside it.",
		);
		expect(submenuNotOfferedReason(undefined)).toBe(
			"CommCare HQ can't link to this submenu from here. You can choose a form inside it.",
		);
	});

	it("points a self reference at Start this form again", () => {
		expect(
			targetRefusalReason({ ok: false, reason: "self-target" }, menuNameOf),
		).toBe(
			"A link can't name this form by itself. You can choose Start this form again instead.",
		);
	});

	it("keeps a missing destination apart and has nothing to say about an offered one", () => {
		expect(
			targetRefusalReason(
				{ ok: false, reason: "target-not-found" },
				menuNameOf,
			),
		).toBe("That destination is no longer part of the app.");
		expect(targetRefusal({ ok: true }, menuNameOf)).toBeUndefined();
	});
});

describe("planner refusals", () => {
	const every: readonly FormLinkRefusal[] = [
		{ kind: "form-not-found" },
		{ kind: "link-not-found", uuid: CHILD },
		{ kind: "duplicate-uuid", uuid: CHILD },
		{ kind: "target-not-found" },
		{ kind: "self-target" },
		{ kind: "target-not-offered", menuUuid: CHILD, parentUuid: PARENT },
		{ kind: "menu-carries-values" },
		{ kind: "selection-cardinality" },
		{ kind: "otherwise-unreachable" },
		{
			kind: "otherwise-not-offered",
			destination: "previous",
			reason: "menu-forms-read-search",
		},
		{ kind: "otherwise-exists" },
		{ kind: "no-otherwise-link" },
		{ kind: "stale-base" },
	];

	it("says every refusal kind as a sentence that ends in a period", () => {
		for (const reason of every) {
			const sentence = formLinkRefusalReason(reason, menuNameOf);
			expect(sentence, reason.kind).toMatch(/^[A-Z].*\.$/);
			expect(sentence, reason.kind).not.toMatch(/—|\.\.\./);
		}
	});

	it("speaks part 07's words for the Otherwise refusals", () => {
		expect(
			formLinkRefusalReason({ kind: "otherwise-unreachable" }, menuNameOf),
		).toBe(
			"Give a destination a condition first, so there is a time when none runs.",
		);
		expect(
			formLinkRefusalReason({ kind: "no-otherwise-link" }, menuNameOf),
		).toBe(
			"This form's Otherwise isn't a link, so there's no destination to make from it.",
		);
		expect(
			formLinkRefusalReason(
				{ kind: "target-not-offered", menuUuid: CHILD, parentUuid: PARENT },
				menuNameOf,
			),
		).toBe(
			"CommCare HQ can't link to this submenu from here. You can choose Households or a form inside it.",
		);
		expect(
			formLinkRefusalReason(
				{
					kind: "otherwise-not-offered",
					destination: "previous",
					reason: "menu-forms-read-search",
				},
				menuNameOf,
			),
		).toBe(
			"This form's menu doesn't offer Previous screen after submit. You can choose another one.",
		);
	});

	it("reads a plan's refusal, and nothing for an admitted plan", () => {
		expect(
			planRefusal(
				{ ok: false, reason: { kind: "otherwise-exists" } },
				menuNameOf,
			),
		).toBe("This form already has an Otherwise. You can change it instead.");
		expect(
			planRefusal({ ok: true, mutations: [] }, menuNameOf),
		).toBeUndefined();
	});
});

describe("the add control's Otherwise", () => {
	it("is on offer while nothing else refuses it, and says why it is not", () => {
		const base = {
			conditional: { ok: true },
			everyTime: { ok: true },
		} as const;
		expect(
			otherwiseUnavailableReason({ ...base, otherwise: { ok: true } }),
		).toBeUndefined();
		expect(
			otherwiseUnavailableReason({
				...base,
				otherwise: { ok: false, reason: "otherwise-unreachable" },
			}),
		).toBe(OTHERWISE_UNREACHABLE_REASON);
		expect(
			otherwiseUnavailableReason({
				...base,
				otherwise: { ok: false, reason: "otherwise-exists" },
			}),
		).toBe(
			"This form already has an Otherwise. You can change it in the last row.",
		);
		expect(NO_OTHERWISE_LINK_REASON).toContain("Otherwise isn't a link");
	});
});

describe("removal", () => {
	it("names what becomes of the Otherwise", () => {
		expect(
			removalQuestion("Go to “Visit”", {
				ok: true,
				mutations: [],
				otherwiseToPostSubmit: "module",
			}),
		).toBe(
			"Remove “Go to “Visit””? This form's Otherwise then becomes where it goes after submit. You can undo this.",
		);
		expect(
			removalQuestion("Go to “Visit”", {
				ok: true,
				mutations: [],
				otherwiseToDestination: CHILD,
			}),
		).toBe(
			"Remove “Go to “Visit””? This form's Otherwise then becomes where it goes after submit. You can undo this.",
		);
		expect(
			removalQuestion("Go to “Visit”", {
				ok: true,
				mutations: [],
				droppedOtherwise: { kind: "destination", destination: "module" },
			}),
		).toBe(
			"Remove “Go to “Visit””? This form's Otherwise then goes too, because every destination left runs each time. You can undo this.",
		);
	});

	it("asks plainly when nothing else changes", () => {
		expect(removalQuestion("Go to “Visit”", { ok: true, mutations: [] })).toBe(
			"Remove “Go to “Visit””? You can undo this.",
		);
	});
});
