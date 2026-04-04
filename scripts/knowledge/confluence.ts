/** Confluence REST API v2 client */

import type { SpaceInfo, PageMeta } from "./types.js";

export class ConfluenceClient {
	private baseUrl: string;
	private wikiPath: string;
	private headers: Record<string, string>;
	private rateLimitMs: number;

	constructor(
		baseUrl: string,
		email?: string,
		apiToken?: string,
		rateLimitMs = 100,
	) {
		// Strip trailing slash
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		// Extract the wiki path prefix (e.g., "/wiki") so we can rewrite pagination links.
		// The API returns _links.next as paths relative to the site origin (e.g., /wiki/api/v2/...),
		// but when using the cloud gateway the origin differs from the site origin.
		const parsed = new URL(this.baseUrl);
		this.wikiPath = parsed.pathname.replace(/\/+$/, "");
		this.headers = { Accept: "application/json" };
		if (email && apiToken) {
			this.headers.Authorization =
				"Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
		}
		this.rateLimitMs = rateLimitMs;
	}

	private async request<T>(url: string): Promise<T> {
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Confluence API ${res.status}: ${url} — ${text.slice(0, 200)}`,
			);
		}
		return res.json() as Promise<T>;
	}

	private async delay() {
		if (this.rateLimitMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));
		}
	}

	/** Resolve a _links.next path to a full URL using our baseUrl */
	private resolveNextLink(next: string): string {
		// _links.next is relative to the site origin (e.g., "/wiki/api/v2/spaces?cursor=...")
		// Strip the site-relative prefix ("/wiki") and append the API path to our baseUrl
		// This works for both direct URLs and cloud gateway URLs
		if (next.startsWith("/wiki/")) {
			return this.baseUrl + next.slice("/wiki".length);
		}
		if (next.startsWith("/")) {
			return this.baseUrl + next;
		}
		return this.baseUrl + "/" + next;
	}

	/** Paginate through all results for a v2 endpoint */
	private async paginate<T>(url: string): Promise<T[]> {
		interface Page {
			results: T[];
			_links?: { next?: string };
		}
		const results: T[] = [];
		let nextUrl: string | null = url;
		while (nextUrl) {
			await this.delay();
			const data: Page = await this.request<Page>(nextUrl);
			results.push(...data.results);
			const next = data._links?.next ?? null;
			nextUrl = next ? this.resolveNextLink(next) : null;
		}
		return results;
	}

	/** List all spaces */
	async listSpaces(): Promise<SpaceInfo[]> {
		const spaces = await this.paginate<{
			id: string;
			key: string;
			name: string;
		}>(`${this.baseUrl}/api/v2/spaces?limit=250`);
		return spaces.map((s) => ({ id: s.id, key: s.key, name: s.name }));
	}

	/** List all pages in a space (metadata only, no body) */
	async listPagesInSpace(spaceId: string): Promise<PageMeta[]> {
		const pages = await this.paginate<{
			id: string;
			title: string;
			spaceId: string;
			parentId: string | null;
			version?: { createdAt?: string };
			_links?: { webui?: string };
		}>(`${this.baseUrl}/api/v2/pages?space-id=${spaceId}&limit=250&sort=id`);

		return pages.map((p) => ({
			id: p.id,
			title: p.title,
			spaceKey: "", // Caller fills this in
			parentId: p.parentId ?? null,
			lastModified: p.version?.createdAt ?? "",
			url: p._links?.webui
				? `https://dimagi.atlassian.net/wiki${p._links.webui}`
				: "",
		}));
	}

	/** Get a single page with body content in storage format */
	async getPageContent(
		pageId: string,
	): Promise<{ body: string; lastModified: string }> {
		await this.delay();
		const page = await this.request<{
			body?: { storage?: { value?: string } };
			version?: { createdAt?: string };
		}>(`${this.baseUrl}/api/v2/pages/${pageId}?body-format=storage`);
		return {
			body: page.body?.storage?.value ?? "",
			lastModified: page.version?.createdAt ?? "",
		};
	}
}
