/**
 * A document's case lists and searches read back through the reader's own
 * stages: Nova's emission of the document on CommCare HQ's own app shell,
 * read by the application, structure, forms and case management stages, the
 * case list and search stages, the expression stage, then the two settles.
 * A test may change the emitted JSON first, as HQ's pages would store it.
 *
 * The menu stage writes each menu's case type before these stages read;
 * this helper writes it from the menu's stored `case_type`, which is what
 * that stage reads it from for a basic menu. The case catalog stage writes
 * each case type with the properties the forms write; this helper writes
 * the same from the operations the case management stage read, through the
 * catalog's one rule for declaring a property (`noteProperty`).
 */
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type {
	BlueprintDoc,
	CaseListConfig,
	Column,
	SearchInputDef,
} from "@/lib/domain";
import type { CaseSearchConfig } from "@/lib/domain/modules";
import type { Finding } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../../expander";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import {
	readCaseManagement,
	settleCaseManagement,
	writeCaseOperations,
} from "../../caseManagement";
import { noteProperty } from "../../caseManagement/catalog";
import type { ReadContext } from "../../context";
import { bindExpressions } from "../../provisional";
import { readSearches, settleSearches } from "../../search";
import { readStructure } from "../../structure";
import type { ReaderInput } from "../../types";
import { mintFields, readForms } from "../../xform";
import { readCaseLists, settleCaseLists } from "..";

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
}

export interface ListReading {
	readonly ctx: ReadContext;
	readonly findings: readonly Finding[];
	readonly app: AppJson;
}

export async function emittedApp(doc: BlueprintDoc): Promise<AppJson> {
	const emitted = expandDoc(doc);
	return JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
}

/** Each menu's case type, with every property a form's operations write on it. */
function writeCatalog(ctx: ReadContext): void {
	const caseTypes: NonNullable<BlueprintDoc["caseTypes"]> = [];
	for (const module of ctx.draft.modules) {
		const name = module.module.caseType;
		if (name !== undefined && !caseTypes.some((type) => type.name === name))
			caseTypes.push({ name, properties: [] });
	}
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			for (const operation of form.form.caseOperations ?? []) {
				const type =
					operation.action === "own"
						? module.module.caseType
						: operation.caseType;
				if (type === undefined || !("writes" in operation)) continue;
				for (const write of operation.writes ?? [])
					noteProperty(caseTypes, type, write.property);
			}
	ctx.writeDraft(() => {
		ctx.draft.caseTypes = caseTypes;
	});
}

export async function readLists(
	doc: BlueprintDoc,
	options: ListReadingOptions = {},
): Promise<ListReading> {
	const app = await emittedApp(doc);
	options.edit?.(app);
	const base = {
		...readerInput(await sourceFromBody(app)),
		recordDialect: recordDialectRoundTrip,
	};
	const ctx = readContext(
		options.input === undefined ? base : options.input(base),
	);
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	for (const module of ctx.draft.modules) {
		const caseType = module.json.peek("case_type");
		if (typeof caseType === "string" && caseType !== "")
			ctx.writeDraft(() => {
				module.module.caseType = caseType;
			});
	}
	readCaseManagement(ctx, ctx.draft);
	mintFields(ctx);
	writeCaseOperations(ctx, ctx.draft);
	writeCatalog(ctx);
	readCaseLists(ctx, ctx.draft);
	readSearches(ctx, ctx.draft);
	if (options.firstPassOnly !== true) {
		bindExpressions(ctx);
		settleCaseManagement(ctx, ctx.draft);
		settleCaseLists(ctx, ctx.draft);
		settleSearches(ctx, ctx.draft);
	}
	return { ctx, findings: ctx.accounting.findings(), app };
}

/** The codes of a reading's findings on case lists, details and searches, `unrecognized` named
 *  by its key. */
export function codes(reading: ListReading): string[] {
	const places = new Set(["case-list", "case-detail", "search"]);
	return reading.findings
		.filter((finding) => places.has(finding.place.kind))
		.map((finding) =>
			finding.code === "unrecognized"
				? `unrecognized:${(finding.detail as { name?: string }).name ?? ""}`
				: finding.code,
		);
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
