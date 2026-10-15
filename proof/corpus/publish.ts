/**
 * What Nova's publish sends CommCare HQ for one corpus document, captured
 * from Nova's own client.
 *
 * The harness makes HQ's state A (and every later state) by applying the
 * request bodies Nova's publish sends, so those bodies come from production
 * code, not a copy of it:
 *
 * - the application JSON from `lib/deployment/importApplication.ts::hqImportApplication`,
 *   the assembly `publishAppToHq` calls: the empty shell a first publish
 *   creates, and every update;
 * - the project-space check from `lib/commcare/client.ts::probeHqProjectSpaceCompatibility`
 *   over `projectSpaceCompatibilityProbePlan`, whose report decides both
 *   whether Nova publishes at all and the derived Search profile key;
 * - the source reads from `readHqAppSource`, the lookup workbook from
 *   `uploadLookupTableWorkbook`, the imports from `importApp`, and the media
 *   upload after the content from `uploadAppMediaBundle` over
 *   `buildMediaBulkUploadZip` (`lib/deployment/service.ts::uploadMediaBytes`,
 *   sent whenever the prepared export carries media), each sent to a loopback
 *   peer (`./targetPeer.ts`) that answers as the configured project space
 *   does.
 *
 * What stands in for Nova's database is the Project state preflight reads
 * (`lib/deployment/preflight.ts::runDeploymentPreflight`):
 *
 * - the lookup data the export boundary
 *   (`lib/export/boundaryValidation.ts::prepareExportBoundary`) reads: the
 *   document's referenced tables, ordered by table id as
 *   `lib/lookup/definitionSnapshot.ts` reads them, each with its rows in the
 *   snapshot's stored order;
 * - the media rows it reads: one ready row per uploaded asset the corpus
 *   supplies, holding what Nova's upload stores for it (the accepted media
 *   type, its canonical extension, the SHA-256 and size of the bytes), and
 *   the built-in icons' rows from the shipped catalog;
 * - an organization with no places. Preflight pushes the live places Nova
 *   holds for the app (`lib/deployment/locationResourcePlan.ts::plannedPlacesFor`),
 *   so with none a capture sends no location request, and a document whose
 *   logic reads places is published to a project space that holds none;
 * - a ledger that records no identity override, so every id is the derived
 *   one (`lib/commcare/wireIdentity.ts::DERIVED_WIRE_IDENTITY`).
 *
 * A document Nova's export boundary refuses is not a corpus document: the
 * capture refuses it with the boundary's findings (`exportFindings`) before
 * anything is sent, since no project space would receive it.
 *
 * A publish is a first publish of D (state A) followed by one or more
 * updates over A: D again, or D′ after an edit batch. The first publish is
 * two imports, in the order `publishAppToHq` sends them: the empty shell
 * (`create`, no `app_id`), its source read, the lookup workbook, and the
 * update that fills it (`content`, naming a placeholder app id). Each later
 * update names the placeholder too. HQ mints A's id, so the harness writes
 * it into each update's `app_id` field (`proof/hq/operations.py::with_app_id`).
 * The peer answers every source read from what it holds of the app, and the
 * fields of that source an update's body depends on (`AssumedSource`) are an
 * assumption about HQ, so they are recorded beside the body for the HQ side
 * to hold against HQ's own `app_source` for A before it applies the update:
 * a difference means the captured update is not the one Nova would send
 * there.
 *
 * Each publish makes the reads Nova's drift check makes
 * (`lib/deployment/preflight.ts`, `service.ts`), and decides over them with
 * the same production functions: the table list and, for a table the last
 * publish pushed, its rows (`hqResourceBaseline.ts`), the source read
 * compared with the read back after the last import (`hqSourceBaseline.ts`),
 * the verdict over both (`remoteChanges.ts::decideRemoteChanges`), and the
 * name clash the push plan refuses (`lookupResourcePlan.ts`). After each
 * push it reads back what the ledger would record as the next baseline: each
 * pushed table's rows, and the app's source after its import. What the peer
 * answered for each table before the publish wrote anything is recorded
 * beside its body (`AssumedResources`) for the HQ side to hold to HQ's own
 * resources. A publish over a person's saves in HQ (`PublishInput.hqSide`)
 * does what the document states it does (`HqSideSaves.republish`): it goes
 * through untouched, or it stops as Nova's would and is sent again with what
 * that person confirms (`StopConfirmation`, recorded beside the body), or
 * Nova stops it with the code the document names. An outcome other than the
 * statement, and a stop anywhere else, ends the capture.
 *
 * No export draws an id: a publish derives its menu ids, form ids and
 * `xmlns` from the document, and a `.ccz` profile's `uniqueid` is derived
 * from the app's id and its project space. Given a corpus seed, each publish
 * step and each local export runs in its own seeded stream
 * (`./entropy.mts`), so a change that draws inside an export again writes
 * bytes that are a function of the emission's inputs: the
 * first publish at `OPERATION_ORDINALS.create`, the republish at
 * `OPERATION_ORDINALS.republish`, and each later update at its own
 * (`capturePublish`). undici draws a random multipart boundary per request,
 * so each captured body is re-framed with a fixed one (after checking the
 * re-framed body parses to the same fields), and a `.ccz` and a media
 * upload's ZIP are built with the clock fixed, because each archive stamps
 * its entries with the time (HQ reads a ZIP's names and bytes, never its
 * times: `hqmedia/tasks.py::process_bulk_upload_zip`).
 */

import { createHash } from "node:crypto";
import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import {
	type CommCareCredentials,
	importApp,
	probeHqProjectSpaceCompatibility,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc, type HqAppShell } from "@/lib/commcare/expander";
