"use client";
import { useEffect, useState } from "react";
import { readPlacePageAction } from "@/lib/organization/actions";
import type { StoredLocation } from "./types";

export interface PlacePageRow extends StoredLocation {
	readonly path: readonly {
		id: string;
		name: string;
		siteCode: string;
		levelUuid: string;
		parentId: string | null;
		archivedAt: string | null;
	}[];
	readonly previousId: string | null;
	readonly hasNextSibling: boolean;
	readonly hasChildren: boolean;
	readonly gone: boolean;
}
export interface PlaceSearch {
	readonly appId: string;
	readonly revision: string;
	readonly parentId?: string | null;
	readonly levelIds?: readonly string[];
	readonly activeOnly?: boolean;
	readonly excludeId?: string;
}
interface Page {
	locations: readonly PlacePageRow[];
	matching: number;
	nextCursor: string | null;
}

export function usePlacePage(scope: PlaceSearch | undefined, query: string) {
	const filter = scope ? JSON.stringify({ ...scope, query }) : "";
	const [position, setPosition] = useState<{
		filter: string;
		stack: readonly string[];
	}>({ filter: "", stack: [] });
	const stack = position.filter === filter ? position.stack : [];
	const cursor = stack.at(-1);
	const [retry, setRetry] = useState(0);
	const key = JSON.stringify([filter, cursor, retry]);
	const viewKey = JSON.stringify([
		scope && { ...scope, revision: undefined },
		query,
		cursor,
	]);
	const [display, setDisplay] = useState<{
		key: string;
		viewKey: string;
		page?: Page;
		error?: string;
	}>();
	useEffect(() => {
		if (!filter) return;
		let current = true;
		const { appId, ...input } = JSON.parse(filter) as PlaceSearch & {
			query: string;
		};
		readPlacePageAction(appId, { ...input, cursor, limit: 40 }).then(
			(result) => {
				if (!current) return;
				setDisplay(
					result.success
						? { key, viewKey, page: result.data }
						: { key, viewKey, error: result.message },
				);
			},
			() => {
				if (current)
					setDisplay({
						key,
						viewKey,
						error:
							"Nova couldn’t load these places. Check your connection and try again.",
					});
			},
		);
		return () => {
			current = false;
		};
	}, [filter, cursor, key, viewKey]);
	const page = display?.viewKey === viewKey ? display.page : undefined;
	return {
		page,
		error: display?.key === key ? display.error : undefined,
		loading: !!filter && display?.key !== key,
		previous: stack.length
			? () => setPosition({ filter, stack: stack.slice(0, -1) })
			: undefined,
		next: page?.nextCursor
			? () =>
					setPosition({ filter, stack: [...stack, page.nextCursor as string] })
			: undefined,
		retry: () => setRetry((i) => i + 1),
	};
}
