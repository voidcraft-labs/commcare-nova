/**
 * CaseDetailDialog: the whole case behind a review card, as a
 * scrollable vertical table (one property per row). Opened from the
 * data review screen so a decision about one waiting value can be made
 * while looking at everything else the case holds. Read-only: the
 * review rows own the actions.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { CaseProperty, CaseType } from "@/lib/domain";
import { useCaseData } from "@/lib/preview/hooks/useCaseDataBinding";
import { useAccessPhase } from "@/lib/session/hooks";
import { caseDetailRows } from "./caseDetailRows";
import { DATA_TYPE_LABELS } from "./dataReviewModel";
import { DATA_TYPE_ICONS, NameChip } from "./NameChip";

/** The property chip for one table row: declared properties carry
 * their current type as the icon; a saved key the schema no longer
 * declares keeps the case family's database mark. `case_name` is text
 * by definition, declared or not. */
function rowChip(id: string, decl: CaseProperty | undefined) {
	if (decl === undefined && id !== "case_name") return <NameChip label={id} />;
	const dataType = decl?.data_type ?? "text";
	return (
		<NameChip
			label={id}
			icon={DATA_TYPE_ICONS[dataType]}
			iconLabel={`${DATA_TYPE_LABELS[dataType]} property`}
		/>
	);
}

/** Placeholder table while the case row loads: the same column
 * geometry as the loaded table (a chip-shaped block in the w-40
 * name column, a value line beside it) so the swap doesn't jump. */
function LoadingTable() {
	const valueWidths = ["w-40", "w-24", "w-36", "w-16", "w-28"];
	return (
		<div>
			<p role="status" className="sr-only">
				Loading case…
			</p>
			{valueWidths.map((width) => (
				<div
					key={width}
					className="flex items-center gap-4 border-t border-nova-border py-2.5"
				>
					<div className="w-40 shrink-0">
						<Skeleton className="h-[18px] w-24 rounded-[4px]" />
					</div>
					<Skeleton className={`h-4 ${width}`} />
				</div>
			))}
		</div>
	);
}

export function CaseDetailDialog({
	appId,
	caseType,
	caseId,
	caseName,
	onClose,
}: {
	readonly appId: string | undefined;
	readonly caseType: CaseType;
	readonly caseId: string;
	readonly caseName: string;
	readonly onClose: () => void;
}) {
	const accessPhase = useAccessPhase();
	const projectProse = useProseProjection();
	const { state, reload } = useCaseData({
		appId,
		caseType: caseType.name,
		caseId,
		ancestorDepth: 0,
		// This dialog exists to inspect a case the review HOLDS out of
		// the running app: the one read that must see held rows.
		includeHeld: true,
	});

	const row = state.kind === "row" ? state.row : null;

	const rows = row === null ? [] : caseDetailRows(caseType, row, projectProse);

	return (
		<Dialog
			open={accessPhase === "authorized"}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{caseName || "Unnamed case"}</DialogTitle>
					<DialogDescription>
						Everything saved on this case right now
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					{state.kind === "loading" || state.kind === "idle" ? (
						<LoadingTable />
					) : state.kind === "error" ||
						state.kind === "unauthenticated" ||
						state.kind === "persona-unavailable" ? (
						<div role="alert">
							<p className="text-sm leading-relaxed text-nova-text-secondary">
								{state.kind === "error"
									? state.message
									: state.kind === "persona-unavailable"
										? state.message
										: "You're signed out. Reload the page to sign in again."}
							</p>
							<Button
								type="button"
								variant="outline"
								className="mt-3"
								onClick={() => void reload()}
							>
								<Icon icon={tablerRefresh} />
								Try again
							</Button>
						</div>
					) : row === null ? (
						<p className="text-sm leading-relaxed text-nova-text-secondary">
							This case isn't here anymore. It may have been removed or
							replaced.
						</p>
					) : (
						<table className="w-full border-collapse">
							<tbody>
								{rows.map(({ key, decl, value }) => (
									<tr key={key} className="border-t border-nova-border">
										<th
											scope="row"
											className="w-40 py-2.5 pr-4 text-left align-top font-normal"
										>
											{rowChip(key, decl)}
										</th>
										<td className="py-2.5 align-top text-sm leading-relaxed break-words text-nova-text [overflow-wrap:anywhere]">
											{value === "" ? (
												<span className="text-nova-text-muted">Empty</span>
											) : (
												value
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
