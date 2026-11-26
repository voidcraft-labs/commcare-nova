/**
 * Every document the proof lane publishes reads back to its own case changes.
 *
 * Contract: each targeted proof document and each producer document of the
 * corpus that reads with no finding (`targetedReadBack.test.ts` holds that
 * every one does) reads to the canonical document's case changes: the case
 * catalog whole, and each form's type, open and close conditions, its own
 * close's place and its case operations with their identities, ids, order and
 * placements, each expression slot marked where it stands (the expression
 * yardsticks judge the trees).
 *
 * Each reading is also a document the commit gate admits under the platform
 * declaration the document holds (`mutationCommitVerdict` with that choice's
 * mutations, as acceptance applies the one a person takes, under the
 * document's own lookup data): the reader refuses, where it reads a key, every write the gate's
 * case operation rules refuse, so a reading never holds a document no editor
 * could have saved.
 *
 * The plausible failure: a reading that returns another catalog (a property
 * on another type, a type the document does not declare, another order) or
 * another order or id of a form's operations with no finding, which a test
 * that asks only for no finding, and for fields and expressions, passes; or a
 * reading the gate refuses, which no comparison with the canonical document
 * names where the canonical rows move it.
 */
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { rewriteExpressionSlotValues } from "@/lib/domain/referenceSlots";
import { type CorpusDocument, lookupContextOf } from "@/proof/corpus/documents";
import { publishFindings } from "@/proof/corpus/editBatches";
import { producerDocuments } from "@/proof/corpus/producers";
import { targetedDocuments } from "@/proof/targeted/index";
import { expandDoc } from "../../../expander";
import { lookupWireNaming } from "../../../lookup/naming";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { inputFor } from "../../__tests__/novaExport";
import { retainedSourceBody } from "../../__tests__/readerInput";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import {
	knownCaseTypesOf,
	knownPositionedCaseOperationIdsOf,
	readHqApp,
} from "../../index";
import type {
	ReaderInput,
	ReaderLookupCatalog,
	ReaderMediaResolution,
} from "../../types";
import { levelsAsPublished } from "../../worldEntities";

const ORIGIN = "https://india.commcarehq.org";
const DOMAIN = "clinic";
const JR_FILE = "jr://file/";
const MEDIA_KIND_OF_EXTENSION: Readonly<
	Record<string, "image" | "audio" | "video">
> = { ".png": "image", ".wav": "audio", ".mp4": "video" };

/** The catalog, and each form's case changes with its expression slots marked. */
function caseFacts(doc: BlueprintDoc) {
	const entities = JSON.parse(
		JSON.stringify({
			fields: doc.fields,
			forms: doc.forms,
			modules: doc.modules,
		}),
	) as Pick<BlueprintDoc, "fields" | "forms" | "modules">;
	for (const uuid of Object.keys(entities.forms) as Uuid[])
		rewriteExpressionSlotValues(
			entities,
			{ entity: "form", uuid },
			() => "expression",
		);
	return JSON.parse(
		JSON.stringify({
			caseTypes: doc.caseTypes,
			forms: Object.fromEntries(
				Object.values(entities.forms).map((form) => [
					form.uuid,
					{
						type: form.type,
						openCondition: form.openCondition,
						closeCondition: form.closeCondition,
						ownClosePlacement: form.ownClosePlacement,
						caseOperations: form.caseOperations,
					},
				]),
			),
		}),
	) as unknown;
}

/** The first place two values differ, as a path and both sides. */
function firstDifference(want: unknown, got: unknown, at = ""): string {
	if (isDeepStrictEqual(want, got)) return "";
	if (
		want !== null &&
		got !== null &&
		typeof want === "object" &&
		typeof got === "object"
	) {
		const keys = new Set([
			...Object.keys(want as object),
			...Object.keys(got as object),
		]);
		for (const key of keys) {
			const inner = firstDifference(
				(want as Record<string, unknown>)[key],
				(got as Record<string, unknown>)[key],
				`${at}/${key}`,
			);
			if (inner !== "") return inner;
		}
	}
	return `${at}: want ${JSON.stringify(want)?.slice(0, 300)}, got ${JSON.stringify(got)?.slice(0, 300)}`;
}

