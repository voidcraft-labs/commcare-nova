"use client";

import { useEffect, useRef, useState } from "react";
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
	const throughStep = useRef<number | undefined>(undefined);
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
		readAppTestAction(appId, selected, {
			afterStep: index - 1,
			limit: 1,
			throughStep: throughStep.current,
		}).then(
			(value) => {
				if (current) {
					setEvidence(value);
					throughStep.current = value.throughStep;
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
	}, [appId, selected, index]);
	const active =
		evidence && evidence.id === selected && evidence.steps[0]?.step === index
			? evidence
			: undefined;
	const step = active?.steps[0];
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
											setIndex(0);
											throughStep.current = undefined;
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
							Recorded step {step.step} of {active.throughStep}
						</p>
						{step.observation ? (
							<RecordedObservation observation={step.observation} />
						) : step.inspection ? (
							<EvidenceInspector
								key={`${selected}:${step.step}`}
								appId={appId}
								testId={active.id}
								throughStep={active.throughStep}
								step={step.step}
							/>
						) : null}
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
							disabled={index >= active.throughStep}
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
	const rendered = items(record(o.renderedResults).rows);
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
			{o.language && record(record(o.language).runtime).fallback === true ? (
				<p className="text-nova-text-muted">
					App text uses the selected language. Standard controls and validation
					use English.
				</p>
			) : null}
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
			{rendered.length ? (
				<ul className="space-y-3">
					{rendered.map((row) => (
						<li key={text(row.recordId)}>
							<dl>
								{items(row.cells).map((cell) => (
									<div key={text(cell.uuid)}>
										<dt className="text-nova-text-muted">{text(cell.label)}</dt>
										<dd>{text(cell.text)}</dd>
									</div>
								))}
							</dl>
						</li>
					))}
				</ul>
			) : rows.length ? (
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
			{items(o.fields).length ? (
				<dl className="space-y-2">
					{items(o.fields).map((field) => (
						<div key={text(field.uuid)}>
							<dt>{text(field.label)}</dt>
							<dd>{text(field.text)}</dd>
						</div>
					))}
				</dl>
			) : null}
			{o.canContinue === false ? (
				<p>This screen has no Continue action.</p>
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

function EvidenceInspector({
	appId,
	testId,
	throughStep,
	step,
}: {
	appId: string;
	testId: string;
	throughStep: number;
	step: number;
}) {
	const [address, setAddress] = useState<{
		path: (string | number)[];
		offset: number;
	}>({ path: [], offset: 0 });
	const [result, setResult] = useState<Evidence["inspection"]>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		let current = true;
		setResult(undefined);
		readAppTestAction(appId, testId, {
			throughStep,
			inspect: { step, ...address },
		}).then(
			(value) => {
				if (current) setResult(value.inspection);
			},
			() => {
				if (current)
					setError(
						"This part of the recorded step could not be loaded. Try opening it again.",
					);
			},
		);
		return () => {
			current = false;
		};
	}, [appId, testId, throughStep, step, address]);
	return (
		<div className="space-y-3">
			<p>
				This recorded step is large. Open its parts to read the complete
				evidence.
			</p>
			{error ? <p role="alert">{error}</p> : null}
			{address.path.length > 0 ? (
				<Button
					variant="ghost"
					onClick={() => {
						setError(undefined);
						setAddress({ path: address.path.slice(0, -1), offset: 0 });
					}}
				>
					Back to containing part
				</Button>
			) : null}
			{!result ? (
				<p role="status">Loading recorded evidence</p>
			) : result.kind === "value" ? (
				<pre className="whitespace-pre-wrap break-words text-xs">
					{JSON.stringify(result.value, null, 2)}
				</pre>
			) : result.kind === "string" ? (
				<pre className="whitespace-pre-wrap break-words">{result.text}</pre>
			) : (
				<ul className="space-y-2">
					{result.entries.map((entry) => (
						<li key={entry.key}>
							{entry.kind === "value" ? (
								<>
									<span className="font-medium">{entry.key}: </span>
									<span>{JSON.stringify(entry.value)}</span>
								</>
							) : (
								<Button
									variant="outline"
									onClick={() => {
										setError(undefined);
										setAddress({ path: [...entry.path], offset: 0 });
									}}
								>
									Open {entry.key}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			{result && "nextOffset" in result && result.nextOffset !== null ? (
				<Button
					variant="outline"
					onClick={() => {
						if (typeof result.nextOffset === "number")
							setAddress({ ...address, offset: result.nextOffset });
					}}
				>
					Next part
				</Button>
			) : null}
		</div>
	);
}
