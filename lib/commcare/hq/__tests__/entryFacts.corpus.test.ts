/**
 * The entry facts are complete for every shape Nova emits.
 *
 * `entryFacts.ts` claims that two apps whose facts are equal get the same
 * session values from CommCare HQ's entry builder. That holds only while
 * every id HQ gives a form follows from the facts. So for every form of every
 * admitted corpus document `D`, the port of HQ's id rules over
 * `hqEntryFacts(expandDoc(D))` alone, `datumIdsFromFacts`, must give the ids
 * Nova's own entry projection gives the form
 * (`formLinkProjection.ts::entrySessionDatums`, which the proof lane holds to
 * HQ's build over the same corpus), in order. The plausible failure is an id
 * that depends on something the fact list lacks (a child case's place in its
 * list, a grouped tile, a parent menu's search), so that two apps with equal
 * facts would get different session values.
 *
 * The corpus is the one the proof lane emits, less its expander capture,
 * which only the expander test's writer produces: the native producers'
 * documents, the workforce documents over them, the targeted documents and
 * the fixed-seed fuzz sample, each admitted, and none of the documents the
 * corpus leaves out (`proof/corpus/left-out.json`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import {
	entrySessionDatums,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { derivedFormXmlns } from "@/lib/commcare/wireIdentity";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import {
	DEFAULT_CORPUS_SEED,
	DEFAULT_SAMPLE_SIZE,
} from "../../../../proof/corpus/defaults";
import type { CorpusDocument } from "../../../../proof/corpus/documents";
import { sampleFuzzDocuments } from "../../../../proof/corpus/fuzzSample";
import { producerDocuments } from "../../../../proof/corpus/producers";
import { workforceDocuments } from "../../../../proof/corpus/workforce";
import { targetedUuid } from "../../../../proof/targeted/build";
import { targetedDocuments } from "../../../../proof/targeted/index";
import { datumIdsFromFacts, hqEntryFacts } from "../entryFacts";
import { publishedCaseBlocks } from "../publishedCaseBlocks";

/** The documents the corpus leaves out, by id. */
function leftOut(): ReadonlySet<string> {
	const file = JSON.parse(
		readFileSync(
			new URL("../../../../proof/corpus/left-out.json", import.meta.url),
			"utf8",
		),
	) as { documents: { id: string }[] };
	return new Set(file.documents.map((document) => document.id));
}

function corpus(): CorpusDocument[] {
	const producers = producerDocuments();
	const excluded = leftOut();
	return [
		...producers,
		...workforceDocuments(producers),
		...targetedDocuments(),
		...sampleFuzzDocuments({
			size: DEFAULT_SAMPLE_SIZE,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		}).map(({ document }) => document),
	].filter((document) => !excluded.has(document.id));
}

/**
 * The forms whose ids Nova's entry projection and HQ's id rules give
 * differently, each a registration in a submenu whose parent menu's first
 * form chooses a case of the registration's type. HQ's
 * `entries.py::EntriesHelper.add_parent_datums` aligns the submenu's first
 * datum with the parent's selection whether or not a worker selects it
 * (`_same_case` compares case type and datum kind alone), so the new case's
 * `case_id_new_<type>_0` is renamed `case_id`; HQ's case block still reads
 * `case_id_new_<type>_0` (`xform.py::get_add_case_preloads_case_id_xpath`),
 * so HQ's build of the shape opens a case with no id. Nova's projection
 * aligns selections alone and keeps the new case's id. The list is held both
 * ways: a form that comes to agree fails here as surely as a new
 * disagreement does.
 */
const ROOT_ALIGNED_REGISTRATIONS = [
	{
		document: "targeted-forms-in-menu-above-nested",
		form: "register-member",
		caseType: "member",
	},
	{
		document: "targeted-register-from-case-list",
		form: "intake-register",
		caseType: "patient",
	},
].map(({ document, form, caseType }) => ({
	form: `${document}: ${derivedFormXmlns(targetedUuid(document, form))}`,
	ported: ["case_id"],
	projected: [`case_id_new_${caseType}_0`],
}));

/** What the corpus shows of the shapes the facts must carry, counted. */
interface Census {
	forms: number;
	advanced: number;
	childMenu: number;
	parentSelection: number;
	newChildCase: number;
	inlineSearch: number;
	groupedTiles: number;
	workerRecord: number;
}

describe("the entry facts over the corpus", () => {
	it("give every form of every admitted document the session value ids Nova's entry projection gives it", {
		// About 180 documents, each emitted once: a few seconds on a laptop,
		// and CI runners are slower.
		timeout: 120_000,
	}, () => {
		const census: Census = {
			forms: 0,
			advanced: 0,
			childMenu: 0,
			parentSelection: 0,
			newChildCase: 0,
			inlineSearch: 0,
			groupedTiles: 0,
			workerRecord: 0,
		};
		const disagreements: {
			form: string;
			ported: readonly string[];
			projected: readonly string[];
		}[] = [];
		for (const document of corpus()) {
			const doc = hydratePersistedBlueprint(
				blueprintDocSchema.parse(document.doc),
			);
			const naming =
				document.lookup === undefined
					? {}
					: { lookupNaming: lookupWireNaming(document.lookup.definitions) };
			const hq = expandDoc(doc, naming);
			expect(publishedCaseBlocks(hq).unread, document.id).toEqual([]);
			const facts = hqEntryFacts(hq);
			const plan = emissionPlan(doc);
			// The context `expandDoc` builds for the same document.
			const context = formLinkProjectionContext(plan.doc, {
				expressionDoc: doc,
				...naming,
			});
			for (const moduleUuid of context.moduleOrder) {
				for (const formUuid of context.formOrder[moduleUuid] ?? []) {
					const xmlns = derivedFormXmlns(formUuid);
					const form = facts.forms.get(xmlns);
					expect(form, `${document.id}: ${xmlns}`).toBeDefined();
					if (form === undefined) continue;
					const ported = datumIdsFromFacts(form, facts);
					const projected = entrySessionDatums(
						plan.doc,
						context,
						moduleUuid,
						formUuid,
					).map((datum) => datum.id);
					if (JSON.stringify(ported) !== JSON.stringify(projected))
						disagreements.push({
							form: `${document.id}: ${xmlns}`,
							ported,
							projected,
						});
					census.forms++;
					if (form.requires === "advanced") census.advanced++;
					if (form.rootModule !== null) census.childMenu++;
					if (form.parentSelect !== null) census.parentSelection++;
					if (form.newChildCases.length > 0) census.newChildCase++;
					if (form.inlineSearch) census.inlineSearch++;
					if (form.groupedTiles) census.groupedTiles++;
					if (form.usesWorkerRecord) census.workerRecord++;
				}
			}
		}
		expect(disagreements).toEqual(ROOT_ALIGNED_REGISTRATIONS);
		// Every shape whose ids the port derives is in the corpus, so none of
		// its rules passes for want of a case.
		for (const [shape, count] of Object.entries(census))
			expect(count, shape).toBeGreaterThan(0);
	});
});
