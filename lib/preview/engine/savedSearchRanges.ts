import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveViewerTimeZone } from "@/lib/case-store/sql/viewerTimeZone";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	recordFromEntries,
	type SearchInputDef,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { previewPlatformRules } from "../platform";
import { loadExpressionLookupData } from "./caseDataBindingHelpers";
import { previewSessionValues } from "./identity";
import type { AuthorizedPreviewContext } from "./previewAuthorization";
import { resolveSearchInputDefaults } from "./searchExpressionEvaluation";
import {
	setStartingRangeValues,
	webSearchRangeDraft,
} from "./searchRangeAnswer";
import {
	isRangeWithDefault,
	literalRangeDefault,
	needsRangeOpening,
	type OpenedSearchRange,
	RANGE_ANSWER_SUFFIXES,
} from "./searchRangeOpening";

type Authorized = Extract<AuthorizedPreviewContext, { kind: "ready" }>;
interface RangeScope {
	readonly appId: string;
	readonly moduleUuid?: string;
	readonly caseType?: string;
	readonly viewerTimeZone?: string;
}

function answerParts(name: string, values: ReadonlyMap<string, string>) {
	return RANGE_ANSWER_SUFFIXES.map(
		(suffix) => values.get(name + suffix) ?? null,
	);
}

function signature(
	args: RangeScope,
	context: Authorized,
	fieldName: string,
	fieldDigest: string,
	opening: string,
	values: ReadonlyMap<string, string>,
): Buffer {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("Search opening authentication is unavailable.");
	const parts = [
		opening,
		args.appId,
		context.scope.projectId,
		context.identity.actorUserId,
		context.identity.ownerId,
		context.identity.personaUuid ?? null,
		context.device.platform,
		context.device.androidDeviceId,
		context.device.appLanguage,
		resolveViewerTimeZone(args.viewerTimeZone),
		args.moduleUuid,
		fieldDigest,
		answerParts(fieldName, values),
	];
	return createHmac("sha256", secret)
		.update("nova.preview.search.range.opening.v1\0")
		.update(JSON.stringify(parts))
		.digest();
}

/** Only the committed module supplies the fields and their expressions. The
 * authorized Project supplies all their rows in a single repeatable read. */
export async function openSavedSearchRanges(
	args: RangeScope,
	context: Authorized,
): Promise<OpenedSearchRange[]> {
	const saved = context.blueprint;
	const mod =
		args.moduleUuid === undefined ? undefined : saved?.modules[args.moduleUuid];
	if (!saved || !mod) return [];
	const fields = (mod.caseListConfig?.searchInputs ?? [])
		.filter(isRangeWithDefault)
		.filter(needsRangeOpening);
	if (fields.length === 0) return [];
	const savedDoc = hydratePersistedBlueprint(saved);
	const lookup = await loadExpressionLookupData(
		context.scope,
		fields.map((field) => field.default),
	);
	const session = {
		...previewSessionValues(context.identity, context.device),
		userPropertySlugs: recordFromEntries(userPropertySlugsByUuid(savedDoc)),
	};
	const zone = resolveViewerTimeZone(args.viewerTimeZone);
	const values = resolveSearchInputDefaults(
		fields,
		session,
		{ doc: savedDoc, moduleUuid: mod.uuid, lookup },
		zone,
	);
	const opening = randomBytes(16).toString("hex");
	return fields.map((field) => {
		const answers: Record<string, string> = {};
		for (const suffix of RANGE_ANSWER_SUFFIXES) {
			const key = field.name + suffix;
			const value = values.get(key);
			if (value !== undefined) answers[key] = value;
		}
		if (values.has(field.name + ":starting")) {
			const fieldDigest = canonicalJsonDigest(field);
			const signatures = [
				signature(
					args,
					context,
					field.name,
					fieldDigest,
					opening,
					values,
				).toString("hex"),
			];
			if (context.device.platform === "web-apps") {
				const shown = webSearchRangeDraft(
					[field],
					new Map(Object.entries(answers)),
					zone,
				);
				if (!shown.unavailable && shown.draft.has(field.name + ":starting"))
					signatures.push(
						signature(
							args,
							context,
							field.name,
							fieldDigest,
							opening,
							shown.draft,
						).toString("hex"),
					);
			}
			answers[field.name + ":opening"] = [opening, ...new Set(signatures)].join(
				".",
			);
		}
		return { field, answers };
	});
}

/** Submission and paging verify the answer the manager opened with. A
 * literal's held answer is reproducible without a read of the clock or rows. */
export function matchesSavedSearchRanges(
	args: RangeScope,
	context: Authorized,
	fields: readonly SearchInputDef[],
	values?: ReadonlyMap<string, string>,
): boolean {
	if (!values) return true;
	const names = [...values.keys()]
		.filter((key) => key.endsWith(":starting"))
		.map((key) => key.slice(0, -":starting".length));
	if (names.length === 0) return true;
	const mod =
		args.moduleUuid === undefined
			? undefined
			: context.blueprint?.modules[args.moduleUuid];
	if (!mod || mod.caseType !== args.caseType) return false;
	let heldOpening: string | undefined;
	const byName = new Map(
		fields.filter(isRangeWithDefault).map((field) => [field.name, field]),
	);
	const savedById = new Map(
		(mod?.caseListConfig?.searchInputs ?? [])
			.filter(isRangeWithDefault)
			.map((field) => [field.uuid, field]),
	);
	const zone = resolveViewerTimeZone(args.viewerTimeZone);
	for (const name of names) {
		const field = byName.get(name);
		const saved = field && savedById.get(field.uuid);
		if (!saved) return false;
		const fieldDigest = canonicalJsonDigest(saved);
		if (fieldDigest !== canonicalJsonDigest(field)) return false;
		const literal = literalRangeDefault(saved.default);
		if (literal === undefined || values.has(name + ":opening")) {
			const receipt = values.get(name + ":opening");
			if (
				!receipt ||
				!/^[a-f0-9]{32}\.[a-f0-9]{64}(?:\.[a-f0-9]{64})?$/.test(receipt)
			)
				return false;
			const [opening, ...signatures] = receipt.split(".");
			if (heldOpening !== undefined && heldOpening !== opening) return false;
			heldOpening = opening;
			const expected = signature(
				args,
				context,
				name,
				fieldDigest,
				opening,
				values,
			);
			if (
				!signatures.some((part) =>
					timingSafeEqual(Buffer.from(part, "hex"), expected),
				)
			)
				return false;
			continue;
		}
		const original = new Map<string, string>();
		setStartingRangeValues(
			original,
			name,
			literal,
			previewPlatformRules(context.device.platform).dayNumberEpoch,
			zone,
		);
		const matches = (answer: ReadonlyMap<string, string>) =>
			RANGE_ANSWER_SUFFIXES.every(
				(suffix) => answer.get(name + suffix) === values.get(name + suffix),
			);
		if (matches(original)) continue;
		if (context.device.platform !== "web-apps") return false;
		const shown = webSearchRangeDraft([saved], original, zone);
		if (shown.unavailable || !matches(shown.draft)) return false;
	}
	return true;
}
