/**
 * Agreement with CommCare HQ's own question summary.
 *
 * Contract: over CommCare HQ's retained summary of `navigation-base` and the
 * reading of its retained source, `summaryDifferences` finds nothing, the
 * registration form holding Nova's conjoined case-name check alone as its
 * source's validation; a label HQ summarized that the document words
 * otherwise is `summary/question/label`, and a label written inline, which
 * HQ does not summarize, is skipped; a registration's name question with no
 * validation and no required stamp in the source agrees, and a document
 * holding a validation the source lacks is `summary/question/constraint`; a
 * control HQ places in another group or repeat is `summary/question/group`
 * or `/repeat`; a menu HQ could not summarize fails neither the rows nor the
 * ids; a row of HQ's at or under a generated node, or holding an attribute
 * step, is explained and any other row the document lacks is
 * `summary/row/unread/<HQ's type>`. The text rule: a language HQ sends no
 * text in agrees where the document's text there is the first sent
 * language's; whitespace is no difference; a literal output Nova writes (a
 * no-break space, an instance bracket) agrees with HQ's `____` and with the
 * plain text a source made in CommCare HQ holds, so a label holding either
 * as text agrees, and a reference agrees only with `____`. `documentSummary` gives a query
 * repeat in the count placement a row at its wrapper and a row at its row
 * path, which the emitter writes as a group and a repeat.
 *
 * Plausible failures: a path rule of the summary's own drifting from the
 * emitter's; a correct reading failed for text or a validation CommCare HQ
 * never reported; a control placed by its data node where the reader's
 * refusal was missed.
 */

