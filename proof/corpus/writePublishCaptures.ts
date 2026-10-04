/**
 * Write what Nova's publish sends for each corpus document, for the HQ side
 * of the harness to apply (`proof/hq/operations.py::publish`).
 *
 * Run from the worktree root, where `@/` resolves and the built-in icons
 * are read from `public/nova-icons/`:
 *
 *   node --conditions=react-server --import ./proof/corpus/entropy.mts \
 *     --import tsx proof/corpus/writePublishCaptures.ts \
 *     --documents <documents.json> [--configurations <configurations.json>] \
 *     [--seed <n>] --out <dir>
 *
 * `--conditions=react-server` resolves `server-only` to its empty module;
 * Nova's HQ client and media modules import it, and under plain Node it
 * throws at import.
 *
 * documents.json is an array of
 *
 *   { "id", "doc", "compiledAtSeq",
 *     "lookup"?: { "projectId", "projectRevision", "definitions", "rowsByTable": { <table id>: rows } },
 *     "media"?: { <asset id>: { "kind", "mimeType", "extension", "base64" } },
 *     "edited"?: { "doc", "compiledAtSeq", "lookup"?, "media"? } }
 *
 * where `doc` is the stored (persistable) document and `edited` is D′, the
 * document after its edit batch. Each is read as Nova's stores hold it, and
 * a file they could not hold is refused with the document and the field:
 *
 * - `lookup` is the Project's lookup data: the definitions and rows
 *   `lib/lookup/schema.ts` admits, every definition with its `rowsByTable`
 *   entry (rows in stored order), and each row's cells as
 *   `lib/lookup/coercion.ts::validateLookupRowValues` stores them;
 * - `media` holds each uploaded asset the document references, by its asset
 *   id: an accepted MIME type as Nova writes it (`image/png`), the kind and
 *   the dotted extension Nova stores for that type (`image`, `.png`), and
 *   the bytes in canonical base64. Built-in icons need no entry.
 *
 * The Project holds no places, so no publish pushes any. A document Nova's
 * export boundary refuses (`./publish.ts::exportFindings`) stops the run
 * before anything is written.
 *
 * configurations.json is an array of
 * `{ "id", "flags": [<toggle symbol>...], "case_search_enabled"?, "domain"? }`
 * (the domain defaults to the HQ side's). Every document is also captured
 * under `minimum`, the least configuration Nova publishes both D and D′ to.
 *
 * For each document the output directory holds `<id>/verdict.json` (Nova's
 * verdict for D and D′) and, per configuration, `<id>/<configuration>/`:
 *
 * - `outcome.json`: the configuration, the target, and each publish's
 *   outcome: `sent`, or `refused` by Nova's project-space check;
 * - for each publish Nova sends (`create`, then `update` of D and
 *   `update-edited` of D′, each over the created app), `<publish>.import.body`,
 *   when it pushes lookup tables `<publish>.lookup.body`, and when the export
 *   carries media `<publish>.media.body` (the upload Nova sends after the
 *   import): the request bodies as sent, framed with a fixed multipart
 *   boundary; each with a `.json` sidecar naming the method, path, content
 *   type and fields, and for an update the placeholder app id and the source
 *   profile assumed for the created app;
 * - when Nova publishes there, `local-1.ccz` and `local-2.ccz`: two exports
 *   of D as Nova's compile route builds them for an app published to that
 *   project space.
 *
 * Every file is the same on every run for one seed (`--seed`, by default
 * the corpus's): each publish and each local export draws the identities
 * Nova mints from its own seeded generator (`./entropy.mts`), as the
 * corpus's exports do: the create at one ordinal, `update` (the republish)
 * at another, `update-edited` at the republish's when it sends exactly
 * what `update` sends and at its own otherwise
 * (`./publish.ts::capturePublish`), and the two local exports at theirs.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import type { PersistableDoc } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { MEDIA_KINDS, mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { validateLookupRowValues } from "@/lib/lookup/coercion";
import { LOOKUP_MAX_COLUMNS, LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import {
	lookupColumnLabelSchema,
	lookupDataTypeSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
	lookupTagSchema,
	lookupWireNameSchema,
} from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupRowValues,
	LookupTableId,
} from "@/lib/lookup/types";
import { DEFAULT_CORPUS_SEED } from "./defaults";
import { LOCAL_CONFIGURATION, OPERATION_ORDINALS } from "./entropy.mts";
import {
	type CapturedRequest,
	CCZ_CLOCK,
	capturePublish,
	documentVerdict,
	exportFindings,
	localCcz,
	minimumConfiguration,
	type NovaPublishVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_DOMAIN,
	PROOF_SERVER,
	type PublishConfiguration,
	type PublishDocument,
	type StepOutcome,
	UnexportableDocumentError,
	type UploadedMedia,
	uploadedMediaProblem,
} from "./publish";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeName(value: unknown, what: string): string {
	if (typeof value !== "string" || !SAFE_NAME.test(value)) {
		fail(
			`Each ${what} needs an id of letters, digits, dots, dashes and underscores, since it names a directory; got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/** A stored lookup column, as `lib/lookup/definitionSnapshot.ts` reads it. */
