"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { selectableSegmentCls } from "@/lib/styles";

const SECTIONS = [
	{
		href: "/agents",
		label: "Map",
		match: (path: string) =>
			path === "/agents" ||
			(!path.startsWith("/agents/runs") && path.startsWith("/agents/")),
	},
	{
		href: "/agents/runs",
		label: "Runs",
		match: (path: string) => path.startsWith("/agents/runs"),
	},
] as const;

export function AnatomyNav() {
	const pathname = usePathname();
	return (
		<nav aria-label="Anatomy sections" className="flex items-center gap-1">
			{SECTIONS.map((section) => {
				const selected = section.match(pathname);
				return (
					<Link
						key={section.href}
						href={section.href}
						aria-current={selected ? "page" : undefined}
						className={selectableSegmentCls(selected)}
					>
						{section.label}
					</Link>
				);
			})}
		</nav>
	);
}