import { type HqAppSource, readHqAppSource } from "@/lib/commcare/hq/appSource";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
	readHqLookupTableRows,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import {
	buildHqJsonExportArchive,
	hqImportFileGuide,
} from "@/lib/commcare/multimedia/hqJsonExportArchive";
import {
	HQ_PRIVATE_FEATURE_FLAG_SYMBOLS,
	type HqPrivateFeatureFlagRequirement,
	type ProjectSpaceCompatibilityReport,
	projectSpaceCompatibilityProbePlan,
} from "@/lib/commcare/projectSpaceCompatibility";
import type { CommCareServer } from "@/lib/commcare/servers";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import { schemaPropertyDefault } from "@/lib/commcare/surface/schemaDefaults";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { attachmentUrlTarget } from "@/lib/deployment/attachmentTarget";
import {
	ABSENT_RESOURCE_DIGEST,
	canonicalLookupTable,
	type LookupChangePart,
	lookupDefinitionChange,
	lookupDefinitionDigest,
	lookupIdentityChange,
	lookupRowsChange,
} from "@/lib/deployment/hqResourceBaseline";
import {
	diffHqAppSource,
	normalizeHqAppSource,
} from "@/lib/deployment/hqSourceBaseline";
import { hqImportApplication } from "@/lib/deployment/importApplication";
import {
	type LookupTableConflict,
	planLookupResourcePush,
} from "@/lib/deployment/lookupResourcePlan";
import {
	boundedParts,
	decideRemoteChanges,
	describeAppChange,
	describeLookupChange,
} from "@/lib/deployment/remoteChanges";
import { chooseDownloadTarget } from "@/lib/deployment/runtimeTarget";
import type {
	AppOwnership,
	CanonicalLookupTable,
	DeploymentRemoteChange,
	DeploymentResource,
	RemoteChangeDiscard,
} from "@/lib/deployment/types";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	ASSET_SIZE_CAPS_BYTES,
	asMediaAssetId,
	assetKindForMimeType,
	EXTENSION_FOR_MIME_TYPE,
	gcsObjectKeyFor,
	type MediaKind,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import {
	type ExportMode,
	type PreparedExportBoundary,
	prepareExportBoundaryWithReads,
} from "@/lib/export/boundaryValidation";
import { compileLocalArchive } from "@/lib/export/localArchive";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupTableId,
} from "@/lib/lookup/types";
import {
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "@/lib/media/builtinIconAssets";
import { renderManualImportGuide } from "@/lib/publish/manualImportGuide";
import { CORPUS_COMMCARE_VERSION } from "./configurations";
import type { HqSideSaves } from "./documents";
import { hydrateAdmittedDocument } from "./editBatches";
import {
	type EntropyOperation,
	OPERATION_ORDINALS,
	seeded,
} from "./entropy.mts";
import {
	type PeerRequest,
	type TargetPeer,
	withTargetPeer,
} from "./targetPeer";

/** The CommCare server every capture targets; only its catalog origin reaches the bytes. */
export const PROOF_SERVER: CommCareServer = "production";

/** `proof/hq/configuration.py::DEFAULT_DOMAIN`. */
export const PROOF_DOMAIN = "nova-proof";

/** The Project a corpus document without lookup data belongs to. */
const PROOF_PROJECT = "proof-corpus";

/**
 * The app id the content import and every update name at capture, and the
 * app id a local archive's runtime URLs name. HQ mints the real one when it
 * applies the create; the harness writes that into each update's `app_id`
 * (`proof/hq/operations.py::with_app_id`) and into the archive's runtime
 * URLs (`proof/hq/operations.py::with_runtime_app_id`).
 */
export const PLACEHOLDER_APP_ID = "nova-proof-placeholder-app";

const CREDENTIALS: CommCareCredentials = {
	username: "nova-proof",
	apiKey: "nova-proof-key",
	server: PROOF_SERVER,
};

/**
 * The layout marker a capture writes in each import's sidecar: a first
 * publish captured as two imports, the shell's `create` and the `content`
 * update that fills it. A sidecar without the key is the legacy layout, a
 * first publish that is one create, which controls retained before the two
 * imports keep (`proof/checks/corpus.py::_captured`).
 */
export const TWO_IMPORT_LAYOUT = 2;

/**
 * The instant a `.ccz` is built at. AdmZip stamps each archive entry with
 * `new Date()`, written as a DOS date and time in the process's local zone;
 * with the clock fixed and the zone UTC (`atInstant`), two builds of one
 * document differ only in what Nova mints, wherever they run.
 */
export const CCZ_CLOCK = Date.UTC(2026, 0, 1);

// ── Inputs ───────────────────────────────────────────────────────────

/** One uploaded media asset, as the Project's media store holds it. */
export interface UploadedMedia {
	readonly kind: MediaKind;
	/** The accepted MIME type Nova's upload stores (`image/png`). */
	readonly mimeType: string;
	/** The canonical extension Nova's upload stores for that type (`.png`). */
	readonly extension: string;
	readonly bytes: Buffer;
}

/** One admitted document, with what Nova's publish reads beside it. */
export interface PublishDocument {
	/** Stable identity: the corpus source plus its sample index or name. */
	readonly id: string;
	/** The stored document; it must parse under the strict schema. */
	readonly doc: PersistableDoc;
	/** The Project's lookup data: every table the document may reference, with complete ordered rows. */
	readonly lookup?: LookupFixtureDataSnapshot;
	/** Every uploaded asset the document references, by asset id. Built-in icons need no entry. */
	readonly media?: ReadonlyMap<string, UploadedMedia>;
	/** The app's `mutation_seq`, which a `.ccz` stamps into its profile. */
	readonly compiledAtSeq: number;
}

/** The project space a capture publishes to. */
export interface PublishConfiguration {
	/** Names the configuration's output directory. */
	readonly id: string;
	/** Feature flags on for the project space, by symbol in `corehq/toggles/__init__.py`. */
	readonly flags: readonly string[];
	/** Whether case search is on for the project space (`CaseSearchConfig.enabled`). */
	readonly caseSearchEnabled: boolean;
	readonly domain: string;
}

// ── Nova's verdict for a document ───────────────────────────────────

export interface VerdictFlag {
	/** The flag's symbol in `corehq/toggles/__init__.py`. */
	readonly symbol: string;
	readonly slug: string;
}

/**
 * What Nova's publish requires of a project space for one document: the
 * capabilities `projectSpaceCompatibilityProbePlan` names, each with the
 * flags and runtime checks the probe makes, and the advisories, which never
 * block a publish. A configuration missing a required flag, or case search
 * where a capability's runtime check needs it, is one Nova refuses.
 */
export interface NovaPublishVerdict {
	readonly capabilities: readonly {
		readonly id: string;
		readonly flags: readonly VerdictFlag[];
		readonly runtimeProbes: readonly string[];
	}[];
	readonly advisories: readonly {
		readonly id: string;
		readonly flags: readonly VerdictFlag[];
	}[];
	/** The least a project space needs for Nova to publish the document. */
	readonly minimumConfiguration: {
		readonly flags: readonly string[];
		readonly caseSearchEnabled: boolean;
	};
}

/**
 * Each probed flag's HQ symbol and slug, from the gate entry of the toggle
 * behind the flag's id: the entry the probe read the slug from
 * (`projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`).
 */
function verdictFlags(
	flags: readonly HqPrivateFeatureFlagRequirement[],
): VerdictFlag[] {
	return flags.map((flag) => {
		const { symbol, slug } = domainFeatureFlag(
			HQ_PRIVATE_FEATURE_FLAG_SYMBOLS[flag.id],
		);
		return { symbol, slug };
	});
}

export function novaPublishVerdict(doc: BlueprintDoc): NovaPublishVerdict {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	const capabilities = plan.capabilities.map((item) => ({
		id: item.capability.id,
		flags: verdictFlags(item.featureFlags),
		runtimeProbes: [...item.runtimeProbes],
	}));
	return {
		capabilities,
		advisories: plan.advisories.map((item) => ({
			id: item.advisory.id,
			flags: verdictFlags(item.featureFlags),
		})),
		minimumConfiguration: {
			flags: [
				...new Set(
					capabilities.flatMap((item) => item.flags.map((flag) => flag.symbol)),
				),
			].sort(),
			caseSearchEnabled: capabilities.some((item) =>
				item.runtimeProbes.includes("case-search"),
			),
		},
	};
}

/** The least configuration under which Nova publishes every one of `verdicts`. */
export function minimumConfiguration(
	verdicts: readonly NovaPublishVerdict[],
	domain = PROOF_DOMAIN,
): PublishConfiguration {
	return {
		id: "minimum",
		flags: [
			...new Set(verdicts.flatMap((v) => v.minimumConfiguration.flags)),
		].sort(),
		caseSearchEnabled: verdicts.some(
			(v) => v.minimumConfiguration.caseSearchEnabled,
		),
		domain,
	};
}

// ── The Project state preflight reads ───────────────────────────────

/** The three exports a capture makes: the direct HQ upload, the `.ccz` download and the HQ import file. */
export type CaptureExportMode = Extract<
	ExportMode,
	"hq-upload" | "ccz" | "hq-json"
>;

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The Project the document's stored state belongs to. */
function projectOf(source: PublishDocument): string {
	return source.lookup?.projectId ?? PROOF_PROJECT;
}

/**
 * The requested tables, as the lookup reader returns them: definitions by
 * table id, each table's rows in the snapshot's (stored) order. A Project
 * that holds no lookup data reads as an empty snapshot at revision 0, as
 * the reader's Project clock does.
 */
function lookupFixtureData(
	source: PublishDocument,
	tableIds: readonly LookupTableId[],
): LookupFixtureDataSnapshot {
	if (tableIds.length > 0 && source.lookup === undefined) {
		throw new Error(
			`Corpus document ${source.id} references lookup tables, and it carries no Project lookup data. Give it the lookup snapshot it was admitted with.`,
		);
	}
	const wanted = new Set<string>(tableIds);
	const definitions = (source.lookup?.definitions ?? [])
		.filter((definition) => wanted.has(definition.id))
		.sort((left, right) => compareIds(left.id, right.id));
	const rowsByTable = new Map<LookupTableId, readonly LookupFixtureRow[]>();
	for (const definition of definitions) {
		rowsByTable.set(
			definition.id,
			source.lookup?.rowsByTable.get(definition.id) ?? [],
		);
	}
	return {
		projectId: projectOf(source),
		projectRevision: source.lookup?.projectRevision ?? parseLookupRevision("0"),
		definitions,
		rowsByTable,
	};
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Why Nova's media store never holds `asset` as given, or `undefined` when
 * it can. Nova's upload (`lib/media/validate.ts::validateMediaBytes`) stores
 * an accepted MIME type as written, the kind and canonical extension
 * `lib/domain/multimedia.ts` gives that type, and the bytes' SHA-256 and
 * size, within the kind's size cap.
 */
export function uploadedMediaProblem(asset: UploadedMedia): string | undefined {
	const mimeType = normalizeMimeType(asset.mimeType);
	if (mimeType === undefined || mimeType !== asset.mimeType) {
		return `its type ${JSON.stringify(asset.mimeType)} is not an accepted type as Nova writes it`;
	}
	const kind = assetKindForMimeType(mimeType);
	if (kind !== asset.kind) {
		return `its kind is ${JSON.stringify(asset.kind)}, where Nova stores ${mimeType} as ${kind}`;
	}
	const extension = EXTENSION_FOR_MIME_TYPE[mimeType];
	if (extension !== asset.extension) {
		return `its extension is ${JSON.stringify(asset.extension)}, where Nova stores ${mimeType} as ${JSON.stringify(extension)}`;
	}
	const cap = ASSET_SIZE_CAPS_BYTES[asset.kind];
	if (asset.bytes.length === 0 || asset.bytes.length > cap) {
		return `it holds ${asset.bytes.length} bytes, where a ${asset.kind} upload holds 1 to ${cap}`;
	}
	return undefined;
}

/** The ready row Nova's media store holds for one uploaded asset. */
function mediaRow(
	source: PublishDocument,
	assetId: string,
	asset: UploadedMedia,
): MediaAssetRecord {
	const problem = uploadedMediaProblem(asset);
	const mimeType = normalizeMimeType(asset.mimeType);
	if (problem !== undefined || mimeType === undefined) {
		throw new Error(
			`Corpus document ${source.id}'s media asset ${assetId} is not one Nova's upload stores: ${problem}. Give it the kind, type and extension Nova's upload records for its bytes.`,
		);
	}
	const projectId = projectOf(source);
	const contentHash = sha256(asset.bytes);
	return {
		id: asMediaAssetId(assetId),
		project_id: projectId,
		owner: PROOF_PROJECT,
		contentHash,
		mimeType,
		extension: asset.extension,
		sizeBytes: asset.bytes.length,
		kind: asset.kind,
		gcsObjectKey: gcsObjectKeyFor(projectId, contentHash, asset.extension),
		originalFilename: `${assetId}${asset.extension}`,
		status: "ready",
		created_at: new Date(0),
	};
}

/**
 * The rows the media store holds for the requested uploaded assets: every
 * asset the document references must be supplied, since a publish reads
 * the Project's own uploads.
 */
function mediaRows(
	source: PublishDocument,
	ids: readonly string[],
): MediaAssetRecord[] {
	return ids.map((id) => {
		const asset = source.media?.get(id);
		if (asset === undefined) {
			throw new Error(
				`Corpus document ${source.id} references the uploaded media asset ${id}, and its media holds no bytes for it. Give the document every uploaded asset it references.`,
			);
		}
		return mediaRow(source, id, asset);
	});
}

/**
 * The media manifest with bytes, as `lib/media/manifest.ts::resolveMediaManifest`
 * resolves it from the ready rows: each uploaded asset by its content hash
 * and extension, then the built-in icons from the shipped catalog.
 */
async function mediaManifest(
	source: PublishDocument,
	doc: BlueprintDoc,
): Promise<AssetManifest> {
	const { realIds, builtinSlugs } = partitionAssetRefs([
		...collectAssetRefs(doc),
	]);
	const manifest = new Map<ResolvedMediaAsset["assetId"], ResolvedMediaAsset>();
	for (const row of mediaRows(source, realIds)) {
		const asset = source.media?.get(row.id);
		if (asset === undefined) continue;
		manifest.set(row.id, {
			assetId: row.id,
			wirePath: wirePathFor(row.contentHash, row.extension),
			kind: asset.kind,
			mimeType: row.mimeType,
			contentHash: row.contentHash,
			extension: row.extension,
			bytes: asset.bytes,
		});
	}
	for (const [id, asset] of await resolveBuiltinManifestEntries(
		builtinSlugs,
		true,
	)) {
		manifest.set(id, asset);
	}
	return manifest;
}

// ── The export boundary ─────────────────────────────────────────────

/** A document Nova's export boundary refuses, whatever the project space. */
export class UnexportableDocumentError extends Error {
	constructor(
		readonly documentId: string,
		readonly mode: CaptureExportMode,
		readonly findings: readonly ValidationError[],
	) {
		const reasons = findings
			.map((finding) => `${finding.code}: ${finding.message}`)
			.join(" ");
		super(
			mode === "hq-upload"
				? `Nova's publish refuses corpus document ${documentId} before it sends anything (${reasons}), so no project space would receive it. Fix the document or the Project data it carries.`
				: mode === "ccz"
					? `Nova's compile route refuses to build corpus document ${documentId} (${reasons}), so no device would receive it. Fix the document or the Project data it carries.`
					: `Nova's compile route refuses to build the HQ import file of corpus document ${documentId} (${reasons}), so no one could import it. Fix the document or the Project data it carries.`,
		);
		this.name = "UnexportableDocumentError";
	}
}

/** A document the boundary prepared for one export. */
interface PreparedDocument {
	readonly source: PublishDocument;
	readonly export: PreparedExportBoundary;
}

/**
 * The export boundary's own verdict and prepared export
 * (`lib/export/boundaryValidation.ts::prepareExportBoundaryWithReads`) for
 * the document, over its stored state, as preflight's `hq-upload` or the
 * compile route's `ccz` asks for it. A document that is not admitted at
 * all throws.
 */
function exportBoundary(
	source: PublishDocument,
	mode: CaptureExportMode,
	attachmentTarget: AttachmentUrlTarget | null,
) {
	const doc = hydrateAdmittedDocument({
		id: source.id,
		doc: source.doc,
		...(source.lookup !== undefined && { lookup: source.lookup }),
	});
	return prepareExportBoundaryWithReads(
		{
			mode,
			access: {
				projectId: projectOf(source),
				role: "editor",
				actorUserId: PROOF_PROJECT,
			},
			doc,
			compiledAtSeq: source.compiledAtSeq,
			attachmentTarget,
		},
		{
			lookupFixtureData: async (_scope, tableIds) =>
				lookupFixtureData(source, tableIds),
			mediaRows: async (ids) => mediaRows(source, ids),
			mediaManifest: (manifestDoc) => mediaManifest(source, manifestDoc),
		},
	);
}

/**
 * The findings Nova's export boundary returns for the document over its
 * stored state, for a direct HQ upload or a `.ccz` download: empty when Nova
 * exports it.
 */
export async function exportFindings(
	source: PublishDocument,
	mode: CaptureExportMode,
): Promise<readonly ValidationError[]> {
	const result = await exportBoundary(source, mode, null);
	return result.ok ? [] : result.violations;
}

async function prepareDocument(
	source: PublishDocument,
	mode: CaptureExportMode,
	attachmentTarget: AttachmentUrlTarget | null,
): Promise<PreparedDocument> {
	const result = await exportBoundary(source, mode, attachmentTarget);
	if (!result.ok) {
		throw new UnexportableDocumentError(source.id, mode, result.violations);
	}
	return { source, export: result.prepared };
}

// ── Captured requests ────────────────────────────────────────────────

/** The multipart boundary every captured body is framed with. */
export const CAPTURE_BOUNDARY = "----nova-proof-capture";

/** One request Nova's client sent, re-framed with a fixed multipart boundary. */
export interface CapturedRequest {
	readonly method: string;
	readonly path: string;
	readonly contentType: string;
	readonly body: Buffer;
	/** The multipart field names, in order. */
	readonly fields: readonly string[];
}

function multipartBoundary(contentType: string): string {
	const [mediaType, ...parameters] = contentType.split(";");
	const boundary = parameters
		.map((parameter) => parameter.trim())
		.find((parameter) => parameter.startsWith("boundary="))
		?.slice("boundary=".length);
	if (mediaType?.trim() !== "multipart/form-data" || !boundary) {
		throw new Error(
			`Nova's client sent a body of type ${contentType}, and the capture reads only multipart/form-data with a boundary.`,
		);
	}
	return boundary;
}

async function formEntries(body: Buffer, contentType: string) {
	const form = await new Response(new Uint8Array(body), {
		headers: { "content-type": contentType },
	}).formData();
	return Promise.all(
		[...form.entries()].map(async ([name, value]) =>
			typeof value === "string"
				? { name, value }
				: {
						name,
						filename: value.name,
						type: value.type,
						bytes: Buffer.from(await value.arrayBuffer()),
					},
		),
	);
}

/**
 * Re-frame a multipart body with the fixed boundary. Every occurrence of the
 * sent boundary must be a delimiter (at the start of the body or after a
 * line break), and the fixed boundary must not occur in the body; the result
 * is parsed back and must hold the same fields, names, file names, types and
 * bytes as the body as sent.
 */
async function reframed(request: PeerRequest): Promise<CapturedRequest> {
	const sentType = request.contentType ?? "";
	const sent = multipartBoundary(sentType);
	let fixed = CAPTURE_BOUNDARY;
	for (let n = 1; request.body.includes(fixed); n += 1) {
		fixed = `${CAPTURE_BOUNDARY}-${n}`;
	}
	const delimiter = Buffer.from(`--${sent}`);
	const replacement = Buffer.from(`--${fixed}`);
	const pieces: Buffer[] = [];
	let from = 0;
	for (
		let at = request.body.indexOf(delimiter);
		at !== -1;
		at = request.body.indexOf(delimiter, at + delimiter.length)
	) {
		if (at !== 0 && request.body.subarray(at - 2, at).toString() !== "\r\n") {
			throw new Error(
				`The body Nova's client sent to ${request.path} holds its multipart boundary inside a part, so the capture cannot re-frame it.`,
			);
		}
		pieces.push(request.body.subarray(from, at), replacement);
		from = at + delimiter.length;
	}
	pieces.push(request.body.subarray(from));
	const body = Buffer.concat(pieces);
	const contentType = `multipart/form-data; boundary=${fixed}`;
	const before = await formEntries(request.body, sentType);
	const after = await formEntries(body, contentType);
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		throw new Error(
			`Re-framing the body Nova's client sent to ${request.path} changed what it parses to, so the capture would not be the request Nova sent.`,
		);
	}
	return {
		method: request.method,
		path: request.path,
		contentType,
		body,
		fields: after.map((entry) => entry.name),
	};
}

// ── The publish steps ────────────────────────────────────────────────

/** The compatibility report's outcome, without the report's prose. */
export interface CompatibilityOutcome {
	readonly status: ProjectSpaceCompatibilityReport["status"];
	readonly capabilities: readonly {
		readonly id: string;
		readonly state: string;
	}[];
	readonly advisories: readonly {
		readonly id: string;
		readonly state: string;
	}[];
}

function compatibilityOutcome(
	report: ProjectSpaceCompatibilityReport,
): CompatibilityOutcome {
	return {
		status: report.status,
		capabilities: report.required_capabilities.map(({ id, state }) => ({
			id,
			state,
		})),
		advisories: report.advisories.map(({ id, state }) => ({ id, state })),
	};
}

/**
 * The fields of HQ's app source a captured import depends on, each by its
 * path in the source HQ serves (`app_manager/views/apps.py::app_source`).
 * Nova's import accepts a read only of an `Application` with a CommCare
 * version (`readHqAppSource`), and projects an update's `profile`,
 * `translations` and `add_ons` over the read's (`lib/commcare/targetOverlay.ts`,
 * which reads `langs` for the language names), so these are what the peer
 * answered the read the import was built on with. `auto_gps_capture` is read
 * by no body: it is held because the peer applies a person's saves to it
 * (`./targetPeer.ts::applyHqSide`), and holding it proves that model. The HQ
 * side holds each to HQ's own read before it applies the import
 * (`proof/observe/publish.py::update`, `proof/hq/operations.py::publish_capture`).
 */
export interface AssumedSource {
	readonly doc_type: "Application";
	readonly "build_spec.version": string;
	readonly profile: HqApplicationProfile;
	readonly translations: HqAppSource["translations"];
	readonly add_ons: HqAppSource["addOns"];
	readonly langs: HqAppSource["langs"];
	readonly auto_gps_capture: boolean;
}

/** The fields of `source` a captured import depends on. */
function assumedSourceOf(source: HqAppSource): AssumedSource {
	const autoGpsCapture = source.raw.auto_gps_capture;
	if (typeof autoGpsCapture !== "boolean") {
		throw new Error(
			`The capture peer served an app source whose auto_gps_capture is ${JSON.stringify(autoGpsCapture)}; HQ serves the setting as a boolean for every app (Application.auto_gps_capture).`,
		);
	}
	return {
		doc_type: source.docType,
		"build_spec.version": source.buildSpecVersion,
		profile: source.profile,
		translations: source.translations,
		add_ons: source.addOns,
		langs: source.langs,
		auto_gps_capture: autoGpsCapture,
	};
}

/** One field of a lookup table's definition, as `LookupTableResource` serves it. */
interface ServedTableField {
	readonly field_name: string;
	readonly properties: readonly string[];
}

/**
 * What the peer answered for one lookup table a publish pushes, before the
 * publish wrote anything: the definition HQ held under its tag
 * (`fixtures/resources/v0_1.py::LookupTableResource`, without the id HQ
 * mints), or null where it held none, and, where the publish read them to
 * compare, the table's rows in order (`FixtureResource`, each row's
 * `fields` alone). These decide whether Nova pushes and what it compares,
 * so the HQ side holds each to HQ's own answer before it applies the
 * capture (`proof/hq/operations.py::hold_assumed_resources`).
 */
export interface AssumedLookupTable {
	readonly tag: string;
	readonly table: {
		readonly is_global: boolean;
		readonly fields: readonly ServedTableField[];
		readonly item_attributes: readonly string[];
	} | null;
	readonly rows?: readonly {
		readonly fields: Readonly<
			Record<
				string,
				| string
				| {
						readonly field_list: readonly {
							readonly field_value: string;
							readonly properties: Readonly<Record<string, string>>;
						}[];
				  }
			>
		>;
	}[];
}

/** What the peer answered for the project space's resources before a publish wrote anything. */
export interface AssumedResources {
	readonly lookupTables: readonly AssumedLookupTable[];
}

function servedDefinition(table: HqLookupTable): AssumedLookupTable["table"] {
	return {
		is_global: table.isGlobal,
		fields: table.fields.map((name) => ({
			field_name: name,
			properties: table.fieldProperties[name] ?? [],
		})),
		item_attributes: table.itemAttributes,
	};
}

/** A row's fields in the shape `FixtureResource.dehydrate_fields` served them. */
function servedRow(
	row: HqFixtureRow,
): NonNullable<AssumedLookupTable["rows"]>[number] {
	return {
		fields: Object.fromEntries(
			Object.entries(row.fields).map(([name, value]) => [
				name,
				typeof value === "string"
					? value
					: {
							field_list: value.map((item) => ({
								field_value: item.value,
								properties: item.properties,
							})),
						},
			]),
		),
	};
}

/**
 * What the capture holds of what Nova's ledger would after a publish: the
 * app's baseline (HQ's read after Nova's last write, normalized, with the
 * ownership of the body that write sent) and each pushed table's mapping
 * and baseline (`lib/deployment/store.ts`). A later publish compares HQ's
 * reads with these, as preflight compares them with the stored rows.
 */
interface CaptureLedger {
	readonly app: HeldRead;
	readonly tables: ReadonlyMap<LookupTableId, LedgerTable>;
}

/** A read of the app the publish holds, normalized, and how a later read is compared with it. */
interface HeldRead {
	readonly normalized: unknown;
	/** The ownership of the body the write before the read sent. */
	readonly ownership: AppOwnership;
	/** `create` while the app is the shell the first publish made. */
	readonly origin: "create" | "push";
}

/** One pushed table's mapping and the baseline read after the push. */
interface LedgerTable {
	readonly tag: string;
	readonly remoteId: string;
	readonly canonical: CanonicalLookupTable;
}

/** A source read normalized as a baseline is (`normalizeHqAppSource`); a read that does not normalize stops the capture. */
function normalizedRead(
	prepared: PreparedDocument,
	source: HqAppSource,
): { readonly normalized: unknown; readonly digest: string } {
	const result = normalizeHqAppSource(source.raw);
	if ("malformed" in result) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} read a source from the capture peer that is not an app's (${result.malformed}), so it would not have compared it.`,
		);
	}
	return result;
}

