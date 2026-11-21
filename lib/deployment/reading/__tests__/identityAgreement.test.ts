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
 * alone, and `field-list` written in another letter case, compare equal, and
 * so does an answer the source stores beside `boolean_true`; a
 * guard block Nova writes that the source lacks is
 * `identity/case-blocks/save-to-case/added`; a reading of each published
 * document's export that holds case scaffolding compares equal, while a
 * question the reading names case region is `identity/region/control` and a
 * Hidden Value it names so is `identity/region/phantom`; a question the
 * reading names a generated node is `identity/generated/control`, while a
 * protected message's carrier, the one generated node Nova gives a control,
 * compares equal; an advanced open
 * action's block moved to another repeat is
 * `identity/case-blocks/advanced/path`; a write saved only if changed on one
 * side alone is `identity/case-blocks/basic-own/editOnly` unless the project
 * space does not apply it; and the four conditions name
 * exactly the appearances Nova's emitter writes, over every document the
 * proof lane publishes, both fuzz corpora and a document built for each
 * condition.
 *
 * Plausible failures: a correct reading of an inert appearance or a blank
 * group label failed as Nova's mistake; a number keypad, a signature or a
 * question list dropped on the reader's word; a guard added or dropped
 * passing unseen; a question dropped as case scaffolding on the reader's
 * word; a question dropped as a generated node on the reader's word; a
 * child case written in the rows of another repeat; a write saved only if
 * changed on one side alone passing in a project space that applies it, or
 * failing in one that saves every write every time.
 */