const lookupColumnSchema = z.strictObject({
	id: lookupColumnIdSchema,
	wireName: lookupWireNameSchema,
	label: lookupColumnLabelSchema,
	dataType: lookupDataTypeSchema,
});

/** A stored lookup table definition (`lib/lookup/types.ts::LookupTableDefinition`). */
const lookupDefinitionSchema = z.strictObject({
	id: lookupTableIdSchema,
	name: lookupTableNameSchema,
	tag: lookupTagSchema,
	columnCount: z.number().int().nonnegative().optional(),
	rowCount: z.number().int().nonnegative().optional(),
	dataBytes: z.number().int().nonnegative().optional(),
	definitionRevision: lookupRevisionSchema,
	rowsRevision: lookupRevisionSchema.optional(),
	tableRevision: lookupRevisionSchema.optional(),
	columns: z.array(lookupColumnSchema).max(LOOKUP_MAX_COLUMNS),
});

/** A Project's lookup data as the documents file holds it. */
const lookupSnapshotSchema = z.strictObject({
	projectId: z.string().min(1),
	projectRevision: lookupRevisionSchema,
	definitions: z.array(lookupDefinitionSchema),
	rowsByTable: z.record(
		lookupTableIdSchema,
		z
			.array(z.strictObject({ id: lookupRowIdSchema, values: z.unknown() }))
			.max(LOOKUP_MAX_ROWS),
	),
});

/** Messages joined into one clause, without their closing full stops. */
function sentences(messages: readonly string[]): string {
	return messages
		.map((message) => (message.endsWith(".") ? message.slice(0, -1) : message))
		.join("; ");
}

function repeated(values: readonly string[]): string | undefined {
	return values.find((value, index) => values.indexOf(value) !== index);
}

/**
 * Why Nova's lookup store never holds `snapshot` as given, or `undefined`
 * when it can: every identity once, every definition with its rows and
 * every row set with its definition, and each row's cells exactly as
 * `lib/lookup/coercion.ts::validateLookupRowValues` stores them for its
 * table's columns.
 */
function lookupSnapshotProblem(
	snapshot: z.infer<typeof lookupSnapshotSchema>,
): string | undefined {
	const tableIds = snapshot.definitions.map((definition) => definition.id);
	const twice = repeated(tableIds);
	if (twice !== undefined) return `the table ${twice} is defined twice`;
	for (const tableId of Object.keys(snapshot.rowsByTable)) {
		if (!tableIds.includes(tableId as LookupTableId)) {
			return `rowsByTable holds rows for ${tableId}, which no definition names`;
		}
	}
	for (const definition of snapshot.definitions) {
		const column = repeated(definition.columns.map((c) => c.id));
		if (column !== undefined) {
			return `the table ${definition.tag} has the column ${column} twice`;
		}
		const rows = snapshot.rowsByTable[definition.id];
		if (rows === undefined) {
			return `the table ${definition.tag} has no rowsByTable entry`;
		}
		const row = repeated(rows.map((r) => r.id));
		if (row !== undefined) {
			return `the table ${definition.tag} has the row ${row} twice`;
		}
		for (const { id, values } of rows) {
			const checked = validateLookupRowValues(definition.columns, values);
			if (!checked.success) {
				return `in the table ${definition.tag}, row ${id}: ${sentences(checked.issues.map((issue) => issue.message))}`;
			}
			if (!isDeepStrictEqual(checked.values, values)) {
				return `in the table ${definition.tag}, row ${id} holds cells Nova's store keeps as ${JSON.stringify(checked.values)}`;
			}
		}
	}
	return undefined;
}