/** The requests one import sends: the workbook before it, the import, and the media after it. */
export interface SentImport {
	/** The lookup workbook upload, when the document references a table. */
	readonly lookup?: CapturedRequest;
	readonly importApp: CapturedRequest;
	/** The media upload after the import, when the export carries media. */
	readonly media?: CapturedRequest;
	/** The application JSON the import carried. */
	readonly application: HqApplication;
	/** The overlay keys the application writes (`hqImportApplication`'s `ownership`). */
	readonly ownership: AppOwnership;
	/** The fields of the source read the import was built on. */
	readonly assumedSource: AssumedSource;
	/** What the peer answered for the tables the publish pushes, when it pushes any. */
	readonly assumedResources?: AssumedResources;
}

/**
 * Why Nova's preflight stopped a publish over what CommCare HQ holds: the
 * changes made there since Nova's last publish (`hq_changed`), or tables
 * under Nova's tags that Nova cannot account for (`hq_resource_conflict`).
 */
export interface PublishStop {
	readonly code: "hq_changed" | "hq_resource_conflict";
	readonly remoteChanges: readonly DeploymentRemoteChange[];
	/** The tables in conflict, by Nova's table id, with their tag and HQ's id. */
	readonly conflicts: readonly LookupTableConflict[];
}

/**
 * What a person confirmed to send a stopped publish again, as the publish
 * dialog sends it: each change to write over with the digest a stop showed
 * (`discardRemoteChanges`), and each table to take over
 * (`adoptResourceIds`). Preflight stops at the first edge that refuses, so a
 * table in conflict is listed before any change, and `stops` holds each
 * stop the publish met, in order, before the send that went through.
 */
