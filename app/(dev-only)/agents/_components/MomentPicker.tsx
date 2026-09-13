"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MomentSpec } from "@/lib/agent/anatomy/types";
import { selectableSegmentCls } from "@/lib/styles";

/** The role's moments as segments. The selected moment's reason sits
 * beneath, so the picker also teaches the lifecycle. */
export function MomentPicker({
	moments,
	current,
}: {
	moments: readonly MomentSpec[];
	current: MomentSpec;
}) {
	const params = useSearchParams();
	const hrefFor = (id: string) => {
		const next = new URLSearchParams(params.toString());
		next.set("moment", id);
		return `?${next.toString()}`;
	};
	return (
		<section aria-label="Moments" className="space-y-3">
			<div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 [scrollbar-width:none] md:mx-0 md:overflow-visible md:px-0">
				<div className="flex w-max gap-1 pb-1 md:w-auto md:flex-wrap">
					{moments.map((moment) => (
						<Link
							key={moment.id}
							href={hrefFor(moment.id)}
							replace
							scroll={false}
							aria-current={moment.id === current.id ? "true" : undefined}
							className={selectableSegmentCls(moment.id === current.id)}
						>
							{moment.label}
						</Link>
					))}
				</div>
			</div>
			<p className="max-w-[80ch] text-nova-text-secondary text-sm leading-relaxed">
				{current.why}
			</p>
		</section>
	);
}
