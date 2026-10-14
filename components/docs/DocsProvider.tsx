"use client";

import { FrameworkProvider, type ImageProps } from "fumadocs-core/framework";
import { useStaticSearch } from "fumadocs-core/search/client/orama-static";
import {
	SearchDialog,
	SearchDialogClose,
	SearchDialogContent,
	SearchDialogHeader,
	SearchDialogIcon,
	SearchDialogInput,
	SearchDialogList,
	SearchDialogOverlay,
	type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import {
	RootProvider,
	type RootProviderProps,
} from "fumadocs-ui/provider/base";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { type ComponentProps, createContext, type ReactNode, use } from "react";
import { useExternalNavigate } from "@/lib/routing/hooks";

const DocsBaseUrl = createContext("/");

/** Route identity is stable across the docs host's /docs rewrite. A raw
 * pathname describes the internal route on the server and the public URL in
 * the browser, so it cannot supply the page tree's hydration identity. */
function useDocsPathname() {
	const baseUrl = use(DocsBaseUrl).replace(/\/$/, "");
	const { slug } = useParams<{ slug?: string[] }>();
	const suffix = (slug ?? []).map(encodeURIComponent).join("/");
	return suffix ? `${baseUrl}/${suffix}` : baseUrl || "/";
}

function DocsLink({
	href,
	prefetch,
	...props
}: ComponentProps<"a"> & { prefetch?: boolean }) {
	return href ? (
		<Link {...props} href={href} prefetch={prefetch} />
	) : (
		<a {...props} />
	);
}

function DocsImage({ src, alt, width, height, ...props }: ImageProps) {
	return src ? (
		<Image
			{...props}
			src={src}
			alt={alt ?? ""}
			width={typeof width === "string" ? Number(width) : width}
			height={typeof height === "string" ? Number(height) : height}
		/>
	) : null;
}

function DocsSearchDialog(props: SharedProps) {
	const { locale } = useI18n();
	// Matches createFromSource(source).staticGET: the generated index is loaded
	// once and searched locally, through the provider-specific supported hook.
	const { error, ...search } = useStaticSearch({ locale });
	return (
		<SearchDialog {...search} {...props}>
			<SearchDialogOverlay />
			<SearchDialogContent>
				<SearchDialogHeader>
					<SearchDialogIcon />
					<SearchDialogInput />
					<SearchDialogClose />
				</SearchDialogHeader>
				{error && (
					<p
						role="status"
						className="px-4 py-3 text-sm text-fd-muted-foreground"
					>
						Couldn't search the docs. You can refresh the page to try again.
					</p>
				)}
				<SearchDialogList />
			</SearchDialogContent>
		</SearchDialog>
	);
}

/** Own the client search component reference and Nova's library translations. */
export function DocsProvider({
	children,
	i18n,
	baseUrl,
}: {
	children: ReactNode;
	i18n: RootProviderProps["i18n"];
	baseUrl: string;
}) {
	return (
		<DocsBaseUrl value={baseUrl}>
			<FrameworkProvider
				usePathname={useDocsPathname}
				useParams={useParams}
				useRouter={useExternalNavigate}
				Link={DocsLink}
				Image={DocsImage}
			>
				<RootProvider
					i18n={i18n}
					search={{ SearchDialog: DocsSearchDialog }}
					theme={{ enabled: false }}
				>
					{children}
				</RootProvider>
			</FrameworkProvider>
		</DocsBaseUrl>
	);
}
