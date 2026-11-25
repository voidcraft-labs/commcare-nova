"use client";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import type { ActivityFact } from "@/lib/domain/connectSubmissionFacts";

export function SubmittedActivitiesDialog({
	facts,
	onClose,
}: {
	facts: readonly ActivityFact[];
	onClose: () => void;
}) {
	const [page, setPage] = useState(0);
	const perPage = 10;
	const offset = page * perPage;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Submitted activities</DialogTitle>
					<DialogDescription>
						These are the activities this form recorded in Preview.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<ol className="space-y-3" start={offset + 1}>
						{facts.slice(offset, offset + perPage).map((fact) => (
							<li
								key={JSON.stringify([fact.fieldUuid, fact.rows])}
								className="break-words"
							>
								<p className="font-medium">{fact.name ?? fact.id}</p>
								<p className="text-sm text-muted-foreground">
									{fact.kind === "delivery"
										? "Delivery"
										: fact.kind === "assessment"
											? "Assessment"
											: fact.kind === "learning-module"
												? "Learning module"
												: "Assigned task"}{" "}
									· {fact.id}
								</p>
								{fact.kind === "assessment" && <p>Score {fact.score}</p>}
								{fact.kind === "delivery" && (
									<dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
										<dt>Person or place ID</dt>
										<dd>{fact.entityId || "Empty"}</dd>
										{fact.entityName && (
											<>
												<dt>Name</dt>
												<dd>{fact.entityName}</dd>
											</>
										)}
										{fact.workAreaId && (
											<>
												<dt>Work area ID</dt>
												<dd>{fact.workAreaId}</dd>
											</>
										)}
									</dl>
								)}
								{fact.rows.length > 0 && (
									<p className="text-sm text-muted-foreground">
										Repeat {fact.rows.map((row) => row.index + 1).join(" / ")}
									</p>
								)}
							</li>
						))}
					</ol>
				</DialogBody>
				{facts.length > perPage && (
					<DialogFooter>
						<span className="mr-auto text-sm" aria-live="polite">
							{offset + 1} to {Math.min(offset + perPage, facts.length)} of{" "}
							{facts.length}
						</span>
						<Button
							variant="outline"
							disabled={page === 0}
							onClick={() => setPage(page - 1)}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							disabled={offset + perPage >= facts.length}
							onClick={() => setPage(page + 1)}
						>
							Next
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
