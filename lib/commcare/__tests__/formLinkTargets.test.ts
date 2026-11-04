/**
 * The link targets Nova admits from each form of
 * `targeted-form-link-otherwise`, written as the fixture
 * `proof/views/fixtures/form-link-targets.json`, which
 * `proof/views/test_form_link_targets.py` holds to the targets CommCare HQ's
 * form settings page lists for the same forms
 * (`corehq/apps/app_manager/views/forms.py::_get_linkable_forms_context`).
 *
 * Contract: the fixture is the production rule's answer, read through the
 * validator a commit runs: for each form, every menu and every form of the
 * document taken as the form's one destination (the form itself as
 * `this-form`, the one spelling of a link to itself), kept where the
 * validator raises no `FORM_LINK_TARGET_NOT_OFFERED`
 * (`lib/domain/formLinkTargets.ts::menuTargetOffered`); and, for HQ's
 * retiring `FORM_LINK_ADVANCED_MODE`, under which HQ's page lists every menu,
 * every candidate. The plausible failures: a validator that refuses a submenu
 * HQ offers, or admits one it does not (then a link Nova writes is one HQ's
 * page drops at the next save), a fixture left behind by a rule change (then
 * the view test holds HQ to a rule Nova no longer has), and a document that
 * stops holding a submenu either way (then the comparison holds nothing).
 * The fixture lives under `proof/` because a lane shard's checkout holds
 * only `proof/` and `lib/commcare/surface/` (`proof/CLAUDE.md`).
 *
 * Write it again with
 * `NOVA_WRITE_FORM_LINK_TARGETS=1 npx vitest run lib/commcare/__tests__/formLinkTargets.test.ts`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, FormLinkTarget, Uuid } from "@/lib/domain";
import { formLinkOtherwise } from "../../../proof/targeted/documents/formLinkOtherwise";

const FIXTURE = resolve(
	import.meta.dirname,
	"../../../proof/views/fixtures/form-link-targets.json",
);
const PROBE = "00000000-0000-4000-8000-00000000f11c" as Uuid;

interface Targets {
	/** Each menu listed, by name, in the document's menu order. */
	readonly menus: readonly string[];
	/** Each form listed, by its menu's name and its own, in menu and form order. */
	readonly forms: readonly (readonly [string, string])[];
}

interface FormTargets {
	readonly menu: string;
	readonly form: string;
	/** Whether the form holds a link, beside which HQ's page lists its targets. */
	readonly holdsLink: boolean;
	readonly offered: Targets;
	readonly offeredUnderAdvancedMode: Targets;
}

/** `doc` with `formUuid`'s after-submit only the one destination `target`. */
function withOnlyDestination(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): BlueprintDoc {
	const form = doc.forms[formUuid];
	if (form === undefined) throw new Error(`No form ${formUuid}.`);
	const {
		otherwise: _otherwise,
		postSubmit: _postSubmit,
		formLinks: _links,
		...rest
	} = form;
	// The reference index is derived from the forms, so the probe's document
	// carries none of the original's.
	const { refIndex: _refIndex, ...base } = doc;
	return {
		...base,
		forms: {
			...doc.forms,
			[formUuid]: { ...rest, formLinks: [{ uuid: PROBE, target }] },
		},
	};
}

/** Whether the validator admits `target` from `formUuid` as a target HQ's page offers. */
function admitted(
	doc: BlueprintDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): boolean {
	return !runValidation(
		withOnlyDestination(doc, formUuid, target),
		LOOKUP_CONTEXT_UNAVAILABLE,
	).some(
		(finding) =>
			finding.code === "FORM_LINK_TARGET_NOT_OFFERED" &&
			finding.details?.linkUuid === PROBE,
	);
}

function formLinkTargets(): {
	readonly document: string;
	readonly forms: readonly FormTargets[];
} {
	const document = formLinkOtherwise();
	const doc = hydratePersistedBlueprint(document.doc);
	const menuName = (moduleUuid: Uuid) => doc.modules[moduleUuid]?.name ?? "";
	const menuOf = new Map<Uuid, Uuid>();
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? [])
			menuOf.set(formUuid, moduleUuid);
	const everyForm = [...menuOf.entries()];
	const forms = everyForm.map(([formUuid, moduleUuid]): FormTargets => {
		const menus = doc.moduleOrder.map((candidate) => ({
			candidate,
			kept: admitted(doc, formUuid, { type: "module", moduleUuid: candidate }),
		}));
		const formTargets = everyForm.map(([candidate, candidateMenu]) => ({
			at: [menuName(candidateMenu), doc.forms[candidate]?.name ?? ""] as const,
			kept: admitted(
				doc,
				formUuid,
				candidate === formUuid
					? { type: "this-form" }
					: { type: "form", moduleUuid: candidateMenu, formUuid: candidate },
			),
		}));
		return {
			menu: menuName(moduleUuid),
			form: doc.forms[formUuid]?.name ?? "",
			holdsLink: (doc.forms[formUuid]?.formLinks?.length ?? 0) > 0,
			offered: {
				menus: menus.filter((m) => m.kept).map((m) => menuName(m.candidate)),
				forms: formTargets.filter((f) => f.kept).map((f) => f.at),
			},
			offeredUnderAdvancedMode: {
				menus: doc.moduleOrder.map(menuName),
				forms: formTargets.map((f) => f.at),
			},
		};
	});
	return { document: document.id, forms };
}

describe("form-link-targets.json", () => {
	const written = formLinkTargets();

	it("is the validator's offered targets for each form of targeted-form-link-otherwise", () => {
		if (process.env.NOVA_WRITE_FORM_LINK_TARGETS === "1")
			writeFileSync(FIXTURE, `${JSON.stringify(written, null, "\t")}\n`);
		expect(
			existsSync(FIXTURE),
			"proof/views/fixtures/form-link-targets.json is missing. Write it with NOVA_WRITE_FORM_LINK_TARGETS=1 npx vitest run lib/commcare/__tests__/formLinkTargets.test.ts.",
		).toBe(true);
		expect(
			JSON.parse(readFileSync(FIXTURE, "utf8")),
			"proof/views/fixtures/form-link-targets.json differs from the targets the validator offers. Write it again with NOVA_WRITE_FORM_LINK_TARGETS=1 npx vitest run lib/commcare/__tests__/formLinkTargets.test.ts and commit the change.",
		).toEqual(written);
	});

	it("holds a submenu offered by its parent's case type and one refused, and every form", () => {
		const of = (form: string) => {
			const found = written.forms.find((entry) => entry.form === form);
			if (found === undefined) throw new Error(`No ${form}.`);
			return found;
		};
		// From a submenu of a household menu, the other household menu's
		// submenu is offered; from a root menu, no submenu is.
		expect(of("Review member").offered.menus).toEqual([
			"Households",
			"Checks",
			"Loop",
			"Rounds",
			"Round checks",
		]);
		expect(of("Ping").offered.menus).toEqual(["Households", "Loop", "Rounds"]);
		expect(of("Add household").offered.menus).toEqual([
			"Households",
			"Loop",
			"Rounds",
		]);
		// Every form is a target from every form, the form itself included.
		for (const entry of written.forms) {
			expect(entry.offered.forms, entry.form).toEqual(
				entry.offeredUnderAdvancedMode.forms,
			);
			expect(entry.offered.forms, entry.form).toContainEqual([
				entry.menu,
				entry.form,
			]);
		}
		expect(written.forms.filter((entry) => entry.holdsLink)).toHaveLength(9);
	});
});