export interface StopConfirmation {
	readonly stops: readonly PublishStop[];
	readonly discards: readonly RemoteChangeDiscard[];
	readonly adopted: readonly string[];
}

/** One update of a document: refused by Nova's check, stopped by its preflight, or what it sent. */
export type StepOutcome =
	| {
			readonly status: "refused";
			readonly compatibility: CompatibilityOutcome;
	  }
	| ({ readonly status: "stopped" } & PublishStop)
	| ({
			readonly status: "sent";
			readonly compatibility: CompatibilityOutcome;
			/** Every request the step sent, `<method> <path>`, in the order it sent them. */
			readonly sequence: readonly string[];
			/** The stop this publish was sent through, and what the resend confirmed. */
			readonly confirmed?: StopConfirmation;
	  } & SentImport);

/** A first publish: refused by Nova's check, or the shell's create and the content's update it sent. */
export type FirstPublishOutcome =
	| {
			readonly status: "refused";
			readonly compatibility: CompatibilityOutcome;
	  }
	| {
			readonly status: "sent";
			readonly compatibility: CompatibilityOutcome;
			/** The shell's create, which names no app and pushes nothing before it. */
			readonly create: {
				readonly importApp: CapturedRequest;
				readonly application: HqAppShell;
				/** The overlay keys the shell writes (`hqImportApplication`'s `ownership`). */
				readonly ownership: AppOwnership;
			};
			/** The update that fills the shell: state A's app. */
			readonly content: SentImport;
			/** Every request the first publish sent, `<method> <path>`, in the order it sent them. */
			readonly sequence: readonly string[];
	  };

