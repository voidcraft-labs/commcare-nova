/**
 * What every projection the reader compares with the source is given. A
 * projection prints derived ids, a blank capture address, identity table
 * names and content-hash media paths unless it is told otherwise, and the
 * source holds the HQ app's own, so each comparison prints under the
 * source's: its menu and form ids and `xmlns`, its project space, its table
 * tags and field names, and the media paths it spells.
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

const BUILT = new WeakMap<ReadContext, ReadProjectionInputs>();

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

/**
 * The four inputs of one reading, built once: each menu and form the
 * reading minted under the source's own ids, the project space the source
 * was read from, the bound catalog's naming, and each resolved asset at the
 * source's path.
 */
export function readProjectionInputs(ctx: ReadContext): ReadProjectionInputs {
	const known = BUILT.get(ctx);
	if (known !== undefined) return known;
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
	const assets = new Map<string, ResolvedMediaAsset>();
	for (const reference of ctx.facts.mediaReferences)
		if (!assets.has(reference.assetId))
			assets.set(
				reference.assetId,
				sourceAsset(reference.assetId, reference.path, reference.mediaKind),
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
	BUILT.set(ctx, inputs);
	return inputs;
}
