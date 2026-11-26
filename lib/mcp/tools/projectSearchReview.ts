import type { inspectProjectSearchDestination } from "@/lib/deployment/store";
import {
	fitsReviewResult,
	lineParts,
	PIECE_MAX_CHARS,
	reviewedPageDigest,
} from "../paging";

type Review = Awaited<
	ReturnType<typeof inspectProjectSearchDestination>
>["review"];
type Cursor = { from: number; token: string };
export type SearchContractDetail = {
	searchUuid: string;
	menuUuid?: string;
	kind: "search" | "menu" | "parameter" | "result";
	text: string;
	endpointId?: number | null;
	type?: string;
	part?: number;
	parts?: number;
};

export function searchContractDetails(searches: Review["searches"]) {
	const details: SearchContractDetail[] = [];
	const add = (detail: SearchContractDetail) => {
		const parts = lineParts(detail.text, PIECE_MAX_CHARS - 512);
		for (const [index, text] of parts.entries()) {
			details.push(
				parts.length === 1
					? detail
					: {
							...detail,
							text,
							part: index + 1,
							parts: parts.length,
						},
			);
		}
	};
	for (const search of searches) {
		const searchUuid = search.searchUuid;
		add({
			kind: "search",
			searchUuid,
			text: search.name,
			endpointId: search.endpointId,
		});
		for (const menu of search.menus) {
			const menuUuid = menu.menuUuid;
			add({ kind: "menu", searchUuid, menuUuid, text: menu.name });
			for (const parameter of menu.parameters)
				add({ kind: "parameter", searchUuid, menuUuid, text: parameter });
			for (const field of menu.results)
				add({
					kind: "result",
					searchUuid,
					menuUuid,
					text: field.name,
					type: field.type,
				});
		}
	}
	return details;
}

/** A large destination review remains readable in named pieces, including a
 * single long label. The last page alone carries the reviewed write version. */
export function projectSearchReview(review: Review, page?: Cursor) {
	const complete = { ...review, next_page: null, restarted: !!page };
	if (fitsReviewResult(complete)) return complete;

	const details = searchContractDetails(review.searches);
	const cursor = (from: number) => ({
		from,
		token: reviewedPageDigest("search-connections", review.version, from),
	});
	const valid =
		page &&
		page.from < details.length &&
		cursor(page.from).token === page.token;
	const start = valid ? page.from : 0;
	const result = (end: number) => ({
		details: details.slice(start, end),
		version: end === details.length ? review.version : null,
		next_page: end === details.length ? null : cursor(end),
		restarted: !!page && !valid,
	});
	let low = start + 1;
	let high = details.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fitsReviewResult(result(mid))) low = mid;
		else high = mid - 1;
	}
	return result(low);
}