function takeRequest(
	requests: readonly PeerRequest[],
	method: string,
	path: string,
): PeerRequest {
	const matching = requests.filter(
		(request) => request.method === method && request.path === path,
	);
	if (matching.length !== 1 || matching[0] === undefined) {
		throw new Error(
			`The capture expected Nova's client to send one ${method} ${path} in this step of the publish, and it sent ${matching.length}.`,
		);
	}
	return matching[0];
}

/** Each request, `<method> <path>`, in order. */
function sequenceOf(requests: readonly PeerRequest[]): string[] {
	return requests.map((request) => `${request.method} ${request.path}`);
}

/**
 * The compatibility check `publishAppToHq`'s preflight makes before any
 * write, with its read of the target's empty-list text flag, which never
 * changes the report.
 */
async function compatibilityCheck(
	peer: TargetPeer,
	prepared: PreparedDocument,
) {
	const probe = await probeHqProjectSpaceCompatibility(
		CREDENTIALS,
		peer.state.domain,
		projectSpaceCompatibilityProbePlan(prepared.export.doc),
		{ readEmptyCaseListText: true },
	);
	return { report: probe.report, outcome: compatibilityOutcome(probe.report) };
}

/** A source read of the app, as Nova's publish makes it; any answer but a source stops the capture. */
async function readSource(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appId: string,
): Promise<HqAppSource> {
	const read = await readHqAppSource(CREDENTIALS, peer.state.domain, appId);
	if ("success" in read || read.kind !== "source") {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the app's source from the capture peer (${JSON.stringify(read)}), so it would not have sent the app's content.`,
		);
	}
	return read.source;
}

/** The table list read; any refusal stops the capture, since Nova would not push. */
async function readTables(
	peer: TargetPeer,
	prepared: PreparedDocument,
): Promise<readonly HqLookupTable[]> {
	const tables = await listHqLookupTables(CREDENTIALS, peer.state.domain);
	if ("success" in tables) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the lookup tables from the capture peer (status ${tables.status}), so it would not have pushed them.`,
		);
	}
	return tables;
}

