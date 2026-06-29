import { m } from '../../i18n';
import {
	BATCH_QUEUE_DB_NAME,
	BATCH_QUEUE_STORAGE_KEY,
	BATCH_QUEUE_STORE_NAME,
	MAX_BATCH_WORKERS,
	MAX_PREVIEW_SCALE,
	MIN_BATCH_WORKERS,
	MIN_CROP_RATIO,
	MIN_PREVIEW_SCALE,
} from './constants';
import type {
	BatchJob,
	BatchJobStatus,
	CompatibilityFeature,
	CropHandle,
	CropSelection,
	DetectedWord,
	ImageAsset,
	PersistedBatchQueue,
	PreparedImage,
	PreviewStageSize,
	PreviewTransform,
	ProcessingSettings,
} from './types';

export function getCompatibilityIssues(): CompatibilityFeature[] {
	if (typeof window === 'undefined') {
		return [];
	}

	const issues: CompatibilityFeature[] = [];

	if (typeof createImageBitmap !== 'function') {
		issues.push('create-image-bitmap');
	}

	if (
		typeof HTMLCanvasElement === 'undefined' ||
		!HTMLCanvasElement.prototype.toBlob
	) {
		issues.push('canvas-to-blob');
	}

	if (
		typeof File !== 'function' ||
		typeof URL === 'undefined' ||
		typeof URL.createObjectURL !== 'function'
	) {
		issues.push('file-api');
	}

	if (typeof FormData !== 'function') {
		issues.push('form-data');
	}

	if (typeof HTMLVideoElement === 'undefined') {
		issues.push('video-frame-extraction');
	}

	if (typeof ResizeObserver === 'undefined') {
		issues.push('resize-observer');
	}

	return issues;
}

export function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, value));
}

export function formatBytes(size: number) {
	if (size < 1024 * 1024) {
		return `${Math.max(1, Math.round(size / 1024))} KB`;
	}

	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function getDetectedLanguageLabel(language: string | null) {
	if (!language) {
		return 'Lens';
	}

	switch (language.toLowerCase()) {
		case 'de':
			return 'DE';
		case 'en':
			return 'EN';
		case 'ja':
		case 'jp':
			return 'JA';
		case 'th':
			return 'TH';
		default:
			return language.toUpperCase();
	}
}

export function getCompatibilityFeatureLabel(feature: CompatibilityFeature) {
	switch (feature) {
		case 'canvas-to-blob':
			return m.compatibility_feature_canvas_to_blob();
		case 'create-image-bitmap':
			return m.compatibility_feature_create_image_bitmap();
		case 'file-api':
			return m.compatibility_feature_file_api();
		case 'form-data':
			return m.compatibility_feature_form_data();
		case 'video-frame-extraction':
			return m.compatibility_feature_video_frame_extraction();
		default:
			return m.compatibility_feature_resize_observer();
	}
}

export function getSourceLabel(source: ImageAsset['source']) {
	switch (source) {
		case 'picker':
			return m.source_picker();
		case 'drop':
			return m.source_drop();
		default:
			return m.source_paste();
	}
}

export function applyContrast(value: number, contrast: number) {
	if (contrast === 0) {
		return value;
	}

	const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
	return Math.max(0, Math.min(255, factor * (value - 128) + 128));
}

export function sanitizeBaseName(name: string) {
	return (
		name
			.replace(/\.[^.]+$/, '')
			.replace(/[^a-z0-9-_]+/gi, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.toLowerCase() || 'ocr-result'
	);
}

export function getWordKey(word: DetectedWord) {
	return `${word.text}-${word.bbox.x0}-${word.bbox.y0}-${word.bbox.x1}-${word.bbox.y1}`;
}

export function getRunSignature(
	processing: ProcessingSettings,
	crop: CropSelection | null,
) {
	return JSON.stringify({ processing, crop });
}

export function translateCropSelection(
	crop: CropSelection,
	deltaX: number,
	deltaY: number,
) {
	const maxLeft = 1 - crop.width;
	const maxTop = 1 - crop.height;

	return {
		left: clamp(crop.left + deltaX, 0, maxLeft),
		top: clamp(crop.top + deltaY, 0, maxTop),
		width: crop.width,
		height: crop.height,
	};
}

export function resizeCropSelection(
	crop: CropSelection,
	handle: CropHandle,
	pointX: number,
	pointY: number,
) {
	let left = crop.left;
	let top = crop.top;
	let right = crop.left + crop.width;
	let bottom = crop.top + crop.height;

	switch (handle) {
		case 'nw':
			left = pointX;
			top = pointY;
			break;
		case 'ne':
			right = pointX;
			top = pointY;
			break;
		case 'sw':
			left = pointX;
			bottom = pointY;
			break;
		case 'se':
			right = pointX;
			bottom = pointY;
			break;
	}

	return normalizeCrop(
		clamp(left, 0, 1),
		clamp(top, 0, 1),
		clamp(right, 0, 1),
		clamp(bottom, 0, 1),
	);
}

export function getBatchStatusLabel(status: BatchJobStatus) {
	switch (status) {
		case 'cancelled':
			return m.batch_status_cancelled();
		case 'running':
			return m.batch_status_running();
		case 'done':
			return m.batch_status_done();
		case 'error':
			return m.batch_status_error();
		default:
			return m.batch_status_queued();
	}
}

export function clampPreviewTransform(
	transform: PreviewTransform,
	stage: PreviewStageSize,
) {
	const scale = clamp(transform.scale, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE);

	if (!stage.width || !stage.height || scale <= 1) {
		return {
			scale,
			x: 0,
			y: 0,
		};
	}

	const maxX = (stage.width * scale - stage.width) / 2;
	const maxY = (stage.height * scale - stage.height) / 2;

	return {
		scale,
		x: clamp(transform.x, -maxX, maxX),
		y: clamp(transform.y, -maxY, maxY),
	};
}

export function getWordBoxesCsv(words: DetectedWord[]) {
	return [
		['text', 'confidence', 'x0', 'y0', 'x1', 'y1'].join(','),
		...words.map((word) =>
			[
				JSON.stringify(word.text),
				word.confidence === null ? '' : word.confidence.toFixed(2),
				word.bbox.x0,
				word.bbox.y0,
				word.bbox.x1,
				word.bbox.y1,
			].join(','),
		),
	].join('\n');
}

export function getBatchWorkerCount(jobCount: number) {
	const availableCores =
		typeof navigator === 'undefined' ? 2 : (navigator.hardwareConcurrency ?? 2);
	return clamp(
		Math.min(
			jobCount,
			Math.max(MIN_BATCH_WORKERS, Math.floor(availableCores / 2)),
		),
		1,
		MAX_BATCH_WORKERS,
	);
}

function openBatchQueueDatabase() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB is not available in this browser.'));
			return;
		}

		const request = indexedDB.open(BATCH_QUEUE_DB_NAME, 1);

		request.onupgradeneeded = () => {
			const database = request.result;

			if (!database.objectStoreNames.contains(BATCH_QUEUE_STORE_NAME)) {
				database.createObjectStore(BATCH_QUEUE_STORE_NAME);
			}
		};

		request.onsuccess = () => {
			resolve(request.result);
		};

		request.onerror = () => {
			reject(request.error ?? new Error('Failed to open IndexedDB.'));
		};
	});
}