/** The project space's tables, by tag, for a reading. */
function lookupCatalog(document: CorpusDocument): ReaderLookupCatalog {
	const definitions = document.lookup?.definitions ?? [];
	return {
		table: (tag) => {
			const table = definitions.find((one) => one.tag === tag);
			return table === undefined
				? undefined
				: {
						tableId: table.id,
						column: (name) =>
							table.columns.find((column) => column.wireName === name)?.id,
					};
		},
		definitions: new Map(definitions.map((table) => [table.id, table])),
	};
}

/** Where one document's case changes differ from its canonical ones, or nothing. */
async function caseDifference(
	document: CorpusDocument,
	doc: BlueprintDoc,
): Promise<string | null> {
	const manifest = manifestFor(doc);
	const assetOfPath = new Map<string, string>();
	for (const [assetId, asset] of manifest) {
		const path = `${JR_FILE}${asset.wirePath}`;
		if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
	}
	const naming =
		document.lookup === undefined
			? undefined
			: lookupWireNaming(document.lookup.definitions);
	const emitted = expandDoc(doc, {
		attachmentTarget: { origin: ORIGIN, domain: DOMAIN },
		...(manifest.size > 0 && { assets: manifest }),
		...(naming !== undefined && { lookupNaming: naming }),
	});
	const body = {
		...retainedSourceBody("shell/app-source"),
		...(JSON.parse(JSON.stringify(emitted)) as Record<string, unknown>),
	};
	const levels = levelsAsPublished(doc);
	const overrides: Partial<ReaderInput> = {
		resolver: matchingResolver(
			doc.appId,
			externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
		),
		knownCaseTypes: knownCaseTypesOf(doc),
		knownPositionedCaseOperationIds: knownPositionedCaseOperationIdsOf(doc),
		// A save of only the answers that changed is published only to a
		// project space that applies it.
		saveOnlyEditedApplied: true,
		recordDialect: recordDialectRoundTrip,
		lookup: lookupCatalog(document),
		organization: { levelCodes: levels.map((level) => level.code), levels },
		media: {
			resolve: (path): ReaderMediaResolution => {
				const assetId = assetOfPath.get(path);
				if (assetId === undefined) return { kind: "no-entry" };
				const mediaKind =
					MEDIA_KIND_OF_EXTENSION[path.slice(path.lastIndexOf("."))];
				return mediaKind === undefined
					? { kind: "unreadable" }
					: { kind: "asset", assetId, mediaKind };
			},
		},
	};
	const outcome = readHqApp(await inputFor(body, overrides));
	// A document that does not read is `targetedReadBack.test.ts`'s to name.
	if (outcome.kind !== "read" || outcome.defects.length > 0) return null;
	const want = READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
	const difference = firstDifference(
		caseFacts(want),
		caseFacts(outcome.draft.doc),
	);
	if (difference !== "") return difference;
	// The reading is the document before the gate; acceptance applies the
	// platform declaration a person takes, here the document's own.
	const { declaration } = outcome.draft;
	const choice =
		declaration.kind === "choices"
			? declaration.choices.find(
					(one) => one.runsOnlyOn === doc.appSettings.runsOnlyOn,
				)
			: undefined;
	if (choice === undefined)
		return `the reading offers no declaration for ${doc.appSettings.runsOnlyOn ?? "both platforms"}`;
	const verdict = mutationCommitVerdict(
		outcome.draft.doc,
		choice.mutations,
		lookupContextOf(document.lookup),
	);
	return verdict.ok
		? null
		: `the gate refuses the reading: ${verdict.findings
				.map((one) => one.code)
				.join(", ")}`;
}

it("reads every targeted and producer document back to its own case changes, into a document the gate admits", {
	timeout: 300_000,
}, async () => {
	const failures: string[] = [];
	let read = 0;
	for (const document of [...targetedDocuments(), ...producerDocuments()]) {
		const doc = hydratePersistedBlueprint(
			blueprintDocSchema.parse(document.doc),
		);
		ensureReferenceIndex(doc);
		if (publishFindings(doc, document.lookup).length > 0) continue;
		read++;
		const why = await caseDifference(document, doc);
		if (why !== null) failures.push(`${document.id}: ${why}`);
	}
	expect(read).toBeGreaterThan(100);
	expect(failures).toEqual([]);
});
