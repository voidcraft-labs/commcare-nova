"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchInputDef, Uuid } from "@/lib/domain";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { viewerTimeZone } from "../engine/caseDataBindingClient";
import { openSearchRangesAction } from "../engine/openSearchRangesAction";
import type { PreviewDevice } from "../engine/previewDevice";
import { withNavigationWidth } from "../engine/previewDevice";
import {
	isRangeWithDefault,
	needsRangeOpening,
} from "../engine/searchRangeOpening";

type Read = Awaited<ReturnType<typeof openSearchRangesAction>>;
export interface SearchRangeTarget {
	appId: string;
	device: PreviewDevice;
	personaUuid?: string;
}

/** The field's expression and the worker select an opening. A clock tick,
 * fixture refresh or Results page can never replace its accepted values. */
export function useSearchRangeOpening(
	scope: string,
	moduleUuid: Uuid,
	fields: readonly SearchInputDef[],
	target: SearchRangeTarget | undefined,
	ready: boolean,
) {
	const sources = useMemo(
		() => fields.filter(isRangeWithDefault).filter(needsRangeOpening),
		[fields],
	);
	const [retry, setRetry] = useState(0);
	const zone = target && sources.length ? viewerTimeZone() : undefined;
	const appId = target?.appId;
	const device = target?.device;
	const persona = target?.personaUuid;
	const key = useMemo(
		() =>
			appId && sources.length && zone
				? canonicalJsonText([
						scope,
						appId,
						moduleUuid,
						device?.platform,
						device?.androidDeviceId,
						device?.appLanguage,
						persona,
						zone,
						sources,
						retry,
					])
				: undefined,
		[
			scope,
			appId,
			moduleUuid,
			device?.platform,
			device?.androidDeviceId,
			device?.appLanguage,
			persona,
			zone,
			sources,
			retry,
		],
	);
	const latest = useRef(target);
	latest.current = target;
	const request = useRef<{ key: string; promise: Promise<Read> }>(undefined);
	const [settled, setSettled] = useState<{ key: string; result: Read }>();
	useEffect(() => {
		if (!key) {
			request.current = undefined;
			setSettled(undefined);
			return;
		}
		if (!ready || !zone || !latest.current) return;
		const owner = latest.current;
		if (request.current?.key !== key) {
			request.current = {
				key,
				promise: openSearchRangesAction({
					appId: owner.appId,
					moduleUuid,
					personaUuid: owner.personaUuid,
					device: withNavigationWidth(owner.device),
					viewerTimeZone: zone,
				}),
			};
		}
		let current = true;
		request.current.promise.then(
			(result) => {
				if (current) setSettled({ key, result });
			},
			() => {
				if (current) setSettled({ key, result: { kind: "unavailable" } });
			},
		);
		return () => {
			current = false;
		};
	}, [key, ready, zone, moduleUuid]);
	const result =
		key !== undefined && settled?.key === key ? settled.result : undefined;
	const opened = useMemo(() => {
		if (result?.kind !== "opened") return undefined;
		const byUuid = new Map(sources.map((field) => [field.uuid, field]));
		const answers = new Map<Uuid, Readonly<Record<string, string>>>();
		for (const opening of result.fields) {
			const input = byUuid.get(opening.field.uuid);
			if (
				input &&
				canonicalJsonText(input) === canonicalJsonText(opening.field)
			)
				answers.set(input.uuid, opening.answers);
		}
		return answers;
	}, [result, sources]);
	return {
		pending: key !== undefined && !result,
		// A live edit can reach the running screen ahead of autosave. Reopening
		// after the edit is saved resolves the same sources the worker sees.
		retry:
			result?.kind === "unavailable" ||
			(result?.kind === "opened" && opened?.size !== sources.length)
				? () => setRetry((value) => value + 1)
				: undefined,
		message: result?.kind === "unavailable" ? result.message : undefined,
		refusal: result?.kind === "refused" ? result.reason : undefined,
		opened,
	};
}
