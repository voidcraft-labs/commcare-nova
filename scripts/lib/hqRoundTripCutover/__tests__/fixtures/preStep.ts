/**
 * The frozen pre-step fixtures on disk: where they live, their file shapes,
 * and their readers. Captured once by `./capturePreStep.ts` in the tree whose
 * schema was still the pre-step one, and read by every test from then on.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { blueprintScalars, decomposeBlueprint } from "@/lib/db/blueprintRows";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { rawDocumentAssembly, readRawDocument } from "../../oldShape";
import type { QuestionPathMenu } from "../../questionPaths";
import { type StepDeployment, transformDocument } from "../../transform";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../..");

export const PRE_STEP_DIRECTORY = join(import.meta.dirname, "pre-step");
export const LEGACY_DIRECTORY = join(
	REPOSITORY_ROOT,
	"proof",
	"hq-reads",
	"cutover",
);

/** One document's raw carriers, exactly as the writer stores them. */
export interface FixtureCarriers {
	readonly root: PersistedBlueprintRootText;
	readonly rows: readonly PersistedEntityRowText[];
}

/** What a database must hold beside the document for it to pass the gate. */
export interface FixtureProject {
	/** The Project's lookup tables with their rows, as the corpus captured them. */
	readonly lookup?: unknown;
	/** Each uploaded asset the document references, by id. */
	readonly media?: Readonly<
		Record<
			string,
			{
				readonly kind: string;
				readonly mimeType: string;
				readonly extension: string;
				readonly sizeBytes: number;
				readonly sha256: string;
			}
		>
	>;
}

export interface FixtureWitnesses {
	readonly steps: readonly string[];
	readonly blockers: readonly string[];
	readonly reasons: readonly string[];
}

export interface FixtureManifestEntry extends FixtureWitnesses {
	readonly id: string;
	readonly kind: "corpus" | "hand-built";
	/** SHA-256 of `carriers.json`'s value as JSON text. */
	readonly digest: string;
}

export interface FixtureManifest {
	fixtures: FixtureManifestEntry[];
}

export interface FixtureHistory {
	readonly baseline: { readonly seq: number; readonly snapshotText: string };
	readonly rows: readonly {
		readonly seq: number;
		readonly batchId: string;
		readonly mutationsText: string;
	}[];
}

/**
 * The carriers a pre-step writer stores for a persistable document. A
 * pre-step row holds no `app_settings`, which step `app-settings` writes, so
 * the column is NULL whatever the document holds.
 */
export function carriersOf(doc: PersistableDoc): FixtureCarriers {
	const scalars = blueprintScalars(doc);
	return {
		root: {
			app_name: scalars.app_name,
			connect_type: scalars.connect_type,
			case_types_text:
				scalars.case_types === null ? null : JSON.stringify(scalars.case_types),
			localization_text:
				scalars.localization === undefined
					? null
					: JSON.stringify(scalars.localization),
			app_settings_text: null,
			logo: scalars.logo as PersistedBlueprintRootText["logo"],
		},
		rows: decomposeBlueprint(doc)
			.map((row) => ({
				uuid: row.uuid,
				kind: row.kind,
				parent_uuid: row.parent_uuid,
				ordinal: row.ordinal,
				data_text: JSON.stringify(row.data),
			}))
			.sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)),
	};
}

function readJson<T>(...path: string[]): T {
	return JSON.parse(readFileSync(join(...path), "utf8")) as T;
}

export function readFixtureManifest(): FixtureManifest {
	return readJson(PRE_STEP_DIRECTORY, "manifest.json");
}

export function readFixtureCarriers(
	id: string,
	...under: string[]
): FixtureCarriers {
	return readJson(PRE_STEP_DIRECTORY, id, ...under, "carriers.json");
}

/**
 * A fixture as the cutover leaves it: every registered step run over its
 * frozen carriers with the given deployments (none by default), parsed and
 * hydrated. A frozen fixture lacks the slots the stack makes required, so a
 * test that needs a document of the current schema reads it here.
 */
export function migratedFixtureDocument(
	id: string,
	deployments: readonly StepDeployment[] = [],
): BlueprintDoc {
	const { target } = transformDocument(
		readRawDocument(id, readFixtureCarriers(id)),
		{
			appId: id,
			projectId: "fixture-project",
			lookupColumnTypes: new Map(),
			deployments,
		},
	);
	return hydratePersistedBlueprint(
		blueprintDocSchema.parse(rawDocumentAssembly(id, target)),
	);
}

export function readFixtureProject(id: string): FixtureProject {
	return readJson(PRE_STEP_DIRECTORY, id, "project.json");
}

export function readFixturePaths(
	id: string,
	...under: string[]
): readonly QuestionPathMenu[] {
	return readJson(PRE_STEP_DIRECTORY, id, ...under, "paths.json");
}

export function readFixtureHistory(id: string, name: string): FixtureHistory {
	return {
		baseline: readJson(
			PRE_STEP_DIRECTORY,
			id,
			"histories",
			name,
			"baseline.json",
		),
		rows: readJson(PRE_STEP_DIRECTORY, id, "histories", name, "rows.json"),
	};
}

/** The document after one history row, by its sequence. */
export function readHistoryCarriers(
	id: string,
	name: string,
	seq: number,
): FixtureCarriers {
	return readFixtureCarriers(id, "histories", name, `after-${seq}`);
}

export function readLegacyManifest(): Readonly<Record<string, string>> {
	return readJson(LEGACY_DIRECTORY, "legacy-manifest.json");
}

export function readFixtureSchemas(
	id: string,
): Readonly<Record<string, unknown>> {
	return readJson(PRE_STEP_DIRECTORY, id, "schemas.json");
}

/** The ready media rows a Project holding the fixture's uploads would hold. */
export function fixtureMediaRecords(
	project: FixtureProject,
	projectId: string,
	owner: string,
): MediaAssetRecord[] {
	return Object.entries(project.media ?? {}).map(([id, asset]) => ({
		id: asMediaAssetId(id),
		project_id: projectId,
		owner,
		contentHash: asset.sha256,
		mimeType: asset.mimeType as MediaAssetRecord["mimeType"],
		extension: asset.extension,
		sizeBytes: asset.sizeBytes,
		kind: asset.kind as MediaAssetRecord["kind"],
		gcsObjectKey: `projects/${projectId}/media/${asset.sha256}${asset.extension}`,
		originalFilename: `${id}${asset.extension}`,
		status: "ready",
		created_at: new Date(0),
	}));
}
