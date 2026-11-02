/**
 * The advanced-module documents hold the shapes their rows name, each made
 * by the document's own content.
 *
 * Contract: each menu that a document needs advanced is emitted advanced
 * (`lib/commcare/moduleKind.ts::emittedModuleKind`) because a create one of
 * its forms makes is carried by an after-submit link, and every other menu
 * is emitted basic; each change the document's rows name takes the place its
 * row witnesses (`lib/commcare/placement.ts::planPlacements`): the
 * registration's own case and the carried extension case as open actions,
 * the chained and own loads and the worker's load, the two indexed open
 * actions in one repeat, an uncarried extension case in a Save to Case
 * block of a basic menu, and a create indexed to a load HQ's child-menu
 * alignment renames in a Save to Case block. `targeted-advanced-held-kind`'s
 * first publish records the kind, and its written edit, made again over
 * what that publish stored, keeps the menu advanced with every open action
 * where the publish put it. The plausible failures: a fixture change, or a
 * change to what makes a menu advanced, that leaves a document holding a
 * basic menu where it witnesses an advanced one (its manifest entries would
 * then be emitted by nothing, and the lane would pass by reading nothing),
 * and a record that drops the held kind, so the edit would move every path
 * the publish wrote. The observations are the documents' plans.
 */

import { describe, expect, it } from "vitest";
import { openActionIneligibility } from "@/lib/commcare/advancedPlacement";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { planPlacements } from "@/lib/commcare/placement";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CasePlacement, Uuid } from "@/lib/domain";
import type { CorpusDocument } from "../../corpus/documents";
import {
	afterFirstPublish,
	writtenEditOverRecord,
} from "../../corpus/editBatches";
import { targetedUuid } from "../build";
import {
	advancedChildModule,
	advancedHeldKind,
	advancedModule,
	extensionCarried,
	rootCaseBlockNames,
} from "../documents/advancedModules";

/** Each menu's emitted kind, by name. */
function kinds(doc: BlueprintDoc): Record<string, string> {
	return Object.fromEntries(
		doc.moduleOrder.map((uuid) => [
			doc.modules[uuid].name,
			emittedModuleKind(doc, uuid),
		]),
	);
}

/** Where each change of a form is kept, by operation id. */
function places(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Record<string, CasePlacement | undefined> {
	const { placements } = planPlacements(doc, formUuid);
	return Object.fromEntries(
		(doc.forms[formUuid]?.caseOperations ?? []).map((operation) => [
			operation.id,
			placements.get(operation.uuid)?.placement,
		]),
	);
}

function made(document: CorpusDocument) {
	const uuid = (name: string) => targetedUuid(document.id, name);
	return { doc: hydratePersistedBlueprint(document.doc), uuid };
}

const open = (tag: string): CasePlacement => ({ kind: "advanced", tag });

describe("targeted-advanced-module", () => {
	const { doc, uuid } = made(advancedModule());

	it("is advanced by the episode its registration's link carries, and nothing else is", () => {
		expect(kinds(doc)).toEqual({
			Households: "basic",
			Patients: "advanced",
			Episodes: "basic",
			Visits: "basic",
		});
	});

	it("keeps each change on the action its row witnesses", () => {
		expect(places(doc, uuid("register"))).toEqual({
			patient: open("open_patient_0"),
			episode: open("open_episode_1"),
		});
		expect(places(doc, uuid("visit"))).toEqual({
			patient: open("load_patient1"),
			close_household: open("load_household0"),
			commcare_user: open("autoload_commcare_user2"),
			visit: open("open_visit_0"),
			follow_up: open("open_visit_1"),
		});
		expect(places(doc, uuid("discharge"))).toEqual({
			patient: open("load_patient1"),
		});
		// The household's load comes first, and the patient's indexes it.
		expect(
			planPlacements(doc, uuid("visit")).advanced?.loads.map(
				(load) => load.tag,
			),
		).toEqual(["load_household0", "load_patient1", "autoload_commcare_user2"]);
	});
});

describe("targeted-extension-carried", () => {
	const { doc, uuid } = made(extensionCarried());

	it("opens the carried referral as an action and keeps the uncarried one in a block", () => {
		expect(kinds(doc)).toEqual({
			Enrollment: "advanced",
			Clients: "basic",
			Referrals: "basic",
		});
		expect(places(doc, uuid("enroll"))).toEqual({
			client: open("open_client_0"),
			referral: open("open_referral_1"),
		});
		expect(places(doc, uuid("refer"))).toEqual({
			client: { kind: "basic", slot: "own" },
			referral: { kind: "save-to-case", path: ["nova_operations", "referral"] },
		});
	});
});

describe("targeted-advanced-child-module", () => {
	const { doc, uuid } = made(advancedChildModule());

	it("keeps the note indexed to the renamed load in a block", () => {
		expect(kinds(doc)).toEqual({
			Households: "basic",
			Plans: "advanced",
			Visits: "basic",
			Notes: "basic",
		});
		expect(places(doc, uuid("plan"))).toEqual({
			household: open("load_household0"),
			visit: open("open_visit_0"),
			note: { kind: "save-to-case", path: ["nova_operations", "note"] },
		});
		expect(openActionIneligibility(doc, uuid("plan"), uuid("add-note"))).toBe(
			"link-renamed-load",
		);
	});
});

describe("targeted-advanced-held-kind", () => {
	const document = advancedHeldKind();
	const { doc, uuid } = made(document);
	const published = hydratePersistedBlueprint(
		afterFirstPublish(document.id, doc, undefined).doc,
	);
	const written = document.edit;
	if (written === undefined) throw new Error("The document writes its edit.");
	const next = writtenEditOverRecord(
		document.id,
		published,
		written.mutations,
		undefined,
	).nextDoc;

	it("records the kind at its first publish, and its edit keeps the menu advanced", () => {
		expect(published.modules[uuid("patients")]?.heldKind).toBe("advanced");
		expect(next.forms[uuid("enroll")]?.formLinks).toBeUndefined();
		expect(kinds(next).Patients).toBe("advanced");
		expect(places(next, uuid("enroll"))).toEqual({
			patient: open("open_patient_0"),
			episode: open("open_episode_1"),
		});
	});

	it("is basic without the link where nothing holds the kind", () => {
		const edit = document.edit;
		if (edit === undefined) throw new Error("The document writes its edit.");
		expect(kinds(hydratePersistedBlueprint(edit.nextDoc)).Patients).toBe(
			"basic",
		);
	});
});

describe("targeted-root-case-block-names", () => {
	const { doc, uuid } = made(rootCaseBlockNames());

	it("puts its child and its worker update in the slots whose names its questions hold", () => {
		expect(places(doc, uuid("register")).member).toEqual({
			kind: "basic",
			slot: "subcase",
			index: 0,
		});
		expect(places(doc, uuid("check")).commcare_user).toEqual({
			kind: "basic",
			slot: "usercase",
		});
		expect(doc.fields[uuid("subcase-0")]?.id).toBe("subcase_0");
		expect(doc.fields[uuid("commcare-usercase")]?.id).toBe("commcare_usercase");
	});
});
