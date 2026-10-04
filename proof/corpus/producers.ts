/**
 * The native producers' documents, as corpus documents.
 *
 * Each native proof family (`proof/native/families.py`) has a producer
 * (`proof/native/producers/emit-*.ts`) that emits Nova documents from a
 * fixture module; this reads the same fixture modules, in the same scenarios,
 * so the corpus holds exactly the documents the producers emit. Left out:
 * the oracle family's wire corruption corpora
 * (`xformOracleCorpus.ts`, `suiteOracleCorpus.ts`: external wire inputs, not
 * documents), the predicate family (it builds no app), and the lookup
 * family's workbook-only tables. The two nested-menu scenarios HQ refuses
 * are documents Nova's publish refuses, so the emitter leaves them out with
 * the boundary's findings (`./emitCorpus.ts`), as it would any other.
 *
 * `buildDoc` (`lib/__tests__/docHelpers.ts`) mints the identities a fixture
 * leaves out from one counter per process, so a producer document's
 * identities follow from the order the documents are built in: the order
 * here, the same on every run.
 */

import { isTag } from "domhandler";
import { textContent } from "domutils";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { arithmeticFixture } from "@/lib/commcare/__tests__/arithmeticFixture";
import {
	caseCaptureFixture,
	caseCaptureScenarios,
} from "@/lib/commcare/__tests__/caseCaptureFixture";
import {
	caseListEmissionFixture,
	caseListEmissionScenarios,
} from "@/lib/commcare/__tests__/caseListEmissionFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "@/lib/commcare/__tests__/caseOperationFixture";
import {
	compilerNavigationFixture,
	navigationScenarios,
	temporalSearchFixture,
	temporalSearchScenarios,
} from "@/lib/commcare/__tests__/compilerNavigationFixture";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import {
	containerScenarios,
	containerWireFixture,
} from "@/lib/commcare/__tests__/containerWireFixture";
import {
	csqlArgumentFixture,
	csqlFunctionFixture,
	functionLookupContext,
	functionLookupFixtures,
} from "@/lib/commcare/__tests__/csqlFunctionFixture";
import { csqlQuoteFixture } from "@/lib/commcare/__tests__/csqlQuoteFixture";
import { csqlStaticQuoteFixture } from "@/lib/commcare/__tests__/csqlStaticQuoteFixture";
import {
	endpointScenarios,
	endpointWireFixture,
} from "@/lib/commcare/__tests__/endpointWireFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "@/lib/commcare/__tests__/extensionCaseFixture";
import {
	formLinkWireFixture,
	formLinkWireScenarios,
} from "@/lib/commcare/__tests__/formLinkWireFixture";
import {
	localizationScenarios,
	localizationWireFixture,
} from "@/lib/commcare/__tests__/localizationWireFixture";
import { lookupAppFixture } from "@/lib/commcare/__tests__/lookupAppFixtures";
import { mediaWireFixture } from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	nestedMenuScenarios,
	nestedMenuWireFixture,
} from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import {
	noMatchesWireFixture,
	noMatchesWireScenarios,
} from "@/lib/commcare/__tests__/noMatchesWireFixture";
import {
	relationInstanceFixture,
	relationInstanceScenarios,
} from "@/lib/commcare/__tests__/relationInstanceFixture";
import {
	searchEmissionFixture,
	searchEmissionScenarios,
} from "@/lib/commcare/__tests__/searchEmissionFixture";
import {
	promptLookupContext,
	promptLookupFixtures,
	promptScenarios,
	searchPromptFixture,
} from "@/lib/commcare/__tests__/searchPromptFixture";
import { standardCaseReadsFixture } from "@/lib/commcare/__tests__/standardCaseReadsFixture";
import {
	tileFixture,
	tileScenarios,
} from "@/lib/commcare/__tests__/tileFixture";
import { usercaseWriteFixture } from "@/lib/commcare/__tests__/usercaseWriteFixture";
import {
	workerSlugs,
	workerWireFixture,
} from "@/lib/commcare/__tests__/workerWireFixture";
import {
	LOCATION_SCENARIOS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import type { CompiledLookupFixtureSet } from "@/lib/commcare/lookup/fixtures";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupRowValues,
	LookupTableDefinition,
	LookupTableId,
} from "@/lib/lookup/types";
import {
	liveCountEntryDoc,
	sectionEntryDoc,
} from "@/lib/preview/engine/__tests__/fixtures/sectionEntry";
import { operationRelevanceDoc } from "@/lib/preview/engine/__tests__/fixtures/submissionProgram";
import {
	type CorpusDocument,
	storedDocument,
	uploadedMedia,
} from "./documents";

interface Produced {
	readonly family: string;
	readonly scenario: string;
	readonly doc: BlueprintDoc;
	readonly lookup?: LookupFixtureDataSnapshot;
	readonly media?: CorpusDocument["media"];
}

