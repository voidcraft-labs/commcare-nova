/**
 * A document's case management read back through the reader's own stages:
 * Nova's emission of the document, on CommCare HQ's own app shell, read by
 * the application, structure and forms stages, then the case management
 * stage, the minting of the fields, and the writing of the operations. A
 * test may change the emitted JSON first, as HQ's pages would store it.
 *
 * The menu stage writes each menu's case type before case management
 * reads; this helper writes it from the menu's stored `case_type`, which is
 * what that stage reads it from for a basic menu.
 */
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import type { Finding } from "@/lib/publish/hqFindings";
import { expandDoc } from "../../../expander";
import { planPlacements } from "../../../placement";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import type { DraftForm, ReadContext } from "../../context";
import { readStructure } from "../../structure";
import type { ReaderInput } from "../../types";
import {
	type DraftField,
	mintFields,
	type ReadXForm,
	readForms,
} from "../../xform";
import {
	readCaseManagement,
	settleCaseManagement,
	writeCaseOperations,
} from "../index";
import { knownCaseTypesOf } from "../knownCaseTypes";

export type AppJson = Record<string, unknown> & {
	modules: Array<
		Record<string, unknown> & {
			forms: Array<
				Record<string, unknown> & { actions: Record<string, unknown> }
			>;
		}
	>;
};

export interface CaseReadingOptions {
	/** Changes the emitted JSON before it is read, as HQ's pages would store it. */
	readonly edit?: (app: AppJson) => void;
	readonly saveOnlyEditedApplied?: boolean;
	/** What the emitter is given beside the document: a capture's link is
	 *  written only against a project space. */
	readonly expand?: Parameters<typeof expandDoc>[1];
	/** Changes a form's emitted source before it is read, by the form's index in emission order. */
	readonly editSource?: (xml: string, formIndex: number) => string;
	/** Changes what the reading is given beside the source: the project space's tables. */
	readonly input?: (input: ReaderInput) => ReaderInput;
	/** Writes each basic menu's parent selection from its `parent_select`, as the menu stage does. */
	readonly parentSelections?: boolean;
}

export interface CaseReading {
	readonly ctx: ReadContext;
	readonly forms: readonly DraftForm[];
	readonly findings: readonly Finding[];
}

/** The menu stage's case type for each basic menu, from its stored `case_type`, and where
 *  `parentSelections`, its parent selection, from its active `parent_select`. */
function writeMenuCaseTypes(ctx: ReadContext, parentSelections: boolean): void {
	for (const module of ctx.draft.modules) {
		const caseType = module.json.peek("case_type");
		if (typeof caseType === "string" && caseType !== "")
			ctx.writeDraft(() => {
				module.module.caseType = caseType;
			});
		if (!parentSelections) continue;
		const select = module.json.peek("parent_select") as
			| { active?: unknown; module_id?: unknown }
			| null
			| undefined;
		const parent =
			select?.active === true
				? ctx.draft.modules.find((one) => one.uniqueId === select.module_id)
				: undefined;
		if (parent !== undefined)
			ctx.writeDraft(() => {
				module.module.parentCaseModuleUuid = parent.uuid;
			});
	}
}

export async function readCases(
	doc: BlueprintDoc,
	options: CaseReadingOptions = {},
): Promise<CaseReading> {
	const emitted = expandDoc(doc, options.expand);
	if (options.editSource !== undefined) {
		const attachments = emitted._attachments as Record<string, string>;
		const ids = emitted.modules.flatMap((module) =>
			(module.forms as readonly { unique_id: string }[]).map(
				(form) => form.unique_id,
			),
		);
		ids.forEach((id, index) => {
			const xml = attachments[`${id}.xml`];
			if (typeof xml === "string")
				attachments[`${id}.xml`] = (
					options.editSource as (xml: string, i: number) => string
				)(xml, index);
		});
	}
	const app = JSON.parse(
		JSON.stringify({
			...retainedSourceBody("shell/app-source"),
			modules: emitted.modules,
			_attachments: emitted._attachments,
		}),
	) as AppJson;
	options.edit?.(app);
	// A read-back of a document Nova holds is told its case types' parents.
	const known = knownCaseTypesOf(doc);
	return readCasesOfBody(app, {
		...options,
		input: (read) => {
			const told = { ...read, knownCaseTypes: known };
			return options.input === undefined ? told : options.input(told);
		},
	});
}

/** The case management of a stored app as HQ's source view serves it, a retained answer among
 *  them, read through the same stages. */
export async function readCasesOfBody(
	app: Readonly<Record<string, unknown>>,
	options: Pick<
		CaseReadingOptions,
		"saveOnlyEditedApplied" | "input" | "parentSelections"
	> = {},
): Promise<CaseReading> {
	const read = readerInput(await sourceFromBody(app));
	const input = options.input === undefined ? read : options.input(read);
	const ctx = readContext(
		options.saveOnlyEditedApplied === undefined
			? input
			: { ...input, saveOnlyEditedApplied: options.saveOnlyEditedApplied },
	);
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	writeMenuCaseTypes(ctx, options.parentSelections === true);
	readCaseManagement(ctx, ctx.draft);
	mintFields(ctx);
	writeCaseOperations(ctx, ctx.draft);
	// With nothing bound, the settle stage judges what pass 1 alone read: each
	// form's `save` map against its blocks, and a question path left for the
	// bound form under its own row.
	settleCaseManagement(ctx, ctx.draft);
	const forms = ctx.draft.modules.flatMap((module) => module.forms);
	return { ctx, forms, findings: ctx.close().findings };
}

