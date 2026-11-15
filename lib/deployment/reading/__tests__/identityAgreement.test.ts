/**
 * Identity agreement between CommCare HQ's source and Nova's emission of
 * the reading's document.
 *
 * Contract: a reading of a source compares equal with Nova's emission of
 * its document; an appearance the reading lists as inert is cut from
 * CommCare HQ's side, so a source that holds one compares equal, and one it
 * does not list is a difference of the leaf's appearance; each of the four
 * appearances Nova writes (`minimal` on a trigger, `signature` on an image
 * upload, `field-list` on a group, `numeric` on a text input) listed as
 * inert is `identity/appearance/inert-held`, while `numeric` on a decimal
 * input listed as inert passes; a group whose `<label>` stands on one side
 * alone, and `field-list` written in another letter case, compare equal; a
 * guard block Nova writes that the source lacks is
 * `identity/case-blocks/save-to-case/added`; and the four conditions name
 * exactly the appearances Nova's emitter writes, over every document the
 * proof lane publishes, both fuzz corpora and a document built for each
 * condition.
 *
 * Plausible failures: a correct reading of an inert appearance or a blank
 * group label failed as Nova's mistake; a number keypad, a signature or a
 * question list dropped on the reader's word; a guard added or dropped
 * passing unseen.
 */

import { removeElement } from "domutils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	assertGenerated,
	manifestFor,
} from "@/lib/commcare/__tests__/compilerEvidence";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { expandDoc } from "@/lib/commcare/expander";
import { sourceIdentity } from "@/lib/commcare/hq/sourceIdentity";
import type { ReadDraft } from "@/lib/commcare/reader";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { kindAppearanceToken } from "@/lib/commcare/xform/appearance";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { holdsNovaAppearance, identityDifferences } from "../identityAgreement";
import { DOMAIN, HOST } from "./acceptanceInput";
import {
	controlAt,
	editXml,
	findElement,
	servedReading,
	servedSource,
} from "./servedReading";

const TARGET = { origin: HOST, domain: DOMAIN };

/** One form holding each control whose appearance Nova writes, and two it does not. */
const APPEARANCES = buildDoc({
	appName: "Appearances",
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: [
						f({ kind: "label", id: "note" }),
						f({ kind: "signature", id: "sig" }),
						f({
							kind: "group",
							id: "grp",
							fieldList: true,
							children: [f({ kind: "text", id: "inner" })],
						}),
						f({ kind: "text", id: "phone", keypad: "numbers" }),
						f({ kind: "decimal", id: "weight" }),
						f({ kind: "text", id: "plain" }),
					],
				},
			],
		},
	],
});

/** The reading's draft with `paths` (below the data root) listed as inert appearances. */
function withInert(draft: ReadDraft, paths: readonly string[]): ReadDraft {
	return {
		...draft,
		facts: {
			...draft.facts,
			forms: draft.facts.forms.map((form) => ({
				...form,
				inertAppearances: paths,
			})),
		},
	};
}

/** The signatures of identity agreement between `source` and the reading of `read`. */
async function signatures(
	xml: ((xml: string) => string) | undefined,
	inert: readonly string[] = [],
): Promise<string[]> {
	const read = servedReading(await servedSource(APPEARANCES));
	const source = await servedSource(APPEARANCES, xml);
	return identityDifferences({
		source,
		emission: read.emission,
		draft: withInert(read.outcome.draft, inert),
		attachmentTarget: TARGET,
	}).differences.map((one) => one.signature);
}

/** An edit that sets the appearance of the control at `path`. */
function appearanceAt(path: string, appearance: string) {
	return (xml: string) =>
		editXml(xml, (root) => {
			const control = findElement(root, controlAt(path));
			if (control === undefined) throw new Error(`No control at ${path}.`);
			control.attribs.appearance = appearance;
		});
}

