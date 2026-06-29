import type { PreviewTransform, ProcessingSettings } from './types';

export const DEFAULT_PROCESSING: ProcessingSettings = {
	grayscale: false,
	thresholdEnabled: false,
	threshold: 155,
	contrast: 0,
};

export const MIN_CROP_RATIO = 0.01;
export const MIN_BATCH_WORKERS = 2;
export const MAX_BATCH_WORKERS = 4;
export const MIN_PREVIEW_SCALE = 1;
export const MAX_PREVIEW_SCALE = 4;
export const PREVIEW_SCALE_STEP = 0.2;
export const DEFAULT_VIDEO_FRAME_INTERVAL = 1.5;
export const MIN_VIDEO_FRAME_INTERVAL = 0.5;
export const MAX_VIDEO_FRAME_INTERVAL = 5;
export const MAX_VIDEO_FRAMES = 120;
export const VIDEO_FRAME_MAX_EDGE = 1600;

export const DEFAULT_PREVIEW_TRANSFORM: PreviewTransform = {
	scale: 1,
	x: 0,
	y: 0,
};

export const BATCH_QUEUE_DB_NAME = 'da-ocr';
export const BATCH_QUEUE_STORE_NAME = 'state';
export const BATCH_QUEUE_STORAGE_KEY = 'batch-queue';