/** Every field of a form's reading in document order. */
export function readFields(xform: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/** Each field's and inline choice's UUID in `doc` to its id and value. */
export function docNames(doc: BlueprintDoc): Map<string, string> {
	const names = new Map<string, string>();
	for (const field of Object.values(doc.fields)) {
		names.set(field.uuid, field.id);
		const source = (
			field as {
				optionsSource?: {
					kind: string;
					options?: { uuid: Uuid; value: string }[];
				};
			}
		).optionsSource;
		if (source?.kind === "inline")
			for (const option of source.options ?? [])
				names.set(option.uuid, `${field.id}=${option.value}`);
	}
	return names;
}

/** Each minted field's and inline choice's UUID in a reading to its id and value. */
export function readNames(form: DraftForm): Map<string, string> {
	const names = new Map<string, string>();
	if (form.xform === null) return names;
	for (const field of readFields(form.xform)) {
		if (field.uuid !== undefined) names.set(field.uuid, field.id);
		const source = field.field.optionsSource as
			| { kind: string; options?: { uuid?: Uuid; value: string }[] }
			| undefined;
		if (source?.kind === "inline")
			for (const option of source.options ?? [])
				if (option.uuid !== undefined)
					names.set(option.uuid, `${field.id}=${option.value}`);
	}
	return names;
}

/** `value` with every string `names` holds replaced by its name: two
 *  documents' slots compared by the questions they read. */
export function named(
	value: unknown,
	names: ReadonlyMap<string, string>,
): unknown {
	if (typeof value === "string") return names.get(value) ?? value;
	if (Array.isArray(value)) return value.map((one) => named(one, names));
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([key, one]) => [key, named(one, names)]),
		);
	return value;
}

/** The manifest findings of a reading, by entry, outside `unrecognized`. */
export function findingCodes(reading: CaseReading): string[] {
	return reading.findings
		.filter((finding) => finding.code !== "unrecognized")
		.map((finding) => finding.code);
}

/** D's operations of a form, each with the placement the plan gives it, and none held before. */
export function plannedOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): CaseOperation[] {
	const placements = planPlacements(doc, formUuid).placements;
	return (doc.forms[formUuid]?.caseOperations ?? []).map((operation) => {
		const planned = placements.get(operation.uuid);
		const { placement: _held, ...rest } = operation;
		return (
			planned === undefined || planned.sharesWith !== undefined
				? rest
				: { ...rest, placement: planned.placement }
		) as CaseOperation;
	});
}

/** Each field and inline choice of a form of `doc` by its data path, which two siblings never share. */
export function docPaths(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Map<string, string> {
	const paths = new Map<string, string>();
	const walk = (parent: Uuid, prefix: string) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const path = `${prefix}/${field.id}`;
			paths.set(uuid, path);
			const source = (
				field as {
					optionsSource?: {
						kind: string;
						options?: { uuid: Uuid; value: string }[];
					};
				}
			).optionsSource;
			if (source?.kind === "inline")
				for (const option of source.options ?? [])
					paths.set(option.uuid, `${path}=${option.value}`);
			walk(uuid, path);
		}
	};
	walk(formUuid, "");
	return paths;
}

/** The same of a form's reading. */
export function readPaths(form: DraftForm): Map<string, string> {
	const paths = new Map<string, string>();
	const xform = form.xform;
	if (xform === null) return paths;
	const walk = (parent: DraftField | null, prefix: string) => {
		for (const field of xform.childrenOf(parent)) {
			const path = `${prefix}/${field.id}`;
			if (field.uuid !== undefined) paths.set(field.uuid, path);
			const source = field.field.optionsSource as
				| { kind: string; options?: { uuid?: Uuid; value: string }[] }
				| undefined;
			if (source?.kind === "inline")
				for (const option of source.options ?? [])
					if (option.uuid !== undefined)
						paths.set(option.uuid, `${path}=${option.value}`);
			walk(field, path);
		}
	};
	walk(null, "");
	return paths;
}

/** Operations compared by the questions, menus and earlier operations they name, never by UUID. */
export function comparableOperations(
	operations: readonly CaseOperation[],
	paths: ReadonlyMap<string, string>,
	modules: ReadonlyMap<string, string>,
): unknown {
	const ops = new Map(
		operations.map((operation, index) => [operation.uuid, `op:${index}`]),
	);
	return named(
		named(
			named(
				operations.map(({ uuid: _uuid, ...rest }) => rest),
				paths,
			),
			modules,
		),
		ops,
	);
}