/** One table's rows read; any refusal stops the capture, since Nova's preflight would stop. */
async function readRows(
	peer: TargetPeer,
	prepared: PreparedDocument,
	tableId: string,
) {
	const rows = await readHqLookupTableRows(
		CREDENTIALS,
		peer.state.domain,
		tableId,
	);
	if ("success" in rows) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the rows of the lookup table ${tableId} from the capture peer (status ${rows.status}).`,
		);
	}
	return rows;
}

/** The author's name for each table the export carries, as preflight names a table in a change. */
function tableName(prepared: PreparedDocument, tableId: LookupTableId): string {
	return (
		prepared.export.lookupSnapshot.definitions.find(
			(definition) => definition.id === tableId,
		)?.name ?? tableId
	);
}

/**
 * Preflight's `project-data` edge over the peer, as
 * `lib/deployment/preflight.ts` runs it: the table list, the push plan
 * (`planLookupResourcePush`) over the tables the ledger maps, and for each
 * table the plan compares, where it is, then its definition, then its rows
 * (`hqResourceBaseline.ts`), the rows read only while the definition is
 * unchanged. Returns the plan's conflicts, or the changes it collected and
 * what the peer answered for each table the publish pushes.
 */
async function tableEdge(
	peer: TargetPeer,
	prepared: PreparedDocument,
	ledger: CaptureLedger | null,
	adopt: readonly string[],
): Promise<
	| { readonly conflicts: readonly LookupTableConflict[] }
	| {
			readonly observed: readonly DeploymentRemoteChange[];
			readonly assumed: AssumedResources;
	  }
	| null
> {
	const workbook = prepared.export.lookupWorkbook;
	if (workbook === undefined) return null;
	const hqTables = await readTables(peer, prepared);
	const mappings = [...(ledger?.tables ?? new Map()).entries()].map(
		([tableId, mapped]): DeploymentResource => ({
			deploymentId: "capture",
			kind: "lookup-table",
			novaResourceId: tableId,
			remoteId: mapped.remoteId,
			ownership: "nova-created",
			pushedIdentity: mapped.tag,
			adoptedAt: null,
			adoptedBy: null,
			pushedRevision: prepared.source.compiledAtSeq,
			pushedAt: null,
			pushToken: "capture",
			remoteRevision: null,
			remoteObservedAt: null,
			supersededAt: null,
			remoteMissingAt: null,
		}),
	);
	const plan = planLookupResourcePush({
		tables: workbook.tables,
		mappings,
		hqTables,
		adoptTableIds: adopt,
	});
	if (!plan.ok) return { conflicts: plan.conflicts };
	const observed: DeploymentRemoteChange[] = [];
	const rowsRead = new Map<string, readonly HqFixtureRow[]>();
	for (const push of plan.pushes) {
		const mapped = ledger?.tables.get(push.tableId);
		if (push.mappedRemoteId === null || mapped === undefined) continue;
		const change = (
			parts: readonly string[],
			observedDigest: string,
		): DeploymentRemoteChange => ({
			kind: "lookup-table",
			novaResourceId: push.tableId,
			name: tableName(prepared, push.tableId),
			identity: push.tag,
			parts,
			note: null,
			observedDigest,
			baselineKnown: true,
		});
		const describe = (part: LookupChangePart) =>
			describeLookupChange(part, push.tag);
		const moved = lookupIdentityChange({
			mappedRemoteId: push.mappedRemoteId,
			tag: push.tag,
			tables: hqTables,
		});
		if (moved?.kind === "deleted") {
			observed.push(change([describe(moved)], ABSENT_RESOURCE_DIGEST));
			continue;
		}
		const current = hqTables.find((table) =>
			moved?.kind === "renamed"
				? table.id === push.mappedRemoteId
				: table.tag === push.tag,
		);
		if (current === undefined) {
			throw new Error(
				`The lookup table ${push.mappedRemoteId} the capture compared is not in the list it read.`,
			);
		}
		if (moved?.kind === "renamed") {
			observed.push(change([describe(moved)], lookupDefinitionDigest(current)));
			continue;
		}
		const definition = lookupDefinitionChange(mapped.canonical, current);
		if (definition.length > 0) {
			observed.push(
				change(definition.map(describe), lookupDefinitionDigest(current)),
			);
			continue;
		}
		const rows = await readRows(peer, prepared, current.id);
		rowsRead.set(push.tag, rows.rows);
		const changed = lookupRowsChange(mapped.canonical, rows);
		if (changed.length > 0) {
			observed.push(
				change(
					changed.map(describe),
					canonicalLookupTable(current, rows.rows).digest,
				),
			);
		}
	}
	return {
		observed,
		assumed: {
			lookupTables: workbook.tables.map((table) => {
				const held = hqTables.find((remote) => remote.tag === table.tag);
				const rows = rowsRead.get(table.tag);
				return {
					tag: table.tag,
					table: held === undefined ? null : servedDefinition(held),
					...(rows !== undefined && { rows: rows.map(servedRow) }),
				};
			}),
		},
	};
}

/**
 * Preflight's app comparison over the peer (`preflight.ts`, the `target-app`
 * edge): HQ's read against the ledger's baseline under the baseline's
 * ownership, read as a shell while the baseline is the shell's. The change
 * names the whole normalized read's digest.
 */
function appEdge(
	prepared: PreparedDocument,
	appName: string,
	ledger: CaptureLedger,
	current: { readonly normalized: unknown; readonly digest: string },
): DeploymentRemoteChange | null {
	const parts = diffHqAppSource({
		baseline: ledger.app.normalized,
		current: current.normalized,
		ownership: ledger.app.ownership,
		shell: ledger.app.origin === "create",
		schemaDefault: schemaPropertyDefault,
	});
	if (parts.length === 0) return null;
	return {
		kind: "app",
		novaResourceId: prepared.source.id,
		name: appName,
		identity: PLACEHOLDER_APP_ID,
		parts: boundedParts(parts.map(describeAppChange)),
		note: null,
		observedDigest: current.digest,
		baselineKnown: true,
	};
}

/**
 * The resource push and the import of the app's content, as `publishAppToHq`
 * makes them once the app exists and `read` is its last read: the lookup
 * workbook, then the re-list and each pushed table's rows read the ledger
 * records as its baseline (`service.ts::pushLookupTables`); then a second
 * source read (the push took time, and HQ may have changed the app), held
 * to the read this publish holds (`held`) by the drift comparison, which
 * must find nothing; then the import of the assembled application as an
 * update of `appId`, the source read back as the app's next baseline, and,
 * when the export carries media, the media upload to the app the import
 * answered with (`service.ts::uploadMediaBytes`: one ZIP of every asset,
 * then the status reads, which change nothing in HQ and are not captured).
 */
async function sendContent(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
	report: ProjectSpaceCompatibilityReport,
	appId: string,
	read: HqAppSource,
	held: HeldRead,
	assumedResources: AssumedResources | undefined,
): Promise<{ readonly sent: SentImport; readonly ledger: CaptureLedger }> {
	const domain = peer.state.domain;
	const target = { server: PROOF_SERVER, domain };
	const mark = peer.requests.length;
	let source = read;
	const tables = new Map<LookupTableId, LedgerTable>();
	const workbook = prepared.export.lookupWorkbook;
	if (workbook !== undefined) {
		const pushed = await uploadLookupTableWorkbook(
			CREDENTIALS,
			domain,
			workbook.bytes,
			{ replace: true },
		);
		if (!pushed.success) {
			throw new Error(
				`The capture peer refused the lookup workbook of ${prepared.source.id} (status ${pushed.status}), which it accepts from every publish.`,
			);
		}
		const relisted = await readTables(peer, prepared);
		for (const table of workbook.tables) {
			const landed = relisted.find((remote) => remote.tag === table.tag);
			if (landed === undefined) {
				throw new Error(
					`The capture peer holds no table under ${table.tag} after the push that sent it.`,
				);
			}
			const rows = await readRows(peer, prepared, landed.id);
			tables.set(table.tableId, {
				tag: table.tag,
				remoteId: landed.id,
				canonical: canonicalLookupTable(landed, rows.rows),
			});
		}
		source = await readSource(peer, prepared, appId);
		const moved = diffHqAppSource({
			baseline: held.normalized,
			current: normalizedRead(prepared, source).normalized,
			ownership: held.ownership,
			shell: held.origin === "create",
			schemaDefault: schemaPropertyDefault,
		});
		if (moved.length > 0) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would stop at its second source read: the app moved in the capture peer while its tables were pushed (${JSON.stringify(moved)}), and nothing moves it there.`,
			);
		}
	}
	const { application, ownership } = hqImportApplication({
		prepared: prepared.export,
		target,
		compatibility: report,
		update: { appId, source },
		identity: DERIVED_WIRE_IDENTITY,
	});
	const imported = await importApp(
		CREDENTIALS,
		domain,
		appName,
		application,
		appId,
	);
	if (!imported.success) {
		throw new Error(
			`The capture peer refused the import of ${prepared.source.id} (status ${imported.status}), which it accepts from every publish.`,
		);
	}
	const readBack = normalizedRead(
		prepared,
		await readSource(peer, prepared, imported.appId),
	);
	const carriesMedia = prepared.export.assets.size > 0;
	if (carriesMedia) {
		const uploaded = await uploadAppMediaBundle(
			CREDENTIALS,
			domain,
			imported.appId,
			atInstant(CCZ_CLOCK, () =>
				buildMediaBulkUploadZip(prepared.export.assets),
			),
		);
		if ("success" in uploaded || uploaded.timedOut) {
			throw new Error(
				`The capture peer did not confirm the media upload of ${prepared.source.id} (${JSON.stringify(uploaded)}), which it accepts from every publish.`,
			);
		}
	}
	const sent = peer.since(mark);
	return {
		sent: {
			...(workbook !== undefined && {
				lookup: await reframed(
					takeRequest(sent, "POST", `/a/${domain}/fixtures/fixapi/`),
				),
			}),
			importApp: await reframed(
				takeRequest(sent, "POST", `/a/${domain}/apps/api/import_app/`),
			),
			...(carriesMedia && {
				media: await reframed(
					takeRequest(
						sent,
						"POST",
						`/a/${domain}/apps/api/${imported.appId}/multimedia/`,
					),
				),
			}),
			application,
			ownership,
			assumedSource: assumedSourceOf(source),
			...(assumedResources !== undefined && { assumedResources }),
		},
		ledger: {
			app: { normalized: readBack.normalized, ownership, origin: "push" },
			tables,
		},
	};
}

/**
 * A first publish as `publishAppToHq` makes it once its target is
 * reachable: preflight's table list where the app pushes tables (no table is
 * mapped yet, so nothing is compared), the compatibility check (a blocked
 * report stops the publish before any write), the empty shell's create, the
 * source read of the app it made, which the ledger records as the shell's
 * baseline, then the app's content (`sendContent`). The shell is created
 * before any Project data is pushed, and holds nothing that reads it.
 */
async function firstPublish(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
): Promise<
	| { readonly outcome: Extract<FirstPublishOutcome, { status: "refused" }> }
	| {
			readonly outcome: Extract<FirstPublishOutcome, { status: "sent" }>;
			readonly ledger: CaptureLedger;
	  }
> {
	const domain = peer.state.domain;
	const start = peer.requests.length;
	const edge = await tableEdge(peer, prepared, null, []);
	if (edge !== null && "conflicts" in edge) {
		throw new Error(
			`Nova's first publish of ${prepared.source.id} found lookup tables it cannot account for in the capture peer (${JSON.stringify(edge.conflicts)}), which holds none before it.`,
		);
	}
	const { report, outcome } = await compatibilityCheck(peer, prepared);
	if (report.status === "blocked") {
		return { outcome: { status: "refused", compatibility: outcome } };
	}
	const mark = peer.requests.length;
	const shell = hqImportApplication({
		prepared: prepared.export,
		target: { server: PROOF_SERVER, domain },
		compatibility: report,
		update: null,
		identity: DERIVED_WIRE_IDENTITY,
	});
	const created = await importApp(
		CREDENTIALS,
		domain,
		appName,
		shell.application,
	);
	if (!created.success) {
		throw new Error(
			`The capture peer refused the shell create of ${prepared.source.id} (status ${created.status}), which it accepts from every publish.`,
		);
	}
	const createRequest = takeRequest(
		peer.since(mark),
		"POST",
		`/a/${domain}/apps/api/import_app/`,
	);
	const read = await readSource(peer, prepared, created.appId);
	const { sent: content, ledger } = await sendContent(
		peer,
		prepared,
		appName,
		report,
		created.appId,
		read,
		{
			normalized: normalizedRead(prepared, read).normalized,
			ownership: shell.ownership,
			origin: "create",
		},
		edge?.assumed,
	);
	return {
		outcome: {
			status: "sent",
			compatibility: outcome,
			create: {
				importApp: await reframed(createRequest),
				application: shell.application,
				ownership: shell.ownership,
			},
			content,
			sequence: sequenceOf(peer.since(start)),
		},
		ledger,
	};
}

/**
 * A later publish as `publishAppToHq` makes it over an app it reached:
 * preflight's table edge (`tableEdge`), the compatibility check, the
 * `target-app` source read and its comparison with the ledger's baseline
 * (`appEdge`), the verdict over every change collected
 * (`remoteChanges.ts::decideRemoteChanges`, under what `confirm` names),
 * then the app's content (`sendContent`). A conflict or a change nobody
 * confirmed stops it before any write, as preflight's `hq_resource_conflict`
 * and `hq_changed` do.
 */