export function getBatchQueuePayload(
	batchJobs: BatchJob[],
	activeBatchJobId: string | null,
): PersistedBatchQueue {
	return {
		version: 1,
		activeBatchJobId,
		jobs: batchJobs.map((job) => ({
			...job,
			status: job.status === 'running' ? 'queued' : job.status,
			error: job.status === 'running' ? null : job.error,
		})),
	};
}

export async function readPersistedBatchQueue() {
	const database = await openBatchQueueDatabase();

	try {
		return await new Promise<PersistedBatchQueue | null>((resolve, reject) => {
			const transaction = database.transaction(
				BATCH_QUEUE_STORE_NAME,
				'readonly',
			);
			const store = transaction.objectStore(BATCH_QUEUE_STORE_NAME);
			const request = store.get(BATCH_QUEUE_STORAGE_KEY);

			request.onsuccess = () => {
				resolve((request.result as PersistedBatchQueue | undefined) ?? null);
			};

			request.onerror = () => {
				reject(request.error ?? new Error('Failed to read saved batch queue.'));
			};
		});
	} finally {
		database.close();
	}
}

export async function writePersistedBatchQueue(payload: PersistedBatchQueue) {
	const database = await openBatchQueueDatabase();

	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(
				BATCH_QUEUE_STORE_NAME,
				'readwrite',
			);
			const store = transaction.objectStore(BATCH_QUEUE_STORE_NAME);
			const request = store.put(payload, BATCH_QUEUE_STORAGE_KEY);

			request.onerror = () => {
				reject(request.error ?? new Error('Failed to persist batch queue.'));
			};

			transaction.oncomplete = () => {
				resolve();
			};

			transaction.onerror = () => {
				reject(
					transaction.error ?? new Error('Failed to persist batch queue.'),
				);
			};
		});
	} finally {
		database.close();
	}
}

export async function clearPersistedBatchQueue() {
	const database = await openBatchQueueDatabase();

	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(
				BATCH_QUEUE_STORE_NAME,
				'readwrite',
			);
			const store = transaction.objectStore(BATCH_QUEUE_STORE_NAME);
			const request = store.delete(BATCH_QUEUE_STORAGE_KEY);

			request.onerror = () => {
				reject(
					request.error ?? new Error('Failed to clear saved batch queue.'),
				);
			};

			transaction.oncomplete = () => {
				resolve();
			};

			transaction.onerror = () => {
				reject(
					transaction.error ?? new Error('Failed to clear saved batch queue.'),
				);
			};
		});
	} finally {
		database.close();
	}
}