import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import { sourceIdentity } from "@/lib/commcare/hq/sourceIdentity";
import type { ReadDraft } from "@/lib/commcare/reader";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import type { Field, Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { readingEmission } from "../emission";
import { identityDifferences } from "../identityAgreement";
import {
	documentSummary,
	normalizedText,
	rendersAs,
	type SummaryText,
	summaryDifferences,
	summaryTextAgrees,
} from "../summaryAgreement";
import { navigationBaseRead, readClean, readingInput } from "./acceptanceInput";
import { controlAt, editXml, findElement } from "./servedReading";

type Body = Record<string, unknown>;

/** Each form's XML of a source body, through `edit`. */
function eachForm(edit: (xml: string) => string) {
	return (body: Body): Body => ({
		...body,
		_attachments: Object.fromEntries(
			Object.entries(body._attachments as Record<string, string>).map(
				([name, xml]) => [name, edit(xml)],
			),
		),
	});
}

/** Every summarized question of HQ's application body, through `edit`. */
function eachQuestion(edit: (question: Body) => Body) {
	return (body: Body): Body => ({
		...body,
		modules: (body.modules as Body[]).map((module) => ({
			...module,
			forms: ((module.forms as Body[] | undefined) ?? []).map((form) => ({
				...form,
				questions: (form.questions as Body[]).map(edit),
			})),
		})),
	});
}

/** HQ's summary with the answer question's label `text` in English. */
function answerSummaryHolds(text: string) {
	return eachQuestion((question) =>
		question.value === "/data/answer"
			? { ...question, label: text, translations: { en: text } }
			: question,
	);
}

/** `navigation-base` with the answer question's label `text` in its source and HQ's summary. */
function answerLabelHolds(text: string) {
	return {
		body: eachForm((xml) =>
			editXml(xml, (root) => {
				const label = findElement(
					root,
					(element) =>
						element.name === "text" && element.attribs.id === "answer-label",
				);
				if (label === undefined) return;
				for (const value of label.children)
					if ((value as { name?: string }).name === "value")
						(value as { children: unknown[] }).children = [
							{ type: "text", data: text },
						];
			}),
		),
		summary: answerSummaryHolds(text),
	};
}

/** The summary differences of `navigation-base`'s read as doctored, the draft through `draft`. */
async function signatures(
	options: Parameters<typeof navigationBaseRead>[0] & {
		readonly draft?: (draft: ReadDraft) => ReadDraft;
		readonly modules?: (
			modules: readonly HqAlignedModule[],
		) => readonly HqAlignedModule[];
	} = {},
): Promise<string[]> {
	const { source, modules } = await navigationBaseRead(options);
	const reader = readingInput(source, modules);
	const outcome = readClean(reader);
	const draft = options.draft?.(outcome.draft) ?? outcome.draft;
	const identity = identityDifferences({
		source,
		emission: readingEmission({
			doc: outcome.draft.doc,
			source,
			draft: outcome.draft,
			reader,
			lookupDefinitions: [],
			files: [],
		}),
		draft: outcome.draft,
		attachmentTarget: reader.target,
	});
	return summaryDifferences({
		source,
		modules: options.modules?.(modules) ?? modules,
		draft,
		sourceIdentity: identity.sourceIdentity,
	}).map((one) => one.signature);
}

describe("summaryDifferences over CommCare HQ's retained summary", () => {
	it("checks the translated question at HQ's named submitted path", async () => {
		const withNamedForm = eachForm((xml) =>
			xml.includes('id="answer-label"')
				? xml
						.replace("<data ", "<visit ")
						.replace("</data>", "</visit>")
						.replaceAll('"/data/answer"', '"/visit/answer"')
				: xml,
		);
		const body = (source: Body) => {
			const updated = withNamedForm(structuredClone(source));
			const [menu] = updated.modules as {
				forms: {
					actions: {
						update_case: { update: { notes: { question_path: string } } };
					};
				}[];
			}[];
			// HQ also stores this answer's address in its active case update.
			menu.forms[0].actions.update_case.update.notes.question_path =
				"/visit/answer";
			return updated;
		};
		const summary = (other: boolean) =>
			eachQuestion((q) =>
				q.value === "/data/answer"
					? {
							...q,
							value: "/visit/answer",
							...(other && {
								translations: { en: "Wrong question" },
								label: "Wrong question",
							}),
						}
					: q,
			);
		expect(await signatures({ body, summary: summary(false) })).toEqual([]);
		expect(await signatures({ body, summary: summary(true) })).toEqual([
			"summary/question/label",
		]);
	});

	it("finds nothing for the reading of navigation-base", async () => {
		expect(await signatures()).toEqual([]);
	});

	it("finds a label HQ summarized otherwise, and skips one written inline", async () => {
		const noText = eachQuestion((question) =>
			question.value === "/data/answer"
				? { ...question, translations: {} }
				: question,
		);
		expect(await signatures({ summary: noText })).toEqual([
			"summary/question/label",
		]);
		const inline = eachForm((xml) =>
			editXml(xml, (root) => {
				const input = findElement(root, controlAt("/data/answer"));
				const label =
					input === undefined
						? undefined
						: findElement(input, (element) => element.name === "label");
				if (label === undefined) return;
				delete label.attribs.ref;
				label.children = [];
				label.children.push({
					type: "text",
					data: "Notes",
				} as never);
			}),
		);
		expect(await signatures({ summary: noText, body: inline })).toEqual([]);
	});

	it("agrees on a label CommCare HQ holds with a no-break space or an instance bracket as plain text", async () => {
		// HQ's bulk translation upload writes a cell's text into the form as it
		// is; Nova writes both as literal outputs, which HQ would render `____`.
		for (const text of ["Quel âge ?", "See instance('x')"]) {
			const options = answerLabelHolds(text);
			expect(await signatures(options), text).toEqual([]);
			expect(
				await signatures({
					...options,
					summary: answerSummaryHolds(`${text}!`),
				}),
				text,
			).toEqual(["summary/question/label"]);
		}
	});

	it("agrees on a name question with no validation, and finds a validation the source lacks", async () => {
		const plain = eachForm((xml) =>
			editXml(xml, (root) => {
				const bind = findElement(
					root,
					(element) =>
						element.name === "bind" && element.attribs.nodeset === "/data/name",
				);
				if (bind === undefined) return;
				delete bind.attribs.constraint;
				delete bind.attribs.required;
			}),
		);
		const summary = eachQuestion((question) =>
			question.value === "/data/name"
				? { ...question, constraint: null, required: false }
				: question,
		);
		expect(await signatures({ body: plain, summary })).toEqual([]);

		const validated = (draft: ReadDraft): ReadDraft => {
			const [uuid, field] =
				Object.entries(draft.doc.fields).find(
					([, one]) => one.id === "answer",
				) ?? [];
			if (uuid === undefined || field === undefined)
				throw new Error("The reading holds the answer question.");
			return {
				...draft,
				doc: {
					...draft.doc,
					fields: {
						...draft.doc.fields,
						[uuid]: { ...field, validate: { kind: "match-all" } } as Field,
					},
				},
			};
		};
		expect(await signatures({ draft: validated })).toEqual([
			"summary/question/constraint",
		]);
	});

	it("finds a control HQ places in another group or repeat", async () => {
		const elsewhere = (key: "group" | "repeat") =>
			eachQuestion((question) =>
				question.value === "/data/answer"
					? { ...question, [key]: "/data/elsewhere" }
					: question,
			);
		expect(await signatures({ summary: elsewhere("group") })).toEqual([
			"summary/question/group",
		]);
		expect(await signatures({ summary: elsewhere("repeat") })).toEqual([
			"summary/question/repeat",
		]);
	});

	it("skips a menu HQ could not summarize, in its rows and its ids", async () => {
		const wrong = eachQuestion((question) => ({
			...question,
			translations: { en: "Something else" },
		}));
		expect(
			await signatures({
				summary: wrong,
				modules: (modules) =>
					modules.map((module) => ({
						kind: "not-summarized",
						uniqueId: module.uniqueId,
						docType: module.docType,
						shape: { opens: "other", length: 0 },
					})),
			}),
		).toEqual([]);
		expect(await signatures({ summary: wrong })).not.toEqual([]);
	});

	it("explains a row at a generated node or an attribute step, and no other", async () => {
		// A row as HQ gives a node with no control: a copy of the generated
		// trimmed name's row at another path.
		const extra =
			(path: string) =>
			(body: Body): Body => ({
				...body,
				modules: (body.modules as Body[]).map((module) => ({
					...module,
					forms: (module.forms as Body[]).map((form) => {
						const questions = form.questions as Body[];
						const template = questions.find(
							(question) => question.value === "/data/nova_trimmed_name",
						);
						return template === undefined
							? form
							: {
									...form,
									questions: [...questions, { ...template, value: path }],
								};
					}),
				})),
			});
		expect(
			await signatures({ summary: extra("/data/nova_trimmed_name/inner") }),
		).toEqual([]);
		expect(await signatures({ summary: extra("/data/case/@case_id") })).toEqual(
			[],
		);
		expect(await signatures({ summary: extra("/data/stray") })).toEqual([
			"summary/row/unread/DataBindOnly",
		]);
	});
});

describe("the text rule", () => {
	/** A document's text with no literal output. */
	const plain = (text: string): SummaryText => [{ kind: "text", text }];

	it("reads a language HQ sends no text in as the first sent language's text", () => {
		const languages = ["en", "fra"];
		expect(
			summaryTextAgrees(
				languages,
				{ en: "Name" },
				{ en: plain("Name"), fra: plain("Name") },
			),
		).toBe(true);
		expect(
			summaryTextAgrees(
				languages,
				{ en: "Name" },
				{ en: plain("Name"), fra: plain("Nom") },
			),
		).toBe(false);
		expect(
			summaryTextAgrees(
				languages,
				{ fra: "Nom" },
				{ en: plain("Nom"), fra: plain("Nom") },
			),
		).toBe(true);
		expect(summaryTextAgrees(languages, {}, {})).toBe(true);
		expect(summaryTextAgrees(languages, {}, { en: plain("Name") })).toBe(false);
	});

	it("takes no whitespace as a difference", () => {
		expect(normalizedText(" ____ \t____  ")).toBe("________");
		expect(normalizedText("A  name")).toBe("Aname");
	});

	it("reads a literal output Nova writes as an output or as the text it spells, and a value only as a hole", () => {
		// "No\u00a0tes (" then a reference: the no-break space and the bracket
		// are literal outputs, the reference a hole.
		const held: SummaryText = [
			{ kind: "text", text: "No" },
			{ kind: "literal", text: "" },
			{ kind: "text", text: "tesinstance" },
			{ kind: "literal", text: "(" },
			{ kind: "text", text: "____" },
		];
		for (const hq of [
			"Notesinstance(____",
			"No____tesinstance(____",
			"Notesinstance________",
			"No____tesinstance________",
		])
			expect(rendersAs(held, hq), hq).toBe(true);
		expect(rendersAs(held, "Notesinstance(")).toBe(false);
		expect(rendersAs(held, "Notesinstance(x")).toBe(false);
		expect(rendersAs([{ kind: "literal", text: "" }], "")).toBe(true);
		expect(rendersAs([{ kind: "literal", text: "" }], "____")).toBe(true);
	});
});

describe("documentSummary", () => {
	it("gives a query repeat in the count placement a row at its wrapper and one at its row path", {
		timeout: 120_000,
	}, () => {
		let found = 0;
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
			for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
				const structure = formStructure(doc, formUuid);
				const counted = Object.values(doc.fields).filter(
					(field) =>
						field.kind === "repeat" &&
						field.repeat_mode === "query_bound" &&
						structure?.fields.has(field.uuid) === true &&
						effectiveQueryRepeatPlacement(structure, field.uuid) === "count",
				);
				if (counted.length === 0) continue;
				const rows = documentSummary(doc, formUuid);
				for (const repeat of counted) {
					const own = rows.filter((row) => row.fieldUuid === repeat.uuid);
					expect(own).toHaveLength(2);
					const [wrapper, item] = own;
					expect(item?.path).toBe(`${wrapper?.path}/item`);
					expect(item?.group).toBe(wrapper?.path);
					const containers = [...identity.forms.values()].flatMap((one) => [
						...one.containers.values(),
					]);
					expect(
						containers.find((one) => one.path === wrapper?.path)?.kind,
					).toBe("group");
					expect(containers.find((one) => one.path === item?.path)?.kind).toBe(
						"repeat",
					);
					found++;
				}
			}
		}
		expect(found).toBeGreaterThan(0);
	});
});