async function updateStep(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
	ledger: CaptureLedger,
	confirm: StopConfirmation | undefined,
): Promise<StepOutcome> {
	const start = peer.requests.length;
	const edge = await tableEdge(peer, prepared, ledger, confirm?.adopted ?? []);
	if (edge !== null && "conflicts" in edge) {
		return {
			status: "stopped",
			code: "hq_resource_conflict",
			remoteChanges: [],
			conflicts: edge.conflicts,
		};
	}
	const { report, outcome } = await compatibilityCheck(peer, prepared);
	if (report.status === "blocked") {
		return { status: "refused", compatibility: outcome };
	}
	const read = await readSource(peer, prepared, PLACEHOLDER_APP_ID);
	const current = normalizedRead(prepared, read);
	const app = appEdge(prepared, appName, ledger, current);
	const verdict = decideRemoteChanges({
		observed: [...(app === null ? [] : [app]), ...(edge?.observed ?? [])],
		discards: confirm?.discards ?? [],
	});
	if (!verdict.proceed) {
		return {
			status: "stopped",
			code: "hq_changed",
			remoteChanges: verdict.remoteChanges,
			conflicts: [],
		};
	}
	const { sent } = await sendContent(
		peer,
		prepared,
		appName,
		report,
		PLACEHOLDER_APP_ID,
		read,
		{ ...ledger.app, normalized: current.normalized },
		edge?.assumed,
	);
	return {
		status: "sent",
		compatibility: outcome,
		...sent,
		...(confirm !== undefined && { confirmed: confirm }),
		sequence: sequenceOf(peer.since(start)),
	};
}

/** One update over A: the document it publishes, and the name it sends. */
export interface PublishUpdate {
	/** Names the update's outputs (`update`, `update-edited`). */
	readonly name: string;
	readonly document: PublishDocument;
	/** The app name the publish sends; the document's own by default. */
	readonly appName?: string;
}

export interface PublishInput {
	readonly create: PublishDocument;
	/** The first publish's app name; the document's own by default. */
	readonly appName?: string;
	/**
	 * Each a separate next publish over A. The first is the republish of D,
	 * which the capture sends twice (`capturePublish`).
	 */
	readonly updates: readonly PublishUpdate[];
	readonly configuration: PublishConfiguration;
	/**
	 * The corpus seed every step's stream is drawn from (`./entropy.mts`),
	 * with the configuration's id, at the ordinals `capturePublish` gives
	 * each step. Without one every draw is real.
	 */
	readonly seed?: number;
	/**
	 * Fields of HQ's source for the app, by path, that hold other values in
	 * this project space than an update sent: HQ serves them after every
	 * update, from the content import on. By default each is what the update
	 * left: the profile it sent (`views/apps.py::app_source` serves the
	 * stored profile through `export_json`) and HQ's own CommCare version.
	 */
	readonly source?: Partial<AssumedSource>;
	/**
	 * What a person saves in HQ over A before the updates (the document's
	 * `hq-side.json`), and what each update over them then does
	 * (`republish`): it goes through untouched (`"proceeds"`); it stops and
	 * is sent again with what a person who saw each stop confirms, every
	 * table in conflict taken over and every change listed with the digest
	 * shown (`"discards"`); or Nova stops it with `stopCode` and offers no
	 * discard (`"stops"`). An update whose outcome is another stops the
	 * capture, naming the document and what the stop listed, and so does a
	 * stop over a document without them: Nova's own push must never read as
	 * a change.
	 */
	readonly hqSide?: HqSideSaves;
}

export type PublishCapture =
	| {
			readonly status: "refused";
			readonly create: Extract<FirstPublishOutcome, { status: "refused" }>;
	  }
	| {
			readonly status: "sent";
			readonly create: Extract<FirstPublishOutcome, { status: "sent" }>;
			readonly updates: Readonly<Record<string, StepOutcome>>;
	  };

/**
 * Whether two publish steps sent the same bytes: the same import and the
 * same lookup workbook, or none. The media upload follows from the prepared
 * assets (one ZIP entry per asset `buildMediaBulkUploadZip` writes), so the
 * same document sends the same media. Two steps Nova stopped send nothing,
 * and are the same where they stopped with the same code.
 */
function sendsTheSame(left: StepOutcome, right: StepOutcome): boolean {
	if (left.status === "stopped" && right.status === "stopped") {
		return left.code === right.code;
	}
	if (left.status !== "sent" || right.status !== "sent") return false;
	const lookups =
		left.lookup === undefined || right.lookup === undefined
			? left.lookup === right.lookup
			: left.lookup.body.equals(right.lookup.body);
	return lookups && left.importApp.body.equals(right.importApp.body);
}

/**
 * What a person who saw `stop` confirms to send the publish again, beside
 * what they confirmed of the stops before it.
 */
function confirming(
	before: StopConfirmation | undefined,
	stop: PublishStop,
): StopConfirmation {
	return {
		stops: [
			...(before?.stops ?? []),
			{
				code: stop.code,
				remoteChanges: stop.remoteChanges,
				conflicts: stop.conflicts,
			},
		],
		discards: [
			...(before?.discards ?? []),
			...stop.remoteChanges.map((change) => ({
				kind: change.kind,
				novaResourceId: change.novaResourceId,
				observedDigest: change.observedDigest,
			})),
		],
		adopted: [
			...(before?.adopted ?? []),
			...stop.conflicts.map((conflict) => conflict.tableId),
		],
	};
}

/**
 * How many times a person's confirmation can meet another stop: preflight
 * lists the tables in conflict first and the changes after them, so a
 * publish over both stops twice before it goes through.
 */
const CONFIRMED_STOPS = 2;

/**
 * Capture what Nova's publish sends for a first publish and the updates
 * over it. Throws `UnexportableDocumentError` when Nova's export boundary
 * refuses a document, since no configuration would receive it.
 *
 * Each step is drawn once, in a stream of its own: with a seed, the first
 * publish at `OPERATION_ORDINALS.create`, the republish of D at
 * `OPERATION_ORDINALS.republish`, and each update to D′ at
 * `OPERATION_ORDINALS.update`, then one more for each later update. An
 * update that changes nothing Nova sends equals the republish because Nova
 * derives what it sends, never because the two shared a draw. The republish
 * is captured a second time, in the first stream no update holds, and the
 * two must send the same bytes, as a third publish sends the second's: a
 * change that mints an id per publish again stops the capture here.
 *
 * Every update is a separate next publish over A, so the peer is put back
 * to what the first publish left (with a person's saves, `hqSide`) before
 * each, and each is compared with the ledger the first publish left.
 */