export async function createThumbnailDataUrl(file: File) {
	const bitmap = await createImageBitmap(file);

	try {
		const maxEdge = 152;
		const scale = Math.min(maxEdge / bitmap.width, maxEdge / bitmap.height, 1);
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));

		const context = canvas.getContext('2d');

		if (!context) {
			return null;
		}

		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/jpeg', 0.82);
	} finally {
		bitmap.close();
	}
}

export function getCropPixels(
	crop: CropSelection | null,
	image: Pick<ImageAsset, 'width' | 'height'>,
) {
	if (!crop) {
		return null;
	}

	const width = Math.round(crop.width * image.width);
	const height = Math.round(crop.height * image.height);

	if (width < 2 || height < 2) {
		return null;
	}

	const x = Math.round(crop.left * image.width);
	const y = Math.round(crop.top * image.height);

	return {
		x: clamp(x, 0, Math.max(0, image.width - width)),
		y: clamp(y, 0, Math.max(0, image.height - height)),
		width: clamp(width, 1, image.width),
		height: clamp(height, 1, image.height),
	};
}

export function normalizeCrop(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
) {
	const left = Math.min(startX, endX);
	const top = Math.min(startY, endY);
	const width = Math.abs(endX - startX);
	const height = Math.abs(endY - startY);

	if (width < MIN_CROP_RATIO || height < MIN_CROP_RATIO) {
		return null;
	}

	return {
		left,
		top,
		width,
		height,
	};
}

export function downloadBlob(filename: string, blob: Blob) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	window.setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 0);
}

export function downloadJson(filename: string, value: unknown) {
	downloadBlob(
		filename,
		new Blob([JSON.stringify(value, null, 2)], {
			type: 'application/json;charset=utf-8',
		}),
	);
}

export async function readImageAsset(file: File, source: ImageAsset['source']) {
	const bitmap = await createImageBitmap(file);
	const asset = {
		name: file.name,
		size: file.size,
		type: file.type || 'image',
		url: URL.createObjectURL(file),
		width: bitmap.width,
		height: bitmap.height,
		source,
	} satisfies ImageAsset;
	bitmap.close();
	return asset;
}

export async function createProcessedImage(
	file: File,
	settings: ProcessingSettings,
	crop: CropSelection | null,
) {
	const bitmap = await createImageBitmap(file);
	const cropPixels = getCropPixels(crop, {
		width: bitmap.width,
		height: bitmap.height,
	});
	const sourceX = cropPixels?.x ?? 0;
	const sourceY = cropPixels?.y ?? 0;
	const sourceWidth = cropPixels?.width ?? bitmap.width;
	const sourceHeight = cropPixels?.height ?? bitmap.height;
	const canvas = document.createElement('canvas');
	canvas.width = sourceWidth;
	canvas.height = sourceHeight;

	const context = canvas.getContext('2d', { willReadFrequently: true });

	if (!context) {
		bitmap.close();
		throw new Error('Canvas preprocessing is not available in this browser.');
	}

	context.drawImage(
		bitmap,
		sourceX,
		sourceY,
		sourceWidth,
		sourceHeight,
		0,
		0,
		canvas.width,
		canvas.height,
	);
	bitmap.close();

	if (
		settings.grayscale ||
		settings.thresholdEnabled ||
		settings.contrast !== 0
	) {
		const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
		const data = imageData.data;

		for (let index = 0; index < data.length; index += 4) {
			let red = applyContrast(data[index], settings.contrast);
			let green = applyContrast(data[index + 1], settings.contrast);
			let blue = applyContrast(data[index + 2], settings.contrast);

			if (settings.grayscale || settings.thresholdEnabled) {
				const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
				red = luminance;
				green = luminance;
				blue = luminance;
			}

			if (settings.thresholdEnabled) {
				const thresholdValue = red >= settings.threshold ? 255 : 0;
				red = thresholdValue;
				green = thresholdValue;
				blue = thresholdValue;
			}

			data[index] = Math.round(red);
			data[index + 1] = Math.round(green);
			data[index + 2] = Math.round(blue);
		}

		context.putImageData(imageData, 0, 0);
	}

	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((value) => {
			if (!value) {
				reject(new Error('Failed to render the processed image.'));
				return;
			}

			resolve(value);
		}, 'image/png');
	});

	return {
		blob,
		url: URL.createObjectURL(blob),
		width: canvas.width,
		height: canvas.height,
		crop: cropPixels ? crop : null,
	} satisfies PreparedImage;
}

export function getContainLayout(
	container: PreviewStageSize,
	image: Pick<ImageAsset, 'width' | 'height'>,
) {
	if (!container.width || !container.height || !image.width || !image.height) {
		return null;
	}

	const imageRatio = image.width / image.height;
	const containerRatio = container.width / container.height;

	if (imageRatio > containerRatio) {
		const width = container.width;
		const height = width / imageRatio;

		return {
			width,
			height,
			left: 0,
			top: (container.height - height) / 2,
		};
	}

	const height = container.height;
	const width = height * imageRatio;

	return {
		width,
		height,
		left: (container.width - width) / 2,
		top: 0,
	};
}
