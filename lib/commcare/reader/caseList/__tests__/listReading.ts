/**
 * A document's case lists and searches read back through the reader's own
 * stages: Nova's emission of the document on CommCare HQ's own app shell,
 * read by every stage of `STAGES` up to the assembly (or, for a first pass,
 * up to the expression stage). A test may change the emitted JSON first, as
 * HQ's pages would store it.
 */
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import type {
	BlueprintDoc,
	CaseListConfig,
	Column,
	SearchInputDef,
} from "@/lib/domain";
import type { CaseSearchConfig } from "@/lib/domain/modules";
import type { Finding } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../../expander";
import type { LookupWireNaming } from "../../../lookup/naming";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { assembleDocument } from "../../assemble";
import type { ReadContext } from "../../context";
import { knownCaseTypesOf, STAGES } from "../../index";
import { bindExpressions } from "../../provisional";
import type { ReaderInput, ReaderMediaResolution } from "../../types";

export type AppJson = Record<string, unknown> & {
	modules: Array<
		Record<string, unknown> & {
			case_details: { short: Detail; long: Detail };
			search_config: Record<string, unknown>;
		}
	>;
};
export type Detail = Record<string, unknown> & {
	columns: Array<Record<string, unknown>>;
	sort_elements: Array<Record<string, unknown>>;
};

export interface ListReadingOptions {
	readonly edit?: (app: AppJson) => void;
	readonly input?: (input: ReaderInput) => ReaderInput;
	/** Stop before the expression stage and the settles. */
	readonly firstPassOnly?: boolean;
	/** Emit with a manifest of every asset the document names, and read each file back as its
	 *  asset, as a bring-in's media index answers. */
	readonly media?: boolean;
	/** The names Nova's emission prints each table read under, where the document reads one. */
	readonly lookupNaming?: LookupWireNaming;
}

export interface ListReading {
	readonly ctx: ReadContext;
	readonly findings: readonly Finding[];
	readonly app: AppJson;
}

/** Each image asset's path in an emission with a manifest, as `jr://file/` spells it. */
function imagePaths(doc: BlueprintDoc): Map<string, string> {
	const out = new Map<string, string>();
	for (const [assetId, asset] of manifestFor(doc))
		out.set(`jr://file/${asset.wirePath}`, assetId);
	return out;
}

export async function emittedApp(
	doc: BlueprintDoc,
	media = false,
	lookupNaming?: LookupWireNaming,
): Promise<AppJson> {
	const emitted = expandDoc(doc, {
		...(media && { assets: manifestFor(doc) }),
		...(lookupNaming !== undefined && { lookupNaming }),
	});
	return JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
}

export async function readLists(
	doc: BlueprintDoc,
	options: ListReadingOptions = {},
): Promise<ListReading> {
	const app = await emittedApp(
		doc,
		options.media === true,
		options.lookupNaming,
	);
	options.edit?.(app);
	const paths = options.media === true ? imagePaths(doc) : new Map();
	const base = {
		...readerInput(await sourceFromBody(app), {
			media: (path: string): ReaderMediaResolution => {
				const assetId = paths.get(path);
				return assetId === undefined
					? { kind: "no-entry" }
					: { kind: "asset", assetId, mediaKind: "image" };
			},
		}),
		recordDialect: recordDialectRoundTrip,
		knownCaseTypes: knownCaseTypesOf(doc),
	};
	const ctx = readContext(
		options.input === undefined ? base : options.input(base),
	);
	const last = STAGES.indexOf(
		options.firstPassOnly === true ? bindExpressions : assembleDocument,
	);
	for (const stage of STAGES.slice(0, last)) stage(ctx);
	return { ctx, findings: ctx.accounting.findings(), app };
}

/** The codes of findings on case lists, details and searches, `unrecognized` named by its key. */
function codesOf(findings: readonly Finding[]): string[] {
	const places = new Set(["case-list", "case-detail", "search"]);
	return findings
		.filter((finding) => places.has(finding.place.kind))
		.map((finding) =>
			finding.code === "unrecognized"
				? `unrecognized:${(finding.detail as { name?: string }).name ?? ""}`
				: finding.code,
		);
}

/** The codes of a reading's findings on case lists, details and searches. */
export function codes(reading: ListReading): string[] {
	return codesOf(reading.findings);
}

/** The codes after the accounting's close, which names every key no stage claimed. */
export function closedCodes(reading: ListReading): string[] {
	return codesOf(reading.ctx.close().findings);
}

/** One menu's case list as the reading's document holds it (bound where the settle ran). */
export function listOf(reading: ListReading, module = 0): CaseListConfig {
	const uuid = reading.ctx.draft.modules[module]?.uuid;
	const fromDoc =
		uuid === undefined
			? undefined
			: reading.ctx.doc?.modules[uuid]?.caseListConfig;
	const config =
		fromDoc ??
		(reading.ctx.draft.modules[module]?.module.caseListConfig as
			| CaseListConfig
			| undefined);
	if (config === undefined)
		throw new Error(`The reading holds no case list for menu ${module}.`);
	return config;
}

/** One menu's search as the reading's document holds it. */
export function searchOf(
	reading: ListReading,
	module = 0,
): CaseSearchConfig | undefined {
	const uuid = reading.ctx.draft.modules[module]?.uuid;
	const fromDoc =
		uuid === undefined
			? undefined
			: reading.ctx.doc?.modules[uuid]?.caseSearchConfig;
	return (
		fromDoc ??
		(reading.ctx.draft.modules[module]?.module.caseSearchConfig as
			| CaseSearchConfig
			| undefined)
	);
}

/** A case list compared without identities: columns in list order with each column's place in
 *  the detail order, and the Search fields without their uuids. */
export function comparableList(config: CaseListConfig): unknown {
	const byUuid = new Map(config.columns.map((column) => [column.uuid, column]));
	const strip = ({ uuid: _uuid, ...rest }: Column) => rest;
	return {
		list: config.listColumnOrder.map((uuid) =>
			strip(byUuid.get(uuid) as Column),
		),
		detail: config.detailColumnOrder.map((uuid) =>
			config.listColumnOrder.indexOf(uuid),
		),
		filter: config.filter,
		selection: config.selection,
		tile: config.tile,
		searchInputs: config.searchInputs.map(
			({ uuid: _uuid, ...rest }: SearchInputDef) => rest,
		),
	};
}
