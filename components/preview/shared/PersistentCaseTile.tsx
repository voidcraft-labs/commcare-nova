// components/preview/shared/PersistentCaseTile.tsx
//
// The tile pinned above every form in a module whose case list asked to
// keep it there (`caseListConfig.tile.persistOnForms`). It is the same
// tile Results draws: same projection, same cells, same geometry:
// because both surfaces are driven by the one short detail, and a worker
// who picked a case from a tile must recognise the band above the form
// as that exact case.
//
// It is context, never a chooser: nothing here selects anything, so the
// cells stay ordinary content with no row action beneath them.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useMemo } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { Button } from "@/components/shadcn/button";
import { Skeleton } from "@/components/shadcn/skeleton";
import type { CaseListConfig, CaseProperty, CaseType } from "@/lib/domain";
import { orderedColumns } from "@/lib/domain";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import { tileResultsColumns } from "@/lib/preview/caseTileRendering";
import { useCaseData } from "@/lib/preview/hooks/useCaseDataBinding";
import { CaseTile } from "./CaseTile";
import { useColumnDisplayContext } from "./useColumnDisplayContext";

interface PersistentCaseTileProps {
	readonly appId: string | undefined;
	readonly caseType: string | undefined;
	/** The case the form is running against; absent means no tile at all. */
	readonly caseId: string | undefined;
	readonly config: CaseListConfig;
	/** The live compiler catalog, paired with `config` for the projection. */
	readonly caseTypes: readonly CaseType[];
	readonly fallbackProperties: readonly CaseProperty[];
}

export function PersistentCaseTile({
	appId,
	caseType,
	caseId,
	config,
	caseTypes,
	fallbackProperties,
}: PersistentCaseTileProps) {
	/* A read of its own, with the display config attached, so calculated
	 * cells project exactly as they did in Results. The form's own case
	 * read deliberately carries no display config: it feeds the engine,
	 * not a screen, and widening it would put this band's concerns inside
	 * the engine's preload identity. */
	const { state, reload } = useCaseData({
		appId,
		caseType,
		caseId,
		ancestorDepth: 0,
		caseListConfig: config,
		caseTypes,
		// The tile pinned above a running form draws the case the worker
		// selected on their device.
		deviceScoped: true,
	});
	const displayContext = useColumnDisplayContext(
		config,
		caseType,
		fallbackProperties,
	);
	const tileColumns = useMemo(
		() => tileResultsColumns(orderedColumns(config, "list"), config.tile),
		[config.columns, config.tile, config],
	);
	const projection = useMemo(
		() => projectTileGrid(tileColumns.map((entry) => entry.column)),
		[tileColumns],
	);

	if (caseId === undefined || projection.cells.length === 0) return null;

	return (
		<div
			data-persistent-case-tile
			className="sticky top-0 z-20 shrink-0 border-b border-pv-input-border bg-pv-bg"
		>
			<ContentFrame width="5xl" className="px-6 py-3">
				<div className="w-full min-w-[18rem] overflow-x-auto">
					{state.kind === "row" ? (
						<CaseTile
							projection={projection}
							columns={tileColumns}
							row={state.row}
							caseProperties={displayContext.caseProperties}
							displayContext={displayContext}
							surface="persistent"
						/>
					) : state.kind === "idle" || state.kind === "loading" ? (
						<Skeleton
							className="h-14 w-full max-w-3xl rounded-lg"
							aria-label="Loading this case"
						/>
					) : (
						<CaseUnavailableNotice
							kind={state.kind}
							onRetry={() => void reload()}
						/>
					)}
				</div>
			</ContentFrame>
		</div>
	);
}

/**
 * The band still says something when the case behind it can't be shown:
 * a silently empty strip above a form reads as a rendering bug. Retry is
 * offered only where retrying can change the answer.
 */
function CaseUnavailableNotice({
	kind,
	onRetry,
}: {
	readonly kind:
		| "missing"
		| "error"
		| "unauthenticated"
		| "persona-unavailable";
	readonly onRetry: () => void;
}) {
	return (
		<div role="status" className="flex flex-wrap items-center gap-3">
			<p className="text-[13px] leading-relaxed text-nova-text-secondary">
				{kind === "missing"
					? "This case is no longer available."
					: kind === "unauthenticated"
						? "You're signed out, so this case's information isn't showing."
						: kind === "persona-unavailable"
							? "Choose another worker to show this case's information."
							: "This case's information didn't load."}
			</p>
			{kind === "error" && (
				<Button
					type="button"
					variant="ghost"
					onClick={onRetry}
					className="gap-1.5 rounded-md px-2 text-[13px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] not-disabled:hover:text-nova-violet-bright"
				>
					<Icon icon={tablerRefresh} width="14" height="14" />
					Try again
				</Button>
			)}
		</div>
	);
}