import { removeElement } from "domutils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	assertGenerated,
	manifestFor,
} from "@/lib/commcare/__tests__/compilerEvidence";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { expandDoc } from "@/lib/commcare/expander";
import { sourceIdentity } from "@/lib/commcare/hq/sourceIdentity";
import { type ReadDraft, readHqApp } from "@/lib/commcare/reader";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { kindAppearanceToken } from "@/lib/commcare/xform/appearance";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { readingEmission } from "../emission";
import {
	holdsNovaAppearance,
	identityDifferences,
	sourceApplication,
} from "../identityAgreement";
import { DOMAIN, HOST, readingInput } from "./acceptanceInput";
import {
	controlAt,
	editXml,
	findElement,
	servedReading,
	servedSource,
	unsummarized,
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

	it("finds none over a reading of each published document's export that holds case scaffolding or a protected message's carrier", {
		timeout: 300_000,
	}, async () => {
		let read = 0;
		let carriers = 0;
		for (const document of publishedCorpus()) {
			const doc = hydrated(document);
			if (publishRefuses(document, doc) || document.lookup !== undefined)
				continue;
			const emitted = expandDoc(doc, publishExpansion(document, doc).options);
			const scaffolded = Object.values(emitted._attachments).some(
				(xml) =>
					typeof xml === "string" &&
					(xml.includes("nova_operations") ||
						xml.includes('vellum:role="SaveToCase"') ||
						xml.includes("nova_constraint_message_")),
			);
			if (!scaffolded) continue;
			// A first reading of the export: a document whose first reading is an
			// account (one that needs what only a re-read is told) is no case.
			const source = await servedSource(doc);
			const reader = readingInput(source, unsummarized(source));
			const outcome = readHqApp(reader);
			if (outcome.kind !== "read") continue;
			const emission = readingEmission({
				doc: outcome.draft.doc,
				source,
				draft: outcome.draft,
				reader,
				lookupDefinitions: [],
				files: [],
			});
			expect(
				identityDifferences({
					source,
					emission,
					draft: outcome.draft,
					attachmentTarget: TARGET,
				}).differences.map((one) => `${one.signature} ${one.detail}`),
				document.id,
			).toEqual([]);
			read++;
			carriers += outcome.draft.facts.forms
				.flatMap((form) => form.generated)
				.filter((node) => node.purpose === "constraint-message").length;
		}
		expect(read).toBeGreaterThan(0);
		expect(carriers).toBeGreaterThan(0);
	});

	it("never cuts a node the reading names case region and the emission writes as no scaffolding", async () => {
		const read = servedReading(await servedSource(APPEARANCES));
		const extra = (control: boolean) => (xml: string) =>
			xml
				.replace("<plain/>", "<plain/><extra/>")
				.replace(
					"</model>",
					`<bind nodeset="/data/extra" type="xsd:string"${control ? "" : ' calculate="&apos;x&apos;"'}/></model>`,
				)
				.replace(
					"</h:body>",
					control
						? '<input ref="/data/extra"><label>Extra</label></input></h:body>'
						: "</h:body>",
				);
		const differences = async (
			control: boolean,
			region: readonly string[],
		): Promise<string[]> => {
			const source = await servedSource(APPEARANCES, extra(control));
			const draft: ReadDraft = {
				...read.outcome.draft,
				facts: {
					...read.outcome.draft.facts,
					forms: read.outcome.draft.facts.forms.map((form) => ({
						...form,
						caseRegionPaths: region,
					})),
				},
			};
			return identityDifferences({
				source,
				emission: read.emission,
				draft,
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature);
		};
		expect(await differences(true, [])).toContain("identity/leaf/missing");
		expect(await differences(true, ["/data/extra"])).toEqual([
			"identity/region/control",
		]);
		expect(await differences(false, [])).toContain("identity/leaf/missing");
		expect(await differences(false, ["/data/extra"])).toEqual([
			"identity/region/phantom",
		]);
	});

	it("never cuts a question the reading names a generated node", async () => {
		const read = servedReading(await servedSource(APPEARANCES));
		const source = await servedSource(APPEARANCES, (xml) =>
			xml
				.replace("<plain/>", "<plain/><extra/>")
				.replace(
					"</model>",
					'<bind nodeset="/data/extra" type="xsd:string"/></model>',
				)
				.replace(
					"</h:body>",
					'<input ref="/data/extra"><label>Extra</label></input></h:body>',
				),
		);
		const differences = (named: boolean): string[] =>
			identityDifferences({
				source,
				emission: read.emission,
				draft: {
					...read.outcome.draft,
					facts: {
						...read.outcome.draft.facts,
						forms: read.outcome.draft.facts.forms.map((form) => ({
							...form,
							generated: named
								? [
										...form.generated,
										{
											purpose: "trimmed",
											owner: "/data/plain",
											path: "/data/extra",
											name: "extra",
										},
									]
								: form.generated,
						})),
					},
				},
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature);
		expect(differences(false)).toEqual([
			"identity/leaf/missing",
			"identity/order",
		]);
		expect(differences(true)).toEqual(["identity/generated/control"]);
	});

	it("cuts a protected message's carrier, the one generated node with a control", async () => {
		const doc = buildDoc({
			appName: "Carrier",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "int",
									id: "count",
									label: proseText("Count"),
									validate: ". > 0",
									// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
									validate_msg: proseText("Over ${1}"),
								}),
							],
						},
					],
				},
			],
		});
		const read = servedReading(await servedSource(doc));
		const carriers = read.outcome.draft.facts.forms.flatMap((form) =>
			form.generated.filter((node) => node.purpose === "constraint-message"),
		);
		expect(carriers.map((node) => node.owner)).toEqual(["/data/count"]);
		const source = read.reader.source;
		const leaves = [
			...sourceIdentity(sourceApplication(source)).forms.values(),
		].flatMap((form) =>
			carriers.flatMap((node) => form.leaves.get(node.path)?.control ?? []),
		);
		expect(leaves).toEqual(["input"]);
		expect(
			identityDifferences({
				source,
				emission: read.emission,
				draft: read.outcome.draft,
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature),
		).toEqual([]);
	});

	it("finds an advanced open action's block moved to another repeat", {
		timeout: 120_000,
	}, async () => {
		type Open = { repeat_context?: string; case_indices?: unknown[] };
		const opensIn = (emitted: ReturnType<typeof expandDoc>): Open[] =>
			emitted.modules.flatMap((menu) =>
				menu.forms.flatMap((form) => {
					const actions = (form as { actions?: { open_cases?: Open[] } })
						.actions;
					return (actions?.open_cases ?? []).filter(
						(open) =>
							typeof open.repeat_context === "string" &&
							open.repeat_context !== "",
					);
				}),
			);
		const repeated = publishedCorpus().find((document) => {
			const doc = hydrated(document);
			if (publishRefuses(document, doc) || document.lookup !== undefined)
				return false;
			return (
				opensIn(expandDoc(doc, publishExpansion(document, doc).options))
					.length > 0
			);
		});
		if (repeated === undefined)
			throw new Error(
				"The published corpus holds an advanced open action in a repeat.",
			);
		const doc = hydrated(repeated);
		const read = servedReading(await servedSource(doc));
		const signaturesOf = (emission: typeof read.emission) =>
			identityDifferences({
				source: read.reader.source,
				emission,
				draft: read.outcome.draft,
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature);
		expect(signaturesOf(read.emission)).toEqual([]);
		const moved = JSON.parse(
			JSON.stringify(read.emission),
		) as typeof read.emission;
		const [open] = opensIn(moved);
		if (open === undefined) throw new Error("The emission opens in a repeat.");
		open.repeat_context = "/data/elsewhere";
		expect(signaturesOf(moved)).toContain("identity/case-blocks/advanced/path");
	});

	it("compares writes saved only if changed only where the project space applies them", async () => {
		// HQ's build writes a write stored `edit` as saved every time where the project space
		// does not apply "save only if changed" (`xform.py::XForm.save_only_if_edited`).
		const doc = buildDoc({
			appName: "Visits",
			caseTypes: [
				{ name: "patient", properties: [{ name: "note", label: "Note" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									caseWrite: { caseType: "patient", property: "note" },
								}),
							],
						},
					],
				},
			],
		});
		const read = servedReading(await servedSource(doc));
		const edited = JSON.parse(
			JSON.stringify(read.emission),
		) as typeof read.emission;
		const visit = edited.modules[0]?.forms[0] as unknown as
			| {
					actions: {
						update_case: { update: Record<string, { update_mode?: string }> };
					};
			  }
			| undefined;
		const note = visit?.actions.update_case.update.note;
		if (note === undefined) throw new Error("The emission writes the note.");
		note.update_mode = "edit";
		const signaturesUnder = (saveOnlyEditedApplied?: boolean) =>
			identityDifferences({
				source: read.reader.source,
				emission: edited,
				draft: read.outcome.draft,
				attachmentTarget: TARGET,
				...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
			}).differences.map((one) => one.signature);
		expect(signaturesUnder(false)).toEqual([]);
		expect(signaturesUnder(true)).toContain(
			"identity/case-blocks/basic-own/editOnly",
		);
		expect(signaturesUnder()).toContain(
			"identity/case-blocks/basic-own/editOnly",
		);
	});

	it("reads an answer stored beside `boolean_true` as none, as HQ's build does", async () => {
		// HQ's own starter apps store `answer: "1"` beside `boolean_true`, which
		// `xform.py::XForm.action_relevance` never reads, and Nova writes none.
		const flag = testUuid("close-flag");
		const doc = buildDoc({
			appName: "Closing",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Close",
							type: "close",
							closeCondition: {
								kind: "term",
								term: { kind: "field", uuid: flag },
							},
							fields: [
								f({
									kind: "hidden",
									id: "flag",
									uuid: flag,
									calculate: {
										kind: "term",
										term: { kind: "literal", value: "x" },
									},
								}),
							],
						},
					],
				},
			],
		});
		const source = await sourceFromBody(
			exportedBody(doc, {
				expand: { attachmentTarget: TARGET },
				modules: (modules) => {
					const close = (
						modules[0] as {
							forms: { actions: { close_case: { condition: unknown } } }[];
						}
					).forms[0]?.actions.close_case;
					if (close === undefined) throw new Error("The form closes its case.");
					expect(close.condition).toMatchObject({
						operator: "boolean_true",
						answer: null,
					});
					close.condition = { ...(close.condition as object), answer: "1" };
					return modules;
				},
			}),
		);
		const read = servedReading(source);
		// The first publish writes no answer there, and says so.
		expect(read.outcome.draft.facts.sameStateRewrites).toContainEqual(
			expect.objectContaining({
				register: "case-settings-respelled",
				path: "/modules/0/forms/0/actions/close_case/condition/answer",
			}),
		);
		expect(
			identityDifferences({
				source,
				emission: read.emission,
				draft: read.outcome.draft,
				attachmentTarget: TARGET,
			}).differences.map((one) => one.signature),
		).toEqual([]);
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
