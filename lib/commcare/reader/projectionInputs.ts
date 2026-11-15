/**
 * What every projection the reader compares with the source is given. A
 * projection prints derived ids, a blank capture address, identity table
 * names and content-hash media paths unless it is told otherwise, and the
 * source holds the HQ app's own, so each comparison prints under the
 * source's: its menu and form ids and `xmlns`, its project space, its table
 * tags and field names, and the media paths it spells.
 *
 * A document holds a media slot's asset and no path, so a projection prints
 * one path for each asset: of the paths the source spells for it, the first
 * in code-unit order. Where CommCare HQ holds one file under several paths,
 * every slot that names another of them is compared through
 * `keptMediaPaths`, so a path naming the same file as the kept one compares
 * equal to it, and no comparison depends on which path is kept. The first
 * publish keeps a path by its own rule (`assignMediaPaths`, part 10 of the
 * bring-in plan, section 4.2), which drops a path it cannot hold, one that
 * names another file and one that differs from another file's only by letter
 * case before it takes the first in that order, so it keeps another path, or
 * the file's derived one, where the first here is dropped; its register
 * declares each move (`media-paths-joined`, `media-files-renamed`).
 */

import { mimeTypeForExtension } from "@/lib/domain/multimedia";
import { LOOKUP_DATA_TYPES } from "@/lib/lookup/constants";
import type { LookupDataType } from "@/lib/lookup/types";
import { syntheticModuleUuid } from "../emissionPlan";
import {
	type LookupNamingDefinition,
	type LookupWireNaming,
	lookupWireNaming,
} from "../lookup/naming";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "../multimedia/assetWirePath";
import {
	targetWireIdentity,
	type WireIdentity,
	type WireIdentityOverride,
} from "../wireIdentity";
import type { AttachmentUrlTarget } from "../xform/captureUrlNode";
import type { ReadContext } from "./context";
import type { ReadMediaReference } from "./types";

export interface ReadProjectionInputs {
	/** The source's own ids over the derivation, for everything the reading minted. */
	readonly identity: WireIdentity;
	/** The project space the source was read from: a capture's link is written against it. */
	readonly attachmentTarget: AttachmentUrlTarget;
	/** Each bound table under the tag and field names the source reads it by. */
	readonly lookupNaming: LookupWireNaming;
	/** Each asset the media index resolved, at the path the source spells for it. */
	readonly assets: AssetManifest;
}

const JR_FILE = "jr://file/";

interface Built {
	readonly inputs: ReadProjectionInputs;
	/** Each asset's kept path, as the source spells it, by asset id. */
	readonly kept: ReadonlyMap<string, string>;
	/** How many media references the reading held when these were built. */
	readonly references: number;
}

const BUILT = new WeakMap<ReadContext, Built>();

function isLookupDataType(value: string): value is LookupDataType {
	return (LOOKUP_DATA_TYPES as readonly string[]).includes(value);
}

/** The catalog's tables as the wire naming reads them. A column typed outside a
 *  table's own types breaks the catalog's contract, which its builder holds. */
function namingDefinitions(ctx: ReadContext): LookupNamingDefinition[] {
	return [...ctx.input.lookup.definitions.values()].map((table) => ({
		id: table.id,
		tag: table.tag,
		columns: table.columns.map((column) => {
			if (!isLookupDataType(column.dataType))
				throw new Error(
					`The reader was handed a lookup catalog whose table "${table.tag}" holds the column "${column.wireName}" typed ${column.dataType}, which no lookup table column holds. Build the catalog from the project space's table definitions.`,
				);
			return {
				id: column.id,
				wireName: column.wireName,
				label: column.label,
				dataType: column.dataType,
			};
		}),
	}));
}

