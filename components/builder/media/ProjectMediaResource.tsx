/** Project-authorized media resources with synchronous scope retirement. */

"use client";

import {
	type ComponentPropsWithoutRef,
	type RefObject,
	useLayoutEffect,
	useRef,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { useAccessPhase, useProjectScopeEpoch } from "@/lib/session/hooks";
import { mediaSrc } from "./mediaClient";

type ProjectResourceElement =
	| HTMLImageElement
	| HTMLMediaElement
	| HTMLIFrameElement;

/** Remove an authorized resource in the synchronous Project-reset stack. React
 * will subsequently unmount it while access is unresolved, but waiting for a
 * render would leave decoded source pixels or active playback alive between the
 * boundary and the commit. */
function retireResource(element: ProjectResourceElement | null): void {
	if (!element) return;
	if (element instanceof HTMLMediaElement) {
		element.pause();
		element.removeAttribute("src");
		/* `load()` drops the selected media resource and current video frame in
		 * addition to stopping playback. Native HTMLMediaElement.load is sync. */
		element.load();
		return;
	}
	element.removeAttribute("src");
}

function useProjectResource<T extends ProjectResourceElement>(
	assetId: string,
): {
	ref: RefObject<T | null>;
	scopeKey: string;
	src: string | undefined;
} {
	const resourceUrl = useProjectMediaUrl(assetId);
	const reconciler = useReconcilerContext();
	const ref = useRef<T>(null);

	useLayoutEffect(() => {
		return reconciler?.subscribeProjectScopeReset(() => {
			retireResource(ref.current);
		});
	}, [reconciler]);

	return { ref, scopeKey: resourceUrl.scopeKey, src: resourceUrl.src };
}

/** Authorized URL for non-embedded uses such as a download link. Resource
 * elements should use the wrappers below so they also get synchronous teardown. */
export function useProjectMediaUrl(assetId: string): {
	scopeKey: string;
	src: string | undefined;
} {
	const phase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const baseSrc = mediaSrc(assetId);
	/* Built-ins are public app bytes rather than Project-owned uploads. They still
	 * unmount with the access boundary, but do not need an authorization cache
	 * key. Uploaded bytes get a new URL for every Project generation so a fresh
	 * authorized mount cannot reuse a decoded response from the source scope. */
	const src =
		phase !== "authorized"
			? undefined
			: isBuiltinIconRef(assetId)
				? baseSrc
				: `${baseSrc}?scope=${scopeEpoch}`;
	return { scopeKey: `${scopeEpoch}:${assetId}`, src };
}

type ProjectMediaImageProps = Omit<
	ComponentPropsWithoutRef<"img">,
	"src" | "alt"
> & {
	assetId: string;
	alt: string;
};

export function ProjectMediaImage({
	assetId,
	alt,
	...props
}: ProjectMediaImageProps) {
	const resource = useProjectResource<HTMLImageElement>(assetId);
	if (!resource.src) return null;
	return (
		// biome-ignore lint/performance/noImgElement: session-authed Project proxy; next/image cannot carry cookie authorization
		<img
			key={resource.scopeKey}
			ref={resource.ref}
			src={resource.src}
			alt={alt}
			{...props}
		/>
	);
}

type ProjectMediaAudioProps = Omit<ComponentPropsWithoutRef<"audio">, "src"> & {
	assetId: string;
};

export function ProjectMediaAudio({
	assetId,
	...props
}: ProjectMediaAudioProps) {
	const resource = useProjectResource<HTMLAudioElement>(assetId);
	if (!resource.src) return null;
	return (
		<audio
			key={resource.scopeKey}
			ref={resource.ref}
			src={resource.src}
			{...props}
		/>
	);
}

type ProjectMediaVideoProps = Omit<ComponentPropsWithoutRef<"video">, "src"> & {
	assetId: string;
};

export function ProjectMediaVideo({
	assetId,
	...props
}: ProjectMediaVideoProps) {
	const resource = useProjectResource<HTMLVideoElement>(assetId);
	if (!resource.src) return null;
	return (
		<video
			key={resource.scopeKey}
			ref={resource.ref}
			src={resource.src}
			{...props}
		/>
	);
}

type ProjectMediaFrameProps = Omit<
	ComponentPropsWithoutRef<"iframe">,
	"src"
> & { assetId: string };

export function ProjectMediaFrame({
	assetId,
	...props
}: ProjectMediaFrameProps) {
	const resource = useProjectResource<HTMLIFrameElement>(assetId);
	if (!resource.src) return null;
	return (
		<iframe
			key={resource.scopeKey}
			ref={resource.ref}
			src={resource.src}
			{...props}
		/>
	);
}
