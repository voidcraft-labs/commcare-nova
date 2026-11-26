import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { lineParts } from "@/lib/utils/jsonTextParts";
import type { InstallationPublishCheck } from "./installationProfilePublish";

type Review = Extract<InstallationPublishCheck, { kind: "review" }>;
// Includes JSON escaping, doubled where an MCP host wraps text in a tool result.
// The remaining envelope holds only a bounded target URL, counters and opaque IDs.
const PAGE_TEXT_CHARS = 9000;
const PIECE_CHARS = 5500;
export function isInstallationPage(token: string | undefined): boolean {
	return token?.startsWith("page:") ?? false;
}
export function installationReviewFits(review: Review): boolean {
	return JSON.stringify(review).length <= PAGE_TEXT_CHARS;
}

/** Navigation proves its exact page and complete actor/target/claim/save decision.
 * Only the last disclosure carries the actions that bind a destination or worker.
 * Long text is divided losslessly, including when a single physical key exceeds a page. */
export function installationDisclosure(
	review: Review,
	basis: string,
	continuation?: string,
): Review {
	if (installationReviewFits(review)) return review;
	const digest = canonicalJsonDigest({ basis, review });
	const token = (offset: number) =>
		`page:${offset}:${canonicalJsonDigest({ digest, offset })}`;
	const rows = [
		review.message,
		...review.details,
		...(review.choices ?? []).map((c, i) => `Choice ${i + 1}. ${c.label}`),
	];
	const parts = rows.flatMap((line) => lineParts(line, PIECE_CHARS));
	const page = Number(continuation?.split(":")[1]);
	const from =
		Number.isSafeInteger(page) &&
		page > 0 &&
		page < parts.length &&
		token(page) === continuation
			? page
			: 0;
	let used = 0;
	let end = from;
	while (end < parts.length) {
		const size = JSON.stringify(parts[end]).length + 2;
		if (used + size > PAGE_TEXT_CHARS) break;
		used += size;
		end++;
	}
	const more = end < parts.length;
	const choices = more
		? [{ label: "Read the next part", confirmation: token(end) }]
		: review.choices?.map((c, i) => ({
				label: `Choose item ${i + 1} from this review`,
				confirmation: c.confirmation,
			}));
	return {
		kind: "review",
		paged: true,
		message: `Installation review · parts ${from + 1}–${end} of ${parts.length}. ${more ? "Read the next part to continue." : "You’ve reached the end of this review."}`,
		details: parts.slice(from, end),
		...(choices && { choices }),
		...(!more && review.confirmation && { confirmation: review.confirmation }),
	};
}