/** The asset of one media reference, at the path the source spells. */
function sourceAsset(
	assetId: string,
	path: string,
	kind: ResolvedMediaAsset["kind"],
): ResolvedMediaAsset {
	const wirePath = path.startsWith(JR_FILE) ? path.slice(JR_FILE.length) : path;
	const name = wirePath.slice(wirePath.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
	return {
		assetId: assetId as ResolvedMediaAsset["assetId"],
		wirePath,
		kind,
		mimeType: mimeTypeForExtension(extension) ?? "application/octet-stream",
		contentHash: assetId,
		extension,
	};
}

/** `jr://file/` taken off a path, as a wire path is written. */
function withoutJrFile(path: string): string {
	return path.startsWith(JR_FILE) ? path.slice(JR_FILE.length) : path;
}

/**
 * The four inputs of one reading: each menu and form the reading minted
 * under the source's own ids, the project space the source was read from,
 * the bound catalog's naming, and each resolved asset at the path it keeps.
 * Built once for the media references read so far, and again where a later
 * stage read more.
 */
export function readProjectionInputs(ctx: ReadContext): ReadProjectionInputs {
	return built(ctx).inputs;
}

/** The source's path of each asset the reading resolved: the first, in code-unit order of the
 *  wire path, of the paths its references spell. */
function keptPaths(ctx: ReadContext): Map<string, ReadMediaReference> {
	const kept = new Map<string, ReadMediaReference>();
	for (const reference of ctx.facts.mediaReferences) {
		const held = kept.get(reference.assetId);
		if (
			held === undefined ||
			withoutJrFile(reference.path) < withoutJrFile(held.path)
		)
			kept.set(reference.assetId, reference);
	}
	return kept;
}

function built(ctx: ReadContext): Built {
	const known = BUILT.get(ctx);
	if (
		known !== undefined &&
		known.references === ctx.facts.mediaReferences.length
	)
		return known;
	const overrides: WireIdentityOverride[] = [];
	for (const module of ctx.draft.modules) {
		// A folded hidden menu is the menu Nova's emission makes for its form,
		// under the UUID that emission derives from the form's.
		const folded = ctx.draft.foldedMenus.find((one) => one.menu === module);
		overrides.push({
			entityKind: "module",
			novaEntityUuid:
				folded === undefined
					? module.uuid
					: syntheticModuleUuid(folded.formUuid),
			uniqueId: module.uniqueId,
			xmlns: null,
		});
		for (const form of module.forms) {
			const readId =
				ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
			overrides.push({
				entityKind: "form",
				novaEntityUuid: form.uuid,
				uniqueId: readId ?? null,
				xmlns: form.xmlns,
			});
		}
	}
	const kept = keptPaths(ctx);
	const assets = new Map<string, ResolvedMediaAsset>();
	for (const [assetId, reference] of kept)
		assets.set(
			assetId,
			sourceAsset(assetId, reference.path, reference.mediaKind),
		);
	const inputs: ReadProjectionInputs = {
		identity: targetWireIdentity(overrides),
		attachmentTarget: {
			origin: ctx.input.target.origin,
			domain: ctx.input.target.domain,
		},
		lookupNaming: lookupWireNaming(namingDefinitions(ctx)),
		assets: assets as AssetManifest,
	};
	const result: Built = {
		inputs,
		kept: new Map(
			[...kept].map(([assetId, reference]) => [assetId, reference.path]),
		),
		references: ctx.facts.mediaReferences.length,
	};
	BUILT.set(ctx, result);
	return result;
}

/** `path` as a projection prints it: the kept path of the asset it names, where the media index
 *  resolves it to an asset a reference of the reading names; otherwise `path` itself. */
export function keptMediaPath(ctx: ReadContext, path: string): string {
	const resolution = ctx.input.media.resolve(path);
	if (resolution.kind !== "asset") return path;
	return built(ctx).kept.get(resolution.assetId) ?? path;
}

/** A stored `{ language: path }` map with each path as a projection prints it
 *  (`keptMediaPath`); any other value as it is. */
export function keptMediaPaths(ctx: ReadContext, value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return value;
	return Object.fromEntries(
		Object.entries(value).map(([language, path]) => [
			language,
			typeof path === "string" ? keptMediaPath(ctx, path) : path,
		]),
	);
}
