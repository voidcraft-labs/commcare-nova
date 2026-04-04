/** Shared types for the knowledge sync pipeline */

export interface SpaceInfo {
	id: string;
	key: string;
	name: string;
}

export interface PageMeta {
	id: string;
	title: string;
	spaceKey: string;
	parentId: string | null;
	lastModified: string;
	url: string;
}

export interface DiscoveryResult {
	spaces: SpaceInfo[];
	pages: PageMeta[];
	timestamp: string;
}

export interface CrawledPage extends PageMeta {
	content: string;
	contentLength: number;
}

export interface TriageEntry {
	pageId: string;
	title: string;
	spaceKey: string;
	relevance: number;
	knowledgeType: string;
	topicTags: string[];
	quality: "rich" | "moderate" | "stub";
	reasoning: string;
}

export interface TriageResult {
	entries: TriageEntry[];
	timestamp: string;
	totalPages: number;
	passedPages: number;
}

export interface Cluster {
	name: string;
	filename: string;
	description: string;
	tags: string[];
}

export interface PipelineConfig {
	confluenceBaseUrl: string;
	confluenceEmail: string;
	confluenceApiToken: string;
	anthropicApiKey: string;
	rateLimitMs: number;
	triageBatchSize: number;
	skipConfirmation: boolean;
}