/**
 * The rows of a table as a compiled fixture block carries them, keyed by
 * column id. The two search fixture modules export their Project's
 * definitions and compiled fixtures but not the rows they compiled, so the
 * rows are read back from the block's parsed elements: one row element per
 * row, one child per column, named by the column's wire name. Every column
 * of these tables is text, whose fixture cell is the stored text itself
 * (`lib/commcare/lookup/cellText.ts::lookupFixtureCellText`); an empty cell
 * reads as a missing one. Row identities are not on the wire; each row gets
 * a fixed UUIDv7-shaped id from its table and position.
 */
function rowsFromFixture(
	definition: LookupTableDefinition,
	fixtures: CompiledLookupFixtureSet,
): LookupFixtureRow[] {
	const fixture = fixtures.fixtures.find((f) => f.tableId === definition.id);
	if (fixture === undefined) {
		throw new Error(
			`The fixture module compiled no block for the table ${definition.tag}, so its rows cannot be read.`,
		);
	}
	const byWireName = new Map(
		definition.columns.map((column) => [column.wireName, column]),
	);
	const [list] = fixture.element.children.filter(isTag);
	if (list === undefined) {
		throw new Error(`The ${definition.tag} fixture block holds no row list.`);
	}
	return list.children.filter(isTag).map((row, index) => {
		const values: Record<string, string> = {};
		for (const cell of row.children.filter(isTag)) {
			const column = byWireName.get(cell.name);
			if (column === undefined || column.dataType !== "text") {
				throw new Error(
					`The ${definition.tag} fixture block has a cell ${cell.name} that is not one of the table's text columns, so its stored value cannot be read back.`,
				);
			}
			const text = textContent(cell);
			if (text !== "") values[column.id] = text;
		}
		const tail = definition.id.slice(-8);
		return {
			id: lookupRowIdSchema.parse(
				`018f0000-0000-7000-8000-${tail}${index.toString(16).padStart(4, "0")}`,
			),
			values: values as LookupRowValues,
		};
	});
}

function snapshotFrom(
	context: LookupValidationContext,
	rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>,
): LookupFixtureDataSnapshot {
	if (context.kind !== "available") {
		throw new Error(
			"A lookup-bearing fixture carries its Project's lookup context.",
		);
	}
	return {
		projectId: context.projectId,
		projectRevision: context.projectRevision,
		definitions: context.definitions,
		rowsByTable,
	};
}

function readBackSnapshot(
	context: LookupValidationContext,
	fixtures: CompiledLookupFixtureSet,
): LookupFixtureDataSnapshot {
	if (context.kind !== "available") {
		throw new Error(
			"A lookup-bearing fixture carries its Project's lookup context.",
		);
	}
	return snapshotFrom(
		context,
		new Map(
			context.definitions.map((definition) => [
				definition.id,
				rowsFromFixture(definition, fixtures),
			]),
		),
	);
}

/**
 * The XML family's one admitted document (`emit-xml-evidence.ts`, scenario
 * `unicode`): the producer builds it inline rather than from a fixture
 * module, so it is built here from the same spec.
 */
function xmlUnicodeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Café 雪 😀",
		modules: [
			{
				name: "Surveys",
				forms: [
					{
						name: "Interview",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("é é العربية 汉字 😀 \u007f\u0085\u009f"),
								default_value: xp("'A\tB\nC\rD'"),
							}),
						],
					},
				],
			},
		],
	});
}

/**
 * The XPath family's document (`emit-xpath-evidence.ts`), which its producer
 * also builds inline.
 */
function xpathContextDoc(): BlueprintDoc {
	return buildDoc({
		appName: "XPath proof",
		modules: [
			{
				name: "Checks",
				forms: [
					{
						name: "XPath proof",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText("Answer"),
								default_value: xp("'  alpha\tbeta\r\ngamma  '"),
							}),
							f({
								kind: "hidden",
								id: "normalized",
								calculate: "normalize-space(#form/answer)",
							}),
							f({
								kind: "group",
								id: "group",
								label: proseText("Group"),
								children: [
									f({
										kind: "text",
										id: "value",
										label: proseText("Value"),
										default_value: xp("'nested'"),
									}),
									f({ kind: "text", id: "other", label: proseText("Other") }),
								],
							}),
						],
					},
				],
			},
		],
	});
}