export async function capturePublish(
	input: PublishInput,
): Promise<PublishCapture> {
	const { configuration } = input;
	const operation = (ordinal: number): EntropyOperation | undefined =>
		input.seed === undefined
			? undefined
			: { seed: input.seed, ordinal, configuration: configuration.id };
	/* A publish knows its target exactly (`preflight.ts`). */
	const attachmentTarget = attachmentUrlTarget({
		server: PROOF_SERVER,
		domain: configuration.domain,
	});
	const create = await prepareDocument(
		input.create,
		"hq-upload",
		attachmentTarget,
	);
	const updates = await Promise.all(
		input.updates.map(async (update) => ({
			update,
			prepared: await prepareDocument(
				update.document,
				"hq-upload",
				attachmentTarget,
			),
		})),
	);
	return withTargetPeer(
		{
			credentials: CREDENTIALS,
			domain: configuration.domain,
			flags: new Set(configuration.flags),
			caseSearchEnabled: configuration.caseSearchEnabled,
			appId: PLACEHOLDER_APP_ID,
			commcareVersion: CORPUS_COMMCARE_VERSION,
			...(input.source !== undefined && { sourceChanges: input.source }),
		},
		async (peer) => {
			const first = await seeded(operation(OPERATION_ORDINALS.create), () =>
				firstPublish(peer, create, input.appName ?? create.export.doc.appName),
			);
			if (!("ledger" in first)) {
				assertModeled(peer);
				return { status: "refused", create: first.outcome };
			}
			const { outcome: created, ledger } = first;
			if (input.hqSide !== undefined) peer.applyHqSide(input.hqSide);
			const stateA = peer.snapshot();
			const send = (
				{ update, prepared }: (typeof updates)[number],
				ordinal: number,
			) =>
				seeded(operation(ordinal), async (): Promise<StepOutcome> => {
					const appName = update.appName ?? prepared.export.doc.appName;
					const statement = input.hqSide?.republish;
					let confirm: StopConfirmation | undefined;
					for (let stops = 0; ; stops += 1) {
						peer.restore(stateA);
						const step = await updateStep(
							peer,
							prepared,
							appName,
							ledger,
							confirm,
						);
						if (step.status !== "stopped") {
							if (
								(statement === "discards" && confirm === undefined) ||
								statement === "stops"
							) {
								throw new Error(
									`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} over a person's saves in HQ ${statement === "stops" ? `stops with ${input.hqSide?.stopCode}` : "stops until a person discards what HQ holds"}, and it went through with no stop. Look at what the comparison reads of the saves, or at the statement.`,
								);
							}
							return step;
						}
						const listed = JSON.stringify(
							step.code === "hq_changed" ? step.remoteChanges : step.conflicts,
						);
						if (input.hqSide === undefined) {
							throw new Error(
								`Nova's ${update.name} of ${prepared.source.id} stopped with ${step.code} (${listed}), and nothing was saved in HQ over the app: Nova's own push read as a change. Look at what the comparison reads of the peer's answers.`,
							);
						}
						if (statement === "proceeds") {
							throw new Error(
								`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} proceeds over a person's saves in HQ, and it stopped with ${step.code} over these changes: ${listed}. None of the saves is a value Nova owns, so the overlay or the drift comparison read one as Nova's; fix that rather than the statement.`,
							);
						}
						if (statement === "stops") {
							if (step.code !== input.hqSide.stopCode) {
								throw new Error(
									`hq-side.json states that Nova stops its ${update.name} of ${prepared.source.id} with ${input.hqSide.stopCode}, and it stopped with ${step.code} (${listed}).`,
								);
							}
							return step;
						}
						if (stops === CONFIRMED_STOPS) return step;
						confirm = confirming(confirm, step);
					}
				});
			const outcomes: Record<string, StepOutcome> = {};
			for (const [position, entry] of updates.entries()) {
				outcomes[entry.update.name] = await send(
					entry,
					position === 0
						? OPERATION_ORDINALS.republish
						: OPERATION_ORDINALS.update + position - 1,
				);
			}
			const [republish] = updates;
			if (republish !== undefined) {
				const first = outcomes[republish.update.name];
				const again = await send(
					republish,
					OPERATION_ORDINALS.update + updates.length - 1,
				);
				if (first === undefined || !sendsTheSame(first, again)) {
					throw new Error(
						`Nova's republish of ${republish.prepared.source.id} sent other bytes the second time it was captured, so a third publish would not send the second's. A publish derives everything it sends from the document; look for an id drawn per publish.`,
					);
				}
			}
			assertModeled(peer);
			return { status: "sent", create: created, updates: outcomes };
		},
	);
}

function assertModeled(peer: TargetPeer): void {
	if (peer.unexpected.length > 0) {
		throw new Error(
			`Nova's client asked the capture peer for requests it does not model: ${peer.unexpected
				.map((request) => `${request.method} ${request.path}`)
				.join(
					", ",
				)}. The capture would otherwise record a publish Nova does not make.`,
		);
	}
}

// ── The local archive ────────────────────────────────────────────────

/**
 * Run `build` with the clock at `instant` and the local zone UTC, for code
 * that reads the clock synchronously. Node applies a change to `TZ` at
 * once, and `build` runs to completion before the zone is put back.
 */
function atInstant<T>(instant: number, build: () => T): T {
	const RealDate = globalThis.Date;
	const zone = process.env.TZ;
	process.env.TZ = "UTC";
	globalThis.Date = new Proxy(RealDate, {
		construct(target, args, newTarget) {
			return Reflect.construct(
				target,
				args.length === 0 ? [instant] : args,
				newTarget,
			);
		},
		get(target, property, receiver) {
			return property === "now"
				? () => instant
				: Reflect.get(target, property, receiver);
		},
	});
	try {
		return build();
	} finally {
		globalThis.Date = RealDate;
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	}
}

/**
 * The document's `.ccz` as Nova's compile route builds it
 * (`app/api/compile/route.ts` over `prepareCompileRequest`, then
 * `lib/export/localArchive.ts::compileLocalArchive`) for an app published to
 * the one project space `domain`: the download's rule
 * (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`) picks that one
 * reached deployment, whose HQ app is `PLACEHOLDER_APP_ID`, for the profile's
 * server properties and runtime URLs and the attachment links, with the
 * derived ids the ledger's absent overrides give. The archive embeds the
 * referenced lookup tables as fixtures and stamps the app's sequence. The
 * deployment is the one a publish there leaves: its HQ app was never made
 * afresh (`earlierHqApps` 0), and it holds `USH_EMPTY_CASE_LIST_TEXT` where
 * `emptyCaseListText` says the configuration does, as the publish would have
 * read it, so the archive writes the empty-list text exactly where HQ's
 * build there does. Throws `UnexportableDocumentError` where the route's
 * boundary refuses. With an operation, a draw made while the archive is
 * built is answered from its seeded generator (`./entropy.mts`); the build
 * makes none.
 */
export async function localCcz(
	source: PublishDocument,
	domain: string,
	operation?: EntropyOperation,
	options: { readonly emptyCaseListText?: boolean } = {},
): Promise<Buffer> {
	const emptyCaseListText = options.emptyCaseListText === true;
	const choice = chooseDownloadTarget(
		[
			{
				server: PROOF_SERVER,
				domain,
				hqAppId: PLACEHOLDER_APP_ID,
				emptyCaseListText,
				earlierHqApps: 0,
			},
		],
		{ format: "ccz", domain },
	);
	if (choice.kind !== "project-space") {
		throw new Error(
			`The download rule chose no project space for a CCZ of ${source.id} from its one reached deployment (${JSON.stringify(choice)}).`,
		);
	}
	const { target } = choice;
	const { export: prepared } = await prepareDocument(
		source,
		"ccz",
		attachmentUrlTarget(target),
	);
	return seeded(operation, () =>
		atInstant(CCZ_CLOCK, () =>
			compileLocalArchive(
				prepared,
				{ server: target.server, domain: target.domain, appId: target.hqAppId },
				DERIVED_WIRE_IDENTITY,
				{
					emptyCaseListText: target.emptyCaseListText,
					earlierHqApps: target.earlierHqApps,
				},
			),
		),
	);
}

/**
 * The document's HQ import file as `/api/compile/json` builds it for an app
 * published to the one project space `domain`: the download's rule
 * (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`) scopes its
 * attachment links to that deployment, `expandDoc` writes the app JSON with
 * no runtime target and the derived ids, and `buildHqJsonExportArchive`
 * packs it with the media upload, the lookup workbook and the README that
 * renders the manual-import guide (`lib/publish/manualImportGuide.ts`). The
 * ZIP is built with the clock fixed, as a `.ccz` is.
 */
export async function importFile(
	source: PublishDocument,
	domain: string,
): Promise<Buffer> {
	const choice = chooseDownloadTarget(
		[
			{
				server: PROOF_SERVER,
				domain,
				hqAppId: PLACEHOLDER_APP_ID,
				emptyCaseListText: false,
				earlierHqApps: 0,
			},
		],
		{ format: "json" },
	);
	const { export: prepared } = await prepareDocument(
		source,
		"hq-json",
		choice.kind === "project-space" ? attachmentUrlTarget(choice.target) : null,
	);
	const { doc, assets, lookupWorkbook } = prepared;
	const hqJson = expandDoc(doc, {
		attachmentTarget: prepared.attachmentTarget,
		...(assets.size > 0 && { assets }),
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	const guide = hqImportFileGuide({
		appName: doc.appName,
		doc,
		assets,
		lookupWorkbook,
	});
	return atInstant(CCZ_CLOCK, () =>
		buildHqJsonExportArchive(
			doc.appName,
			hqJson,
			assets,
			lookupWorkbook,
			renderManualImportGuide(guide),
		),
	);
}

/**
 * The paths of the media upload a publish of the document sends: one per
 * wire path of the export's prepared assets, as `buildMediaBulkUploadZip`
 * writes them, sorted. Empty for a document whose export carries no media.
 */
export async function preparedMediaPaths(
	source: PublishDocument,
	domain: string,
): Promise<string[]> {
	const { export: prepared } = await prepareDocument(
		source,
		"hq-upload",
		attachmentUrlTarget({ server: PROOF_SERVER, domain }),
	);
	return [
		...new Set([...prepared.assets.values()].map((asset) => asset.wirePath)),
	].sort();
}

/** Nova's verdict for a stored document, after the same admission a capture makes. */
export function documentVerdict(source: PublishDocument): NovaPublishVerdict {
	return novaPublishVerdict(
		hydrateAdmittedDocument({
			id: source.id,
			doc: source.doc,
			...(source.lookup !== undefined && { lookup: source.lookup }),
		}),
	);
}
