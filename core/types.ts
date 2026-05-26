export type DiffTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

export type DiffViewMode = "unified" | "split";

export type DiffLayoutMode = "stream" | "deck";

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export type RepoMetadata = {
	root: string;
	name: string;
	cwd: string;
};

export type ResolvedDiffTarget = DiffTarget & {
	label: string;
	subtitle: string;
	baseRev: string | null;
	headRev: string | null;
	hasHead: boolean;
};

export type DiffFileEntry = {
	id: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	status: DiffFileStatus;
	anchorId: string;
	isBinary: boolean;
	fingerprint?: string;
};

export type DiffFilePayload = {
	file: DiffFileEntry;
	diffText: string | null;
	message?: string;
};

export type ViewerBootstrapPayload = {
	viewerToken: string;
	repo: RepoMetadata;
	target: ResolvedDiffTarget;
	files: DiffFileEntry[];
	defaultViewMode: DiffViewMode;
	defaultLayoutMode: DiffLayoutMode;
	beadsEnabled: boolean;
	beadsConfigured: boolean;
	buildVersion: string;       // e.g. "0.1.0" or "0.1.0-dev+abc1234"
	buildKind: "release" | "dev";
};

export type ViewerSettingsResponse = {
	beadsEnabled: boolean;
	beadsConfigured: boolean;
};

export type LineCommentSide = "old" | "new";

export type DiffCommentBase = {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
	sentAt: number | null;
};

export type DiffLineComment = DiffCommentBase & {
	kind: "line";
	fileId: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	lineNumber: number;
	side: LineCommentSide;
	changeKey: string;
	excerpt?: string;
};

export type DiffFileComment = DiffCommentBase & {
	kind: "file";
	fileId: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
};

export type DiffOverallComment = DiffCommentBase & {
	kind: "overall";
};

export type DiffComment = DiffLineComment | DiffFileComment | DiffOverallComment;

export type SendCommentsResponse = {
	sentAt: number;
	formattedText: string;
};

export type DiffViewerData = {
	repo: RepoMetadata;
	target: ResolvedDiffTarget;
	files: DiffFileEntry[];
	filePayloads: Map<string, DiffFilePayload>;
};

export type ViewerSession = {
	token: string;
	bootstrap: ViewerBootstrapPayload;
	refreshBootstrap?: () => Promise<ViewerBootstrapPayload>;
	loadFile: (fileId: string) => Promise<DiffFilePayload | null>;
	sendComments: (comments: DiffComment[]) => Promise<SendCommentsResponse>;
	setBeadsEnabled?: (enabled: boolean) => Promise<ViewerSettingsResponse>;
	markDone?: () => Promise<void> | void;
};