/** Every document the producers emit, in the order they are built. */
function produced(): Produced[] {
	const out: Produced[] = [];
	const add = (
		family: string,
		scenario: string,
		doc: BlueprintDoc,
		extra: Pick<Produced, "lookup" | "media"> = {},
	) => out.push({ family, scenario, doc, ...extra });

	add("arithmetic", "arithmetic", arithmeticFixture().doc);

	add("case", "operation-relevance", operationRelevanceDoc().doc);
	for (const scenario of [...caseCaptureScenarios, "multiple" as const]) {
		add("case", `capture-${scenario}`, caseCaptureFixture(scenario));
	}
	for (const scenario of extensionScenarios) {
		add("case", `extension-${scenario}`, extensionCaseFixture(scenario));
	}
	for (const type of ["survey", "followup"] as const) {
		add("case", `worker-${type}`, usercaseWriteFixture(type));
	}
	for (const scenario of operationScenarios) {
		add("case", `operation-${scenario}`, caseOperationFixture(scenario));
	}

	for (const scenario of caseListEmissionScenarios) {
		const { doc, assets } = caseListEmissionFixture(scenario);
		const media = uploadedMedia(assets);
		add("case-list", scenario, doc, media === undefined ? {} : { media });
	}

	for (const { name, doc } of connectWireFixtures()) {
		add("connect", name, doc);
	}

	for (const scenario of containerScenarios) {
		add("container", scenario, containerWireFixture(scenario));
	}
	add("container", "section-entry", sectionEntryDoc());
	add("container", "live-count-entry", liveCountEntryDoc());
	add("container", "live-count-effects", liveCountEntryDoc(true));

	for (const scenario of endpointScenarios) {
		add("endpoint", scenario, endpointWireFixture(scenario));
	}

	for (const scenario of formLinkWireScenarios) {
		add("form-link", scenario, formLinkWireFixture(scenario));
	}

	const functionLookup = readBackSnapshot(
		functionLookupContext,
		functionLookupFixtures,
	);
	add("function", "nested-lookup", csqlFunctionFixture(), {
		lookup: functionLookup,
	});
	add("function", "function-arguments", csqlArgumentFixture(), {
		lookup: functionLookup,
	});

	for (const scenario of localizationScenarios) {
		add("localization", scenario, localizationWireFixture(scenario));
	}

	for (const scenario of LOCATION_SCENARIOS) {
		add("location", scenario, locationOwnerFixture(scenario));
	}

	for (const reversed of [false, true]) {
		const { doc, table, rows, context } = lookupAppFixture(reversed);
		add("lookup", reversed ? "lookup-reversed" : "lookup-app", doc, {
			lookup: snapshotFrom(context, new Map([[table.id, rows]])),
		});
	}

	for (const mediaOnly of [false, true]) {
		const { doc, assets } = mediaWireFixture(mediaOnly);
		const media = uploadedMedia(assets);
		add(
			"media",
			mediaOnly ? "media-only" : "media-rich",
			doc,
			media === undefined ? {} : { media },
		);
	}

	for (const scenario of navigationScenarios) {
		add("navigation", scenario, compilerNavigationFixture(scenario));
	}
	for (const scenario of temporalSearchScenarios) {
		add("navigation", `search-${scenario}`, temporalSearchFixture(scenario));
	}

	for (const scenario of nestedMenuScenarios) {
		add("nested-menu", scenario, nestedMenuWireFixture(scenario));
	}

	for (const scenario of noMatchesWireScenarios) {
		add("no-matches", scenario, noMatchesWireFixture(scenario));
	}

	const promptLookup = readBackSnapshot(
		promptLookupContext,
		promptLookupFixtures,
	);
	for (const scenario of promptScenarios) {
		add("prompt", scenario, searchPromptFixture(scenario), {
			lookup: promptLookup,
		});
	}

	add("quote", "runtime-quotes", csqlQuoteFixture());

	for (const scenario of relationInstanceScenarios) {
		add("relation-instance", scenario, relationInstanceFixture(scenario));
	}

	for (const scenario of searchEmissionScenarios) {
		add("search", scenario, searchEmissionFixture(scenario));
	}

	add("standard-case-reads", "standard-case-reads", standardCaseReadsFixture());

	add("static-quote", "static-quotes", csqlStaticQuoteFixture("safe"));

	for (const scenario of tileScenarios) {
		add("tile", scenario, tileFixture(scenario));
	}

	for (const slug of workerSlugs) {
		add("worker", slug, workerWireFixture(slug).doc);
	}

	add("xml", "unicode", xmlUnicodeDoc());
	add("xpath", "xpath-context", xpathContextDoc());
	return out;
}

/** The corpus id of a producer document: its family and scenario. */
export function producerDocumentId(family: string, scenario: string): string {
	return scenario === family || scenario.startsWith(`${family}-`)
		? scenario
		: `${family}-${scenario}`;
}

/** The producers' documents as corpus documents, in a fixed order. */
export function producerDocuments(): CorpusDocument[] {
	const seen = new Set<string>();
	return produced().map(({ family, scenario, doc, lookup, media }) => {
		const id = producerDocumentId(family, scenario);
		if (seen.has(id)) {
			throw new Error(
				`Two producer documents share the corpus id ${id}; give each scenario its own name.`,
			);
		}
		seen.add(id);
		return {
			id,
			source: { kind: "producer", family, scenario },
			doc: storedDocument(doc),
			...(lookup !== undefined && { lookup }),
			...(media !== undefined && { media }),
		};
	});
}