function readLookup(
	value: unknown,
	documentId: string,
): LookupFixtureDataSnapshot | undefined {
	if (value === undefined) return undefined;
	const parsed = lookupSnapshotSchema.safeParse(value);
	if (!parsed.success) {
		fail(
			`Document ${documentId}'s lookup snapshot is not one Nova's lookup store holds: ${parsed.error.issues
				.map(
					(issue) =>
						`${["lookup", ...issue.path].join(".")}: ${sentences([issue.message])}`,
				)
				.join("; ")}.`,
		);
	}
	if (!isDeepStrictEqual(parsed.data, value)) {
		fail(
			`Document ${documentId}'s lookup snapshot holds a name, label or cell Nova's lookup store would not keep as written (it trims names and labels). Write each as the store holds it.`,
		);
	}
	const problem = lookupSnapshotProblem(parsed.data);
	if (problem !== undefined) {
		fail(
			`Document ${documentId}'s lookup snapshot is not one Nova's lookup store holds: ${problem}.`,
		);
	}
	return {
		projectId: parsed.data.projectId,
		projectRevision: parsed.data.projectRevision,
		definitions: parsed.data.definitions,
		rowsByTable: new Map(
			parsed.data.definitions.map((definition) => [
				definition.id,
				(parsed.data.rowsByTable[definition.id] ?? []).map(
					(row): LookupFixtureRow => ({
						id: row.id,
						values: row.values as LookupRowValues,
					}),
				),
			]),
		),
	};
}

/** One uploaded asset as the documents file holds it: its bytes in canonical base64. */
const uploadedMediaSchema = z.strictObject({
	kind: z.enum(MEDIA_KINDS),
	mimeType: z.string(),
	extension: z.string(),
	base64: z.string().min(1),
});

function readMedia(
	value: unknown,
	documentId: string,
): ReadonlyMap<string, UploadedMedia> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		fail(`Document ${documentId} has media that is not an object by asset id.`);
	}
	return new Map(
		Object.entries(value).map(([assetId, entry]) => {
			const where = `Document ${documentId}'s media asset ${assetId}`;
			if (!mediaAssetIdSchema.safeParse(assetId).success) {
				fail(
					`${where} is not named by an uploaded asset id (a lowercase UUID); built-in icons need no media entry.`,
				);
			}
			const parsed = uploadedMediaSchema.safeParse(entry);
			if (!parsed.success) {
				fail(
					`${where} needs exactly a kind (${MEDIA_KINDS.join(", ")}), mimeType, extension and base64 bytes: ${parsed.error.issues
						.map(
							(issue) =>
								`${issue.path.join(".") || "entry"}: ${sentences([issue.message])}`,
						)
						.join("; ")}.`,
				);
			}
			const bytes = Buffer.from(parsed.data.base64, "base64");
			if (bytes.toString("base64") !== parsed.data.base64) {
				fail(
					`${where} has base64 that does not decode to bytes and back unchanged, so its bytes are not what the file says. Write them as canonical base64.`,
				);
			}
			const asset: UploadedMedia = {
				kind: parsed.data.kind,
				mimeType: parsed.data.mimeType,
				extension: parsed.data.extension,
				bytes,
			};
			const problem = uploadedMediaProblem(asset);
			if (problem !== undefined) {
				fail(`${where} is not one Nova's upload stores: ${problem}.`);
			}
			return [assetId, asset] as const;
		}),
	);
}

function readDocument(value: unknown, id: string): PublishDocument {
	if (
		!isRecord(value) ||
		!isRecord(value.doc) ||
		!Number.isSafeInteger(value.compiledAtSeq)
	) {
		fail(`Document ${id} needs a stored doc and an integer compiledAtSeq.`);
	}
	const lookup = readLookup(value.lookup, id);
	const media = readMedia(value.media, id);
	return {
		id,
		doc: value.doc as unknown as PersistableDoc,
		compiledAtSeq: value.compiledAtSeq as number,
		...(lookup !== undefined && { lookup }),
		...(media !== undefined && { media }),
	};
}

export interface DocumentEntry {
	readonly document: PublishDocument;
	readonly edited?: PublishDocument;
}

export function readDocuments(value: unknown): DocumentEntry[] {
	if (!Array.isArray(value))
		fail("The documents file holds an array of documents.");
	const seen = new Set<string>();
	return value.map((entry) => {
		const id = safeName(isRecord(entry) ? entry.id : undefined, "document");
		if (seen.has(id)) fail(`Two documents share the id ${id}.`);
		seen.add(id);
		const record = entry as Record<string, unknown>;
		return {
			document: readDocument(record, id),
			...(record.edited !== undefined && {
				edited: readDocument(record.edited, `${id} (edited)`),
			}),
		};
	});
}

