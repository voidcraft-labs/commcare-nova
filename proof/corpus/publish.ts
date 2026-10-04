/**
 * What Nova's publish sends CommCare HQ for one corpus document, captured
 * from Nova's own client.
 *
 * The harness makes HQ's state A (and every later state) by applying the
 * request bodies Nova's publish sends, so those bodies come from production
 * code, not a copy of it:
 *
 * - the application JSON from `lib/deployment/importApplication.ts::hqImportApplication`,
 *   the assembly `publishAppToHq` calls;
 * - the project-space check from `lib/commcare/client.ts::probeHqProjectSpaceCompatibility`
 *   over `projectSpaceCompatibilityProbePlan`, whose report decides both
 *   whether Nova publishes at all and the derived Search profile key;
 * - the lookup workbook from `uploadLookupTableWorkbook`, the update's source
 *   profile from `readHqAppSourceProfile`, the upload from `importApp`, and
 *   the media upload after it from `uploadAppMediaBundle` over
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
 *   logic reads places is published to a project space that holds none.
 *
 * A document Nova's export boundary refuses is not a corpus document: the
 * capture refuses it with the boundary's findings (`exportFindings`) before
 * anything is sent, since no project space would receive it.
 *
 * A publish is a create of D (state A) followed by one or more updates over
 * A: D again, or D′ after an edit batch. Each update is captured naming a
 * placeholder app id, with the peer answering the source read with the
 * profile HQ holds for A. HQ mints A's id, so the harness writes it into the
 * update's `app_id` field (`proof/hq/operations.py::with_app_id`). The
 * profile is an assumption about HQ, so it is recorded beside the body for
 * the HQ side to hold against HQ's own `app_source` for A before it applies
 * the update: a difference means the captured update is not the one Nova
 * would send there.
 *
 * Every output is deterministic apart from the identities Nova mints on each
 * export: module and form `unique_id`s and form `xmlns` in the app JSON, and
 * the profile `uniqueid` in a `.ccz`. Given a corpus seed, each publish step
 * and each local export draws those from its own seeded generator
 * (`./entropy.mts`): the create at `OPERATION_ORDINALS.create`, the first
 * update (the republish) at `OPERATION_ORDINALS.republish`, and each later
 * update at the republish's ordinal when that draw sends exactly what the
 * republish sends, and otherwise at an ordinal of its own
 * (`capturePublish`). undici draws a random multipart
 * boundary per request, so each captured body is re-framed with a fixed one
 * (after checking the re-framed body parses to the same fields), and a
 * `.ccz` and a media upload's ZIP are built with the clock fixed, because
 * each archive stamps its entries with the time (HQ reads a ZIP's names and
 * bytes, never its times: `hqmedia/tasks.py::process_bulk_upload_zip`).
 */

import { createHash } from "node:crypto";
import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import {
	type CommCareCredentials,
	importApp,
	probeHqProjectSpaceCompatibility,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { readHqAppSourceProfile } from "@/lib/commcare/hq/appSource";
import { uploadLookupTableWorkbook } from "@/lib/commcare/hq/lookupTables";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import {
	HQ_PRIVATE_FEATURE_FLAG_SYMBOLS,
	type HqPrivateFeatureFlagRequirement,
	type ProjectSpaceCompatibilityReport,
	projectSpaceCompatibilityProbePlan,
} from "@/lib/commcare/projectSpaceCompatibility";
import type { CommCareServer } from "@/lib/commcare/servers";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	type AttachmentDeploymentTarget,
	attachmentUrlTarget,
	attachmentUrlTargetFor,
} from "@/lib/deployment/attachmentTarget";
import { hqImportApplication } from "@/lib/deployment/importApplication";
import {
	downloadDeploymentTarget,
	downloadRuntimeTarget,
} from "@/lib/deployment/runtimeTarget";
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
import { hydrateAdmittedDocument } from "./editBatches";
import {
	type EntropyOperation,
	entropySeeded,
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
 * The app id an update names at capture. HQ mints the real one when it
 * applies the create; the harness writes that into the update's `app_id`.
 */
export const PLACEHOLDER_APP_ID = "nova-proof-placeholder-app";

const CREDENTIALS: CommCareCredentials = {
	username: "nova-proof",
	apiKey: "nova-proof-key",
	server: PROOF_SERVER,
};

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

/** The two exports a capture makes: the direct HQ upload and the `.ccz` download. */
export type CaptureExportMode = Extract<ExportMode, "hq-upload" | "ccz">;

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
				: `Nova's compile route refuses to build corpus document ${documentId} (${reasons}), so no device would receive it. Fix the document or the Project data it carries.`,
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

/** One publish of a document: refused by Nova's check, or what it sent. */
export type StepOutcome =
	| {
			readonly status: "refused";
			readonly compatibility: CompatibilityOutcome;
	  }
	| {
			readonly status: "sent";
			readonly compatibility: CompatibilityOutcome;
			/** The lookup workbook upload, when the document references a table. */
			readonly lookup?: CapturedRequest;
			readonly importApp: CapturedRequest;
			/** The media upload after the import, when the export carries media. */
			readonly media?: CapturedRequest;
			/** The application JSON the import carried. */
			readonly application: HqApplication;
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
			`The capture expected Nova's client to send one ${method} ${path} in this publish, and it sent ${matching.length}.`,
		);
	}
	return matching[0];
}

