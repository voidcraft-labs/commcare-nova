import { createHash } from "node:crypto";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { parseLanguageTag } from "@/lib/domain/localization";
import { lineParts } from "@/lib/utils/jsonTextParts";

const PAGE_LIMIT = 12_000;
type InstallationRow = {
	uuid: string;
	name: string;
	languages: ReturnType<typeof parseLanguageTag>[];
	requiresPracticeWorker: boolean;
};
type InstallationPart = {
	uuid: string;
	part: number;
	parts: number;
	text: string;
};
type Item = InstallationRow | InstallationPart;

/** This shared read reaches both the architect and SDK TextContent. Escaped
 * quotes/backslashes in the inner JSON also count in the host's budget. */
function answerSize(value: unknown) {
	return JSON.stringify({
		content: [{ type: "text", text: JSON.stringify(value) }],
	}).length;
}
export function installationAuthoringPage(doc: BlueprintDoc, cursor?: string) {
	const profiles = Object.values(doc.appSettings.installationProfiles ?? {});
	const hash = createHash("sha256").update(JSON.stringify(doc.appId));
	for (const profile of profiles)
		hash.update(
			JSON.stringify([
				profile.uuid,
				profile.name,
				profile.languages,
				profile.requiresPracticeWorker,
			]),
		);
	const digest = hash.digest("hex");
	let row = 0,
		part = 0;
	if (cursor !== undefined) {
		const match = /^([0-9a-f]{64}):(\d{1,12}):(\d{1,12})$/.exec(cursor);
		if (!match || match[1] !== digest || Number(match[2]) >= profiles.length)
			throw new Error(
				"The installations or the page changed. Start with an empty installations selection to read the current list.",
			);
		row = Number(match[2]);
		part = Number(match[3]);
	}
	const installations: Item[] = [];
	const result = (nextCursor: string | null) => ({
		installations,
		total: profiles.length,
		nextCursor,
	});
	for (; row < profiles.length; row++, part = 0) {
		const profile = profiles[row];
		const item: InstallationRow = {
			...profile,
			languages: profile.languages.map(parseLanguageTag),
		};
		const fragments: readonly string[] | null =
			answerSize(item) > 6_000
				? lineParts(JSON.stringify(item), 2_000, true)
				: null;
		const count = fragments?.length ?? 1;
		if (part >= count)
			throw new Error(
				"That installation page has no remaining entry. Restart the read from its first page.",
			);
		for (; part < count; part++) {
			const continuation = `${digest}:${row}:${part}`;
			const piece: Item = fragments
				? {
						uuid: profile.uuid,
						part: part + 1,
						parts: count,
						text: fragments[part],
					}
				: item;
			installations.push(piece);
			if (answerSize(result(continuation)) > PAGE_LIMIT) {
				installations.pop();
				if (!installations.length)
					throw new Error("An installation part exceeds its page budget.");
				return result(continuation);
			}
		}
	}
	return result(null);
}