describe("identityDifferences", () => {
	it("finds none between a reading's source and Nova's emission of its document", async () => {
		expect(await signatures(undefined)).toEqual([]);
	});

	it("cuts an appearance the reading lists as inert, and finds one it does not", async () => {
		const edit = appearanceAt("/data/plain", "compact");
		expect(await signatures(edit, ["plain"])).toEqual([]);
		expect(await signatures(edit)).toEqual(["identity/leaf/appearance"]);
	});

	it("never takes one of Nova's four appearances as inert", async () => {
		expect(
			await signatures(undefined, ["note", "sig", "grp", "phone"]),
		).toEqual([
			"identity/appearance/inert-held",
			"identity/appearance/inert-held",
			"identity/appearance/inert-held",
			"identity/appearance/inert-held",
		]);
	});

	it("takes numeric on a decimal input as inert", async () => {
		expect(
			await signatures(appearanceAt("/data/weight", "numeric"), ["weight"]),
		).toEqual([]);
	});

	it("compares a group whose label stands on one side alone, and field-list in another case, as equal", async () => {
		const withoutLabel = (xml: string) =>
			editXml(xml, (root) => {
				const group = findElement(root, controlAt("/data/grp"));
				const label =
					group === undefined
						? undefined
						: findElement(group, (element) => element.name === "label");
				if (label === undefined) throw new Error("The group holds a label.");
				removeElement(label);
			});
		expect(await signatures(withoutLabel)).toEqual([]);
		expect(await signatures(appearanceAt("/data/grp", "Field-List"))).toEqual(
			[],
		);
	});

	it("finds a guard block Nova writes that the source lacks", {
		timeout: 120_000,
	}, async () => {
		const guarded = publishedCorpus().find((document) => {
			const doc = hydrated(document);
			if (publishRefuses(document, doc) || document.lookup !== undefined)
				return false;
			const emitted = expandDoc(doc, publishExpansion(document, doc).options);
			return Object.values(emitted._attachments).some(
				(xml) => typeof xml === "string" && xml.includes("nova_guard_"),
			);
		});
		if (guarded === undefined)
			throw new Error("The published corpus holds a guarded case change.");
		const doc = hydrated(guarded);
		const read = servedReading(await servedSource(doc));
		const source = await servedSource(doc, (xml) =>
			editXml(xml, (root) => {
				const guard = findElement(root, (element) =>
					element.name.startsWith("nova_guard_"),
				);
				if (guard !== undefined) removeElement(guard);
			}),
		);
		expect(
			identityDifferences({
				source,
				emission: read.emission,
				draft: read.outcome.draft,
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature),
		).toContain("identity/case-blocks/save-to-case/added");
	});
});

describe("Nova's four appearances", () => {
	it("are exactly what the emitter writes", {
		timeout: 120_000,
	}, async () => {
		const held = sourceIdentity(
			JSON.parse(
				JSON.stringify(expandDoc(APPEARANCES, { attachmentTarget: TARGET })),
			),
		);
		const form = [...held.forms.values()][0];
		if (form === undefined) throw new Error("The form is read.");
		const heldAt = (path: string) =>
			holdsNovaAppearance(
				form.leaves.get(path) ??
					form.containers.get(path) ??
					(() => {
						throw new Error(`Nothing at ${path}.`);
					})(),
			);
		expect(
			["/data/note", "/data/sig", "/data/grp", "/data/phone"].map(heldAt),
		).toEqual([true, true, true, true]);
		expect(kindAppearanceToken("label")).toBe("minimal");

		for (const document of publishedCorpus()) {
			const doc = hydrated(document);
			if (publishRefuses(document, doc)) continue;
			const identity = sourceIdentity(
				JSON.parse(
					JSON.stringify(
						expandDoc(doc, publishExpansion(document, doc).options),
					),
				),
			);
			for (const one of identity.forms.values())
				for (const record of [
					...one.leaves.values(),
					...one.containers.values(),
				])
					if (record.appearance !== null)
						expect(
							holdsNovaAppearance(record),
							`${document.id} ${record.path} ${record.appearance}`,
						).toBe(true);
		}
	});

	it("are every appearance the emitter writes over the fuzz corpora", {
		timeout: 120_000,
	}, () => {
		const holdsOnlyNovas = (doc: BlueprintDoc): void => {
			rebuildFieldParent(doc);
			const identity = sourceIdentity(
				expandDoc(doc, { assets: manifestFor(doc) }),
			);
			for (const one of identity.forms.values())
				for (const record of [
					...one.leaves.values(),
					...one.containers.values(),
				])
					if (record.appearance !== null)
						expect(
							holdsNovaAppearance(record),
							`${record.path} ${record.appearance}`,
						).toBe(true);
		};
		assertGenerated(fc.property(blueprintDocArbitrary, holdsOnlyNovas), {
			seed: 20261115,
			numRuns: 80,
		});
		assertGenerated(fc.property(suiteDocArbitrary, holdsOnlyNovas), {
			seed: 20261115,
			numRuns: 80,
		});
	});
});