/**
 * One publish as `publishAppToHq` makes it once its target is reachable:
 * the compatibility check (a blocked report stops the publish before any
 * write), the lookup push, then on an update the source read, then the
 * import of the assembled application, and, when the export carries media,
 * the media upload to the app the import answered with
 * (`service.ts::uploadMediaBytes`: one ZIP of every asset, then the status
 * reads, which change nothing in HQ and are not captured).
 */
async function publishStep(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
	update: boolean,
): Promise<StepOutcome> {
	const domain = peer.state.domain;
	const target = { server: PROOF_SERVER, domain };
	const probe = await probeHqProjectSpaceCompatibility(
		CREDENTIALS,
		domain,
		projectSpaceCompatibilityProbePlan(prepared.export.doc),
	);
	const compatibility = compatibilityOutcome(probe.report);
	if (probe.report.status === "blocked") {
		return { status: "refused", compatibility };
	}
	const mark = peer.requests.length;
	if (prepared.export.lookupWorkbook !== undefined) {
		const pushed = await uploadLookupTableWorkbook(
			CREDENTIALS,
			domain,
			prepared.export.lookupWorkbook.bytes,
			{ replace: true },
		);
		if (!pushed.success) {
			throw new Error(
				`The capture peer refused the lookup workbook of ${prepared.source.id} (status ${pushed.status}), which it accepts from every publish.`,
			);
		}
	}
	let sourceProfile: HqApplicationProfile | undefined;
	if (update) {
		const source = await readHqAppSourceProfile(
			CREDENTIALS,
			domain,
			PLACEHOLDER_APP_ID,
		);
		if ("success" in source) {
			throw new Error(
				`Nova's update of ${prepared.source.id} could not read the app's source from the capture peer (status ${source.status}), so it would not have sent the update.`,
			);
		}
		sourceProfile = source.profile;
	}
	const application = hqImportApplication({
		prepared: prepared.export,
		target,
		compatibility: probe.report,
		update:
			sourceProfile === undefined
				? null
				: { appId: PLACEHOLDER_APP_ID, sourceProfile },
	});
	const imported = await importApp(
		CREDENTIALS,
		domain,
		appName,
		application,
		update ? PLACEHOLDER_APP_ID : undefined,
	);
	if (!imported.success) {
		throw new Error(
			`The capture peer refused the import of ${prepared.source.id} (status ${imported.status}), which it accepts from every publish.`,
		);
	}
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
		status: "sent",
		compatibility,
		...(prepared.export.lookupWorkbook !== undefined && {
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
	/** The create's app name; the document's own by default. */
	readonly appName?: string;
	/** Each a separate next publish over A. */
	readonly updates: readonly PublishUpdate[];
	readonly configuration: PublishConfiguration;
	/**
	 * The corpus seed every step's minted identities are drawn from
	 * (`./entropy.mts`), with the configuration's id, at the ordinals
	 * `capturePublish` gives each step. Without one they are drawn as Nova
	 * draws them.
	 */
	readonly seed?: number;
	/**
	 * The profile HQ holds for A when the updates are published, when
	 * something changed it after the create. By default it is the profile
	 * HQ keeps from the create: the create's `profile`, or HQ's empty
	 * default when the create sends none (`models/applications.py::Application.profile`
	 * is a `DictProperty`, which the create path does not otherwise write,
	 * and `views/apps.py::app_source` serves it through `export_json`).
	 */
	readonly sourceProfile?: HqApplicationProfile;
}

export type PublishCapture =
	| {
			readonly status: "refused";
			readonly create: Extract<StepOutcome, { status: "refused" }>;
	  }
	| {
			readonly status: "sent";
			readonly create: Extract<StepOutcome, { status: "sent" }>;
			/** The profile the peer answered each update's source read with. */
			readonly assumedSourceProfile: HqApplicationProfile;
			readonly updates: Readonly<Record<string, StepOutcome>>;
	  };

/**
 * Whether two publish steps sent the same bytes: the same import and the
 * same lookup workbook, or none. The media upload follows from the import
 * (one ZIP entry per path its `multimedia_map` names, each the bytes of the
 * content hash in its path), so the same import sends the same media.
 */
function sendsTheSame(left: StepOutcome, right: StepOutcome): boolean {
	if (left.status !== "sent" || right.status !== "sent") return false;
	const lookups =
		left.lookup === undefined || right.lookup === undefined
			? left.lookup === right.lookup
			: left.lookup.body.equals(right.lookup.body);
	return lookups && left.importApp.body.equals(right.importApp.body);
}

/**
 * Capture what Nova's publish sends for a create and the updates over it.
 * Throws `UnexportableDocumentError` when Nova's export boundary refuses a
 * document, since no configuration would receive it.
 *
 * With a seed, the create draws its minted identities at
 * `OPERATION_ORDINALS.create` and the first update (the republish of D) at
 * `OPERATION_ORDINALS.republish`. Each later update (D′) is drawn at the
 * republish's ordinal too, and kept when it sends exactly the republish's
 * bytes: an edit that changes nothing Nova sends leaves its update
 * byte-identical to the republish. Otherwise it is drawn again at an
 * ordinal of its own (`OPERATION_ORDINALS.update`, then one more for each
 * later update), which is the update kept. One stream would mint, in the
 * same order, the ids of D's entities for whatever entities D′ holds in
 * their places, so an id of D′ would name another entity of D; a stream of
 * its own mints ids no other export of the document holds, as Nova's
 * unseeded generator does. With seeding off (`PROOF_ENTROPY=real`) every
 * draw is fresh already, and each update is drawn once.
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
		},
		async (peer) => {
			const created = await seeded(operation(OPERATION_ORDINALS.create), () =>
				publishStep(
					peer,
					create,
					input.appName ?? create.export.doc.appName,
					false,
				),
			);
			if (created.status === "refused") {
				assertModeled(peer);
				return { status: "refused", create: created };
			}
			const assumedSourceProfile =
				input.sourceProfile ?? created.application.profile ?? {};
			peer.holdProfile(assumedSourceProfile);
			const outcomes: Record<string, StepOutcome> = {};
			let republish: StepOutcome | undefined;
			for (const [position, { update, prepared }] of updates.entries()) {
				const send = (ordinal: number) =>
					seeded(operation(ordinal), () =>
						publishStep(
							peer,
							prepared,
							update.appName ?? prepared.export.doc.appName,
							true,
						),
					);
				let outcome = await send(OPERATION_ORDINALS.republish);
				if (republish === undefined) {
					republish = outcome;
				} else if (
					input.seed !== undefined &&
					entropySeeded() &&
					!sendsTheSame(outcome, republish)
				) {
					outcome = await send(OPERATION_ORDINALS.update + position - 1);
				}
				outcomes[update.name] = outcome;
			}
			assertModeled(peer);
			return {
				status: "sent",
				create: created,
				assumedSourceProfile,
				updates: outcomes,
			};
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
 * `lib/export/localArchive.ts::compileLocalArchive`) for an app whose
 * deployment record names this one project space: the download reuses that
 * target for the runtime URLs and the attachment links, embeds the
 * referenced lookup tables as fixtures, and stamps the app's sequence.
 * Throws `UnexportableDocumentError` where the route's boundary refuses.
 * With an operation, the archive's minted identities are drawn from its
 * seeded generator (`./entropy.mts`).
 */
export async function localCcz(
	source: PublishDocument,
	domain: string,
	operation?: EntropyOperation,
): Promise<Buffer> {
	const deployment: AttachmentDeploymentTarget = {
		kind: "known",
		target: { server: PROOF_SERVER, domain },
	};
	const runtimeTarget = downloadRuntimeTarget(deployment);
	if (runtimeTarget === undefined) {
		throw new Error(
			"The compile route found no runtime target for a known deployment.",
		);
	}
	const { export: prepared } = await prepareDocument(
		source,
		"ccz",
		attachmentUrlTargetFor(downloadDeploymentTarget(deployment)),
	);
	return seeded(operation, () =>
		atInstant(CCZ_CLOCK, () => compileLocalArchive(prepared, runtimeTarget)),
	);
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
