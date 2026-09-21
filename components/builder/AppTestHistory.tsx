"use client";

import { useEffect, useState } from "react";
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
import {
	listAppTestsAction,
	readAppTestAction,
} from "@/lib/preview/app-tests/actions";

type List = Awaited<ReturnType<typeof listAppTestsAction>>;
type Evidence = Awaited<ReturnType<typeof readAppTestAction>>;

export function AppTestHistory({
	appId,
	open,
	onOpenChange,
}: {
	appId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Test journeys</DialogTitle>
					<DialogDescription>
						Recorded steps using disposable records. These observations do not
						change live records or prove the whole app works.
					</DialogDescription>
				</DialogHeader>
				{open ? <HistoryBody key={appId} appId={appId} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function HistoryBody({ appId }: { appId: string }) {
	const [list, setList] = useState<List>();
	const [selected, setSelected] = useState<string>();
	const [evidence, setEvidence] = useState<Evidence>();
	const [index, setIndex] = useState(0);
	const [error, setError] = useState<string>();
	useEffect(() => {
		let current = true;
		listAppTestsAction(appId).then(
			(value) => {
				if (current) setList(value);
			},
			() => {
				if (current)
					setError(
						"The test journeys could not be loaded. Close this window and try again.",
					);
			},
		);
		return () => {
			current = false;
		};
	}, [appId]);
	useEffect(() => {
		if (!selected) return;
		let current = true;
		readAppTestAction(appId, selected).then(
			(value) => {
				if (current) {
					setEvidence(value);
					setIndex(0);
				}
			},
			() => {
				if (current)
					setError(
						"This test could not be opened. Return to the journeys and try again.",
					);
			},
		);
		return () => {
			current = false;
		};
	}, [appId, selected]);
	const active = evidence?.id === selected ? evidence : undefined;
	const step = active?.steps[index];
	return (
		<>
			<DialogBody className="space-y-4">
				{error ? <p role="alert">{error}</p> : null}
				{!selected ? (
					!list ? (
						<p role="status">Loading test journeys</p>
					) : list.tests.length === 0 ? (
						<p>No test journeys have been recorded for this app.</p>
					) : (
						<ul className="space-y-2">
							{list.tests.map((test) => (
								<li key={test.id}>
									<Button
										variant="ghost"
										className="h-auto w-full justify-start whitespace-normal text-start"
										onClick={() => {
											setError(undefined);
											setSelected(test.id);
										}}
									>
										<span className="space-y-1">
											<span className="block">{test.purpose}</span>
											<span className="block text-xs text-nova-text-muted">
												{test.step} steps ·{" "}
												{new Date(test.created_at).toLocaleString()}
												{test.blueprint_seq !== list.currentBlueprintSeq
													? " · Earlier app revision"
													: ""}
											</span>
										</span>
									</Button>
								</li>
							))}
						</ul>
					)
				) : !active || !step ? (
					<p role="status">Loading recorded steps</p>
				) : (
					<>
						{active.blueprint_seq !== active.currentBlueprintSeq ? (
							<p className="text-nova-text-muted">
								The app has changed since this journey. These observations
								describe the earlier revision.
							</p>
						) : null}
						<p className="text-xs text-nova-text-muted">
							Recorded step {step.step} of {active.step}
						</p>
						<RecordedObservation observation={step.observation} />
					</>
				)}
			</DialogBody>
			<DialogFooter>
				{selected ? (
					<Button
						variant="ghost"
						onClick={() => {
							setSelected(undefined);
							setError(undefined);
						}}
					>
						All journeys
					</Button>
				) : null}
				{active ? (
					<>
						<Button
							variant="outline"
							disabled={index === 0}
							onClick={() => setIndex(index - 1)}
						>
							Previous step
						</Button>
						<Button
							variant="outline"
							disabled={index >= active.steps.length - 1}
							onClick={() => setIndex(index + 1)}
						>
							Next step
						</Button>
					</>
				) : null}
			</DialogFooter>
		</>
	);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function text(value: unknown): string {
	return typeof value === "string"
		? value
		: typeof value === "number"
			? String(value)
			: "";
}
function items(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record) : [];
}

function RecordedObservation({
	observation: o,
}: {
	observation: Record<string, unknown>;
}) {
	const worker = text(record(o.worker).name);
	const role = text(record(o.worker).role);
	const places = items(record(o.worker).places);
	const questions = items(o.questions).filter(
		(question) => question.visible === true,
	);
	const search = record(o.search);
	const searchAnswers = new Map(
		items(search.answers).map((answer) => [
			text(answer.name),
			text(answer.value),
		]),
	);
	const rows = items(record(o.results).rows);
	const effects = items(record(record(o.effects).caseDatabasePatch).rows);
	const menus = [...items(o.menus), ...items(o.forms)];
	const error = text(o.error) || text(o.nextTaskError);
	return (
		<div className="space-y-4 break-words">
			<div>
				<h3 className="font-medium">
					{text(o.name) ||
						(o.ended ? "Test records discarded" : "Journey observation")}
				</h3>
				{worker ? (
					<p className="text-nova-text-muted">Preview as {worker}</p>
				) : null}
				{role ? <p>Role: {role}</p> : null}
				{places.length ? (
					<p>
						Places:{" "}
						{places
							.map(
								(place) =>
									`${text(place.name)}${place.testOnly ? " (test only)" : ""}`,
							)
							.join(", ")}
						{record(o.worker).assignmentTestOnly
							? ". Assigned for this test only."
							: ""}
					</p>
				) : null}
			</div>
			{error ? <p role="alert">{error}</p> : null}
			{o.boundary ? (
				<p className="text-nova-text-muted">{text(o.boundary)}</p>
			) : null}
			{o.savedInTest === true ? (
				<p>Submitted to test records.</p>
			) : o.savedInTest === false ? (
				<p>The form was not submitted.</p>
			) : null}
			{menus.length ? (
				<ul className="space-y-2">
					{menus.map((item, index) => (
						<li key={text(item.uuid) || index}>
							{text(item.name)}
							{item.visibility !== "shown" ? (
								<span className="text-nova-text-muted">
									{" "}
									· Not available to this worker
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{items(search.questions).length ? (
				<dl className="space-y-3">
					{items(search.questions).map((question) => (
						<div key={text(question.name)}>
							<dt className="font-medium">{text(question.label)}</dt>
							{question.hint ? (
								<dd className="text-nova-text-muted">{text(question.hint)}</dd>
							) : null}
							<dd>{searchAnswers.get(text(question.name)) || "No answer"}</dd>
							{record(search.errors)[text(question.name)] ? (
								<dd role="alert">
									{text(record(search.errors)[text(question.name)])}
								</dd>
							) : null}
						</div>
					))}
				</dl>
			) : null}
			{questions.length ? (
				<dl className="space-y-3">
					{questions.map((question, index) => (
						<div key={text(question.path) || index}>
							<dt className="font-medium">
								{text(question.label) || "Question"}
								{question.required ? " (required)" : ""}
							</dt>
							{question.hint ? (
								<dd className="text-nova-text-muted">{text(question.hint)}</dd>
							) : null}
							<dd>{text(question.value) || "No answer"}</dd>
							{question.error ? (
								<dd className="text-nova-text-muted">{text(question.error)}</dd>
							) : null}
							{items(question.choices).length ? (
								<dd className="text-nova-text-muted">
									Choices:{" "}
									{items(question.choices)
										.map((choice) => text(choice.label))
										.join(", ")}
								</dd>
							) : null}
						</div>
					))}
				</dl>
			) : null}
			{rows.length ? (
				<ul className="space-y-2">
					{rows.map((row) => (
						<li key={text(row.case_id)}>
							{text(row.case_name) || "Unnamed record"}
						</li>
					))}
				</ul>
			) : o.results && record(o.results).kind === "empty" ? (
				<p>No matching records.</p>
			) : null}
			{effects.length ? (
				<div>
					<h4 className="font-medium">Saved test records</h4>
					<ul className="space-y-2">
						{effects.map((row) => (
							<li key={text(row.case_id)}>
								{text(row.case_name) || "Unnamed record"} ·{" "}
								{row.status === "closed" ? "Closed" : "Open"}
								<dl>
									{Object.entries(record(row.properties)).map(
										([key, value]) => (
											<div key={key} className="flex gap-2">
												<dt>{key}</dt>
												<dd>
													{Array.isArray(value)
														? value.map(text).join(", ")
														: text(value)}
												</dd>
											</div>
										),
									)}
								</dl>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
