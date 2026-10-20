/**
 * Works out each pressed search's device values on the session, as the
 * device does when it sends the request, and records them on the module's
 * search (`PreviewSearchState.deviceValues`).
 *
 * It sits beside the case database and lookup providers, above every
 * screen, so a search's values are worked out from its Search press however
 * the worker moves on: Results leaving before they are in doesn't stop them,
 * and nothing works them out later, after a claim has changed the device's
 * cases. The module's Results and forms wait for this record
 * (`useSubmittedSearchDeviceValues`'s `waitsForRecord`).
 */
"use client";

import { useState } from "react";
import type { BlueprintDoc } from "@/lib/domain";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import {
	usePreviewSearchesAwaitingDeviceValues,
	useRecordPreviewSearchDeviceValues,
} from "@/lib/session/hooks";
import type { SearchAwaitingDeviceValues } from "@/lib/session/previewSearchState";
import {
	useCaseListStepSession,
	useSubmittedSearchDeviceValues,
} from "./useSearchCsqlRuntime";

export function SearchDeviceValuesRecorder() {
	const awaiting = usePreviewSearchesAwaitingDeviceValues();
	const { doc } = usePreviewMenuSource();
	return (
		<>
			{awaiting.map((search) => (
				<SearchDeviceValuesJob
					key={`${search.moduleUuid}\u0000${search.submission}`}
					doc={doc}
					search={search}
				/>
			))}
		</>
	);
}

function SearchDeviceValuesJob({
	doc,
	search,
}: {
	readonly doc: BlueprintDoc;
	readonly search: SearchAwaitingDeviceValues;
}) {
	const record = useRecordPreviewSearchDeviceValues();
	const moduleUuid = doc.modules[search.moduleUuid]?.uuid;
	const stepSession = useCaseListStepSession(doc, moduleUuid);
	/* One job per search (its key), so its answers never change. */
	const [submission] = useState(() => ({
		key: search.submission,
		answers: new Map(Object.entries(search.answers)),
	}));
	useSubmittedSearchDeviceValues({
		doc,
		moduleUuid,
		submission,
		onWorkedOut: (key, values) => record(search.moduleUuid, key, values.value),
		sessionData: stepSession.data,
	});
	return null;
}