export function readConfigurations(value: unknown): PublishConfiguration[] {
	if (!Array.isArray(value)) {
		fail("The configurations file holds an array of configurations.");
	}
	const seen = new Set<string>(["minimum"]);
	return value.map((entry) => {
		const id = safeName(
			isRecord(entry) ? entry.id : undefined,
			"configuration",
		);
		if (seen.has(id)) {
			fail(
				`The configuration id ${id} is taken${id === "minimum" ? " by each document's minimum configuration" : " twice"}.`,
			);
		}
		seen.add(id);
		const record = entry as Record<string, unknown>;
		const flags = record.flags;
		if (
			!Array.isArray(flags) ||
			!flags.every((flag) => typeof flag === "string")
		) {
			fail(`Configuration ${id} needs flags, an array of toggle symbols.`);
		}
		const caseSearch = record.case_search_enabled ?? false;
		const domain = record.domain ?? PROOF_DOMAIN;
		if (typeof caseSearch !== "boolean" || typeof domain !== "string") {
			fail(
				`Configuration ${id} has a case_search_enabled that is not a boolean or a domain that is not a string.`,
			);
		}
		return {
			id,
			flags: [...flags].sort(),
			caseSearchEnabled: caseSearch,
			domain,
		};
	});
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function configurationJson(configuration: PublishConfiguration) {
	return {
		id: configuration.id,
		flags: configuration.flags,
		case_search_enabled: configuration.caseSearchEnabled,
		domain: configuration.domain,
	};
}

async function writeRequest(
	directory: string,
	name: string,
	request: CapturedRequest,
	update?: { readonly assumedSourceProfile: unknown },
): Promise<void> {
	await writeFile(join(directory, `${name}.body`), request.body);
	await writeFile(
		join(directory, `${name}.json`),
		jsonText({
			method: request.method,
			path: request.path,
			contentType: request.contentType,
			body: `${name}.body`,
			fields: request.fields,
			...(update !== undefined && {
				placeholderAppId: PLACEHOLDER_APP_ID,
				assumedSourceProfile: update.assumedSourceProfile,
			}),
		}),
	);
}

function stepSummary(step: StepOutcome) {
	return {
		status: step.status,
		compatibility: step.compatibility,
		...(step.status === "sent" && {
			requests: [
				...(step.lookup !== undefined ? ["lookup"] : []),
				"import",
				...(step.media !== undefined ? ["media"] : []),
			],
		}),
	};
}

async function writeStep(
	directory: string,
	name: string,
	step: StepOutcome,
	update?: { readonly assumedSourceProfile: unknown },
): Promise<void> {
	if (step.status !== "sent") return;
	if (step.lookup !== undefined) {
		await writeRequest(directory, `${name}.lookup`, step.lookup);
	}
	await writeRequest(directory, `${name}.import`, step.importApp, update);
	if (step.media !== undefined) {
		await writeRequest(directory, `${name}.media`, step.media);
	}
}

async function writeConfiguration(
	root: string,
	entry: DocumentEntry,
	configuration: PublishConfiguration,
	seed: number,
): Promise<string> {
	const directory = join(root, configuration.id);
	await mkdir(directory, { recursive: true });
	const capture = await capturePublish({
		create: entry.document,
		updates: [
			{ name: "update", document: entry.document },
			...(entry.edited !== undefined
				? [{ name: "update-edited", document: entry.edited }]
				: []),
		],
		configuration,
		seed,
	});
	const target = { server: PROOF_SERVER, domain: configuration.domain };
	if (capture.status === "refused") {
		await writeFile(
			join(directory, "outcome.json"),
			jsonText({
				configuration: configurationJson(configuration),
				target,
				create: stepSummary(capture.create),
			}),
		);
		return "refused";
	}
	await writeStep(directory, "create", capture.create);
	for (const [name, step] of Object.entries(capture.updates)) {
		await writeStep(directory, name, step, {
			assumedSourceProfile: capture.assumedSourceProfile,
		});
	}
	for (const [copy, ordinal] of [
		[1, OPERATION_ORDINALS.local],
		[2, OPERATION_ORDINALS.localAgain],
	] as const) {
		await writeFile(
			join(directory, `local-${copy}.ccz`),
			await localCcz(entry.document, configuration.domain, {
				seed,
				ordinal,
				configuration: LOCAL_CONFIGURATION,
			}),
		);
	}
	await writeFile(
		join(directory, "outcome.json"),
		jsonText({
			configuration: configurationJson(configuration),
			target,
			create: stepSummary(capture.create),
			updates: Object.fromEntries(
				Object.entries(capture.updates).map(([name, step]) => [
					name,
					stepSummary(step),
				]),
			),
			assumedSourceProfile: capture.assumedSourceProfile,
			localCcz: {
				files: ["local-1.ccz", "local-2.ccz"],
				compiledAtSeq: entry.document.compiledAtSeq,
				clock: new Date(CCZ_CLOCK).toISOString(),
			},
		}),
	);
	return "sent";
}

/** Nova's verdict as `verdict.json` holds it, its minimum in the configuration file's shape. */
function verdictJson(verdict: NovaPublishVerdict) {
	return {
		capabilities: verdict.capabilities,
		advisories: verdict.advisories,
		minimumConfiguration: {
			flags: verdict.minimumConfiguration.flags,
			case_search_enabled: verdict.minimumConfiguration.caseSearchEnabled,
		},
	};
}

/**
 * Write every document's verdict and, under its minimum configuration and
 * each of `configurations`, what Nova's publish sends, its minted
 * identities drawn from `seed`. Each document's directory is replaced, so
 * nothing from an earlier run lingers there. Returns one line per document
 * naming each configuration's outcome.
 */
export async function writePublishCaptures(
	entries: readonly DocumentEntry[],
	configurations: readonly PublishConfiguration[],
	out: string,
	seed: number = DEFAULT_CORPUS_SEED,
): Promise<string[]> {
	/* A document Nova does not export stops the run before anything is
	 * written: D is published and downloaded, D′ is published. */
	for (const entry of entries) {
		const exports = [
			[entry.document, "hq-upload"],
			[entry.document, "ccz"],
			...(entry.edited !== undefined
				? [[entry.edited, "hq-upload"] as const]
				: []),
		] as const;
		for (const [document, mode] of exports) {
			const findings = await exportFindings(document, mode);
			if (findings.length > 0) {
				throw new UnexportableDocumentError(document.id, mode, findings);
			}
		}
	}
	const lines: string[] = [];
	for (const entry of entries) {
		const root = join(out, entry.document.id);
		await rm(root, { recursive: true, force: true });
		await mkdir(root, { recursive: true });
		const verdicts = [
			documentVerdict(entry.document),
			...(entry.edited !== undefined ? [documentVerdict(entry.edited)] : []),
		];
		const [verdict, edited] = verdicts;
		await writeFile(
			join(root, "verdict.json"),
			jsonText({
				...(verdict !== undefined && { document: verdictJson(verdict) }),
				...(edited !== undefined && { edited: verdictJson(edited) }),
			}),
		);
		const outcomes: string[] = [];
		for (const configuration of [
			minimumConfiguration(verdicts),
			...configurations,
		]) {
			outcomes.push(
				`${configuration.id} ${await writeConfiguration(root, entry, configuration, seed)}`,
			);
		}
		lines.push(`${entry.document.id}: ${outcomes.join(", ")}`);
	}
	return lines;
}

async function main(argv: readonly string[]): Promise<void> {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			documents: { type: "string" },
			configurations: { type: "string" },
			seed: { type: "string" },
			out: { type: "string" },
		},
		strict: true,
	});
	if (values.documents === undefined || values.out === undefined) {
		fail(
			"Name the documents file and the output directory: --documents <documents.json> --out <dir> [--configurations <configurations.json>] [--seed <n>].",
		);
	}
	const seed =
		values.seed === undefined ? DEFAULT_CORPUS_SEED : Number(values.seed);
	if (!Number.isSafeInteger(seed)) {
		fail(`--seed takes a whole number; got ${JSON.stringify(values.seed)}.`);
	}
	const entries = readDocuments(
		JSON.parse(await readFile(values.documents, "utf8")),
	);
	const configurations =
		values.configurations === undefined
			? []
			: readConfigurations(
					JSON.parse(await readFile(values.configurations, "utf8")),
				);
	for (const line of await writePublishCaptures(
		entries,
		configurations,
		values.out,
		seed,
	)) {
		console.log(line);
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
