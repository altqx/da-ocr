export type ImageAsset = {
	name: string;
	size: number;
	type: string;
	url: string;
	width: number;
	height: number;
	source: 'paste' | 'picker' | 'drop';
};

export type StudioMode = 'image' | 'video' | 'audio';

export type VideoAsset = {
	name: string;
	size: number;
	type: string;
	url: string;
	width: number;
	height: number;
	duration: number;
};

export type AudioAsset = {
	name: string;
	size: number;
	type: string;
	url: string;
	duration: number;
	samples: Float32Array;
	sourceKind: 'audio' | 'video';
	originalName: string;
	originalSize: number;
	originalType: string;
};

export type CropSelection = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type CropHandle = 'nw' | 'ne' | 'sw' | 'se';

export type DetectedWord = {
	text: string;
	confidence: number | null;
	bbox: {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
	};
};

export type ProcessingSettings = {
	grayscale: boolean;
	thresholdEnabled: boolean;
	threshold: number;
	contrast: number;
};

export type PreviewStageSize = {
	width: number;
	height: number;
};

export type PreparedImage = {
	blob: Blob;
	url: string;
	width: number;
	height: number;
	crop: CropSelection | null;
};

export type OcrRunSnapshot = {
	detectedLanguage: string | null;
	processing: ProcessingSettings;
	crop: CropSelection | null;
	source: ImageAsset['source'];
	processedWidth: number;
	processedHeight: number;
	signature: string;
};

export type BatchJobStatus =
	| 'queued'
	| 'running'
	| 'done'
	| 'error'
	| 'cancelled';

export type VideoFrameStatus = 'queued' | 'running' | 'done' | 'error';

export type PreviewSurfaceKey = 'raw' | 'processed';

export type PreviewTransform = {
	scale: number;
	x: number;
	y: number;
};

export type BatchJob = {
	id: string;
	file: File;
	name: string;
	thumbnailDataUrl: string | null;
	source: ImageAsset['source'];
	status: BatchJobStatus;
	confidence: number | null;
	wordCount: number;
	lineCount: number;
	text: string;
	words: DetectedWord[];
	snapshot: OcrRunSnapshot | null;
	error: string | null;
};

export type VideoFrameResult = {
	id: string;
	index: number;
	time: number;
	status: VideoFrameStatus;
	thumbnailDataUrl: string | null;
	text: string;
	normalizedText: string;
	words: DetectedWord[];
	error: string | null;
};

export type VideoTimelineCue = {
	id: string;
	start: number;
	end: number;
	text: string;
	frameIndexes: number[];
};

export type SubtitleCue = {
	id: string;
	start: number;
	end: number;
	text: string;
};

export type AudioTimelineCue = SubtitleCue;

export type OcrExecutionResult =
	| {
			ok: true;
			text: string;
			words: DetectedWord[];
			confidence: number | null;
			snapshot: OcrRunSnapshot;
	  }
	| {
			ok: false;
			error: string;
	  }
	| null;

export type PersistedBatchQueue = {
	version: 1;
	activeBatchJobId: string | null;
	jobs: BatchJob[];
};

export type CompatibilityFeature =
	| 'canvas-to-blob'
	| 'create-image-bitmap'
	| 'file-api'
	| 'form-data'
	| 'video-frame-extraction'
	| 'resize-observer';
