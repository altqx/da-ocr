import { strToU8, zipSync } from 'fflate';
import {
	Check,
	ClipboardPaste,
	Copy,
	Crop,
	Download,
	Eye,
	EyeOff,
	ImagePlus,
	LoaderCircle,
	Move,
	RotateCcw,
	ScanText,
	Search,
	SearchX,
	SlidersHorizontal,
	X,
} from 'lucide-react';
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from 'react';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { m } from '../i18n';

type ImageAsset = {
	name: string;
	size: number;
	type: string;
	url: string;
	width: number;
	height: number;
	source: 'paste' | 'picker' | 'drop';
};

type CropSelection = {
	left: number;
	top: number;
	width: number;
	height: number;
};

type CropHandle = 'nw' | 'ne' | 'sw' | 'se';

type DetectedWord = {
	text: string;
	confidence: number;
	bbox: {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
	};
};

type ProcessingSettings = {
	grayscale: boolean;
	thresholdEnabled: boolean;
	threshold: number;
	contrast: number;
};

type PreviewStageSize = {
	width: number;
	height: number;
};

type PreparedImage = {
	blob: Blob;
	url: string;
	width: number;
	height: number;
	crop: CropSelection | null;
};

type OcrPage = Awaited<ReturnType<TesseractWorker['recognize']>>['data'];
type OcrBlock = NonNullable<OcrPage['blocks']>[number];
type OcrParagraph = OcrBlock['paragraphs'][number];
type OcrLine = OcrParagraph['lines'][number];
type OcrWord = OcrLine['words'][number];

type OcrRunSnapshot = {
	preset: OcrPresetCode;
	processing: ProcessingSettings;
	crop: CropSelection | null;
	source: ImageAsset['source'];
	processedWidth: number;
	processedHeight: number;
	signature: string;
};

type BatchJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

type PreviewSurfaceKey = 'raw' | 'processed';

type PreviewTransform = {
	scale: number;
	x: number;
	y: number;
};

type BatchJob = {
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

type OcrExecutionResult =
	| {
			ok: true;
			text: string;
			words: DetectedWord[];
			confidence: number;
			snapshot: OcrRunSnapshot;
	  }
	| {
			ok: false;
			error: string;
	  }
	| null;

type PersistedBatchQueue = {
	version: 1;
	activeBatchJobId: string | null;
	jobs: BatchJob[];
};

const OCR_PRESETS = [
	{ code: 'eng', shortLabel: 'EN' },
	{ code: 'deu', shortLabel: 'DE' },
	{ code: 'jpn', shortLabel: 'JP' },
	{ code: 'tha', shortLabel: 'TH' },
	{ code: 'eng+deu', shortLabel: 'EN+DE' },
	{ code: 'eng+jpn', shortLabel: 'EN+JP' },
	{ code: 'eng+tha', shortLabel: 'EN+TH' },
] as const;

type OcrPresetCode = (typeof OCR_PRESETS)[number]['code'];

const DEFAULT_PRESET: OcrPresetCode = 'eng';
const DEFAULT_PROCESSING: ProcessingSettings = {
	grayscale: false,
	thresholdEnabled: false,
	threshold: 155,
	contrast: 0,
};
const MIN_CROP_RATIO = 0.01;
const MIN_BATCH_WORKERS = 2;
const MAX_BATCH_WORKERS = 4;
const MIN_PREVIEW_SCALE = 1;
const MAX_PREVIEW_SCALE = 4;
const PREVIEW_SCALE_STEP = 0.2;
const DEFAULT_PREVIEW_TRANSFORM: PreviewTransform = {
	scale: 1,
	x: 0,
	y: 0,
};
const BATCH_QUEUE_DB_NAME = 'da-ocr';
const BATCH_QUEUE_STORE_NAME = 'state';
const BATCH_QUEUE_STORAGE_KEY = 'batch-queue';

function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(maximum, Math.max(minimum, value));
}

function formatBytes(size: number) {
	if (size < 1024 * 1024) {
		return `${Math.max(1, Math.round(size / 1024))} KB`;
	}

	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStatus(status?: string) {
	if (!status) {
		return m.status_processing_image();
	}

	return status
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(' ');
}

function getPresetLabel(preset: OcrPresetCode) {
	switch (preset) {
		case 'deu':
			return m.ocr_preset_deu();
		case 'jpn':
			return m.ocr_preset_jpn();
		case 'tha':
			return m.ocr_preset_tha();
		case 'eng+deu':
			return m.ocr_preset_eng_deu();
		case 'eng+jpn':
			return m.ocr_preset_eng_jpn();
		case 'eng+tha':
			return m.ocr_preset_eng_tha();
		default:
			return m.ocr_preset_eng();
	}
}

function getSourceLabel(source: ImageAsset['source']) {
	switch (source) {
		case 'picker':
			return m.source_picker();
		case 'drop':
			return m.source_drop();
		default:
			return m.source_paste();
	}
}

function applyContrast(value: number, contrast: number) {
	if (contrast === 0) {
		return value;
	}

	const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
	return Math.max(0, Math.min(255, factor * (value - 128) + 128));
}

function sanitizeBaseName(name: string) {
	return (
		name
			.replace(/\.[^.]+$/, '')
			.replace(/[^a-z0-9-_]+/gi, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.toLowerCase() || 'ocr-result'
	);
}

function getWordKey(word: DetectedWord) {
	return `${word.text}-${word.bbox.x0}-${word.bbox.y0}-${word.bbox.x1}-${word.bbox.y1}`;
}

function getRunSignature(
	processing: ProcessingSettings,
	crop: CropSelection | null,
) {
	return JSON.stringify({ processing, crop });
}

function translateCropSelection(
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

function resizeCropSelection(
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

function getBatchStatusLabel(status: BatchJobStatus) {
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

function clampPreviewTransform(
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

function getWordBoxesCsv(words: DetectedWord[]) {
	return [
		['text', 'confidence', 'x0', 'y0', 'x1', 'y1'].join(','),
		...words.map((word) =>
			[
				JSON.stringify(word.text),
				word.confidence.toFixed(2),
				word.bbox.x0,
				word.bbox.y0,
				word.bbox.x1,
				word.bbox.y1,
			].join(','),
		),
	].join('\n');
}

function getBatchWorkerCount(jobCount: number) {
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

function getBatchQueuePayload(
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

async function readPersistedBatchQueue() {
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

async function writePersistedBatchQueue(payload: PersistedBatchQueue) {
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

async function clearPersistedBatchQueue() {
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

async function createThumbnailDataUrl(file: File) {
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

function getCropPixels(
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

function normalizeCrop(
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

function downloadBlob(filename: string, blob: Blob) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	window.setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 0);
}

function downloadJson(filename: string, value: unknown) {
	downloadBlob(
		filename,
		new Blob([JSON.stringify(value, null, 2)], {
			type: 'application/json;charset=utf-8',
		}),
	);
}

async function readImageAsset(file: File, source: ImageAsset['source']) {
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

async function createProcessedImage(
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

function getContainLayout(
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

function extractOcrOutput(page: OcrPage) {
	const text = page.text.trim();
	const words = (page.blocks ?? [])
		.flatMap((block: OcrBlock) => block.paragraphs)
		.flatMap((paragraph: OcrParagraph) => paragraph.lines)
		.flatMap((line: OcrLine) => line.words)
		.filter((word: OcrWord) => word.text.trim())
		.map((word: OcrWord) => ({
			text: word.text,
			confidence: word.confidence,
			bbox: word.bbox,
		}));

	return {
		text,
		words,
		confidence: Math.round(page.confidence),
	};
}

export default function OcrStudio() {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const rawPreviewSurfaceRef = useRef<HTMLDivElement>(null);
	const processedPreviewSurfaceRef = useRef<HTMLDivElement>(null);
	const sourceFileRef = useRef<File | null>(null);
	const workerRef = useRef<TesseractWorker | null>(null);
	const rawUrlRef = useRef<string | null>(null);
	const processedUrlRef = useRef<string | null>(null);
	const copyTimerRef = useRef<number | null>(null);
	const runIdRef = useRef(0);
	const cropDragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
	} | null>(null);
	const cropResizeRef = useRef<{
		pointerId: number;
		handle: CropHandle;
		startCrop: CropSelection;
	} | null>(null);
	const cropMoveRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		startCrop: CropSelection;
	} | null>(null);
	const batchSchedulerRef = useRef<{
		terminate: () => Promise<unknown>;
	} | null>(null);
	const batchRunRef = useRef<{ id: number; cancelled: boolean } | null>(null);
	const batchRunIdRef = useRef(0);
	const previewPanRef = useRef<{
		pointerId: number;
		surface: PreviewSurfaceKey;
		startX: number;
		startY: number;
		startTransform: PreviewTransform;
	} | null>(null);

	const [asset, setAsset] = useState<ImageAsset | null>(null);
	const [processedPreview, setProcessedPreview] =
		useState<PreparedImage | null>(null);
	const [ocrText, setOcrText] = useState('');
	const [detectedWords, setDetectedWords] = useState<DetectedWord[]>([]);
	const [progress, setProgress] = useState(0);
	const [status, setStatus] = useState<string>(() => m.status_initial());
	const [ocrPreset, setOcrPreset] = useState<OcrPresetCode>(DEFAULT_PRESET);
	const [ocrLangOpen, setOcrLangOpen] = useState(false);
	const ocrLangRef = useRef<HTMLDivElement>(null);
	const [processing, setProcessing] =
		useState<ProcessingSettings>(DEFAULT_PROCESSING);
	const [cropEnabled, setCropEnabled] = useState(false);
	const [cropSelection, setCropSelection] = useState<CropSelection | null>(
		null,
	);
	const [isCropping, setIsCropping] = useState(false);
	const [isResizingCrop, setIsResizingCrop] = useState(false);
	const [isMovingCrop, setIsMovingCrop] = useState(false);
	const [confidence, setConfidence] = useState<number | null>(null);
	const [showBoxes, setShowBoxes] = useState(true);
	const [selectedWordIndex, setSelectedWordIndex] = useState<number | null>(
		null,
	);
	const [rawStageSize, setRawStageSize] = useState<PreviewStageSize>({
		width: 0,
		height: 0,
	});
	const [processedStageSize, setProcessedStageSize] =
		useState<PreviewStageSize>({
			width: 0,
			height: 0,
		});
	const [rawPreviewTransform, setRawPreviewTransform] =
		useState<PreviewTransform>(DEFAULT_PREVIEW_TRANSFORM);
	const [processedPreviewTransform, setProcessedPreviewTransform] =
		useState<PreviewTransform>(DEFAULT_PREVIEW_TRANSFORM);
	const [isPanMode, setIsPanMode] = useState(false);
	const [isPreviewPanning, setIsPreviewPanning] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lastRunSnapshot, setLastRunSnapshot] = useState<OcrRunSnapshot | null>(
		null,
	);
	const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
	const [activeBatchJobId, setActiveBatchJobId] = useState<string | null>(null);
	const [isBatchRunning, setIsBatchRunning] = useState(false);
	const [hasHydratedBatchQueue, setHasHydratedBatchQueue] = useState(false);

	const activeCrop = cropEnabled ? cropSelection : null;
	const deferredProcessing = useDeferredValue(processing);
	const deferredCrop = useDeferredValue(activeCrop);
	const initialStatus = m.status_initial();
	const currentSignature = getRunSignature(processing, activeCrop);
	const isBusy = isRunning || isBatchRunning;
	const batchProgress =
		batchJobs.length === 0
			? 0
			: batchJobs.filter(
					(job) =>
						job.status === 'done' ||
						job.status === 'error' ||
						job.status === 'cancelled',
				).length / batchJobs.length;

	const tearDownWorker = async () => {
		const activeWorker = workerRef.current;

		if (!activeWorker) {
			return;
		}

		workerRef.current = null;

		try {
			await activeWorker.terminate();
		} catch {
			// Ignore termination failures from interrupted runs.
		}
	};

	const tearDownBatchScheduler = useCallback(async () => {
		const activeScheduler = batchSchedulerRef.current;

		if (!activeScheduler) {
			return;
		}

		batchSchedulerRef.current = null;

		try {
			await activeScheduler.terminate();
		} catch {
			// Ignore scheduler teardown failures during cancellation.
		}
	}, []);

	const getStageSizeForSurface = useCallback(
		(surface: PreviewSurfaceKey) =>
			surface === 'raw' ? rawStageSize : processedStageSize,
		[processedStageSize, rawStageSize],
	);

	const getPreviewTransform = useCallback(
		(surface: PreviewSurfaceKey) =>
			surface === 'raw' ? rawPreviewTransform : processedPreviewTransform,
		[processedPreviewTransform, rawPreviewTransform],
	);

	const setPreviewTransformForSurface = useCallback(
		(
			surface: PreviewSurfaceKey,
			updater:
				| PreviewTransform
				| ((current: PreviewTransform) => PreviewTransform),
		) => {
			const applyUpdate = (current: PreviewTransform) =>
				typeof updater === 'function'
					? (updater as (value: PreviewTransform) => PreviewTransform)(current)
					: updater;

			if (surface === 'raw') {
				setRawPreviewTransform((current) =>
					clampPreviewTransform(
						applyUpdate(current),
						getStageSizeForSurface('raw'),
					),
				);
				return;
			}

			setProcessedPreviewTransform((current) =>
				clampPreviewTransform(
					applyUpdate(current),
					getStageSizeForSurface('processed'),
				),
			);
		},
		[getStageSizeForSurface],
	);

	const resetPreviewTransform = useCallback(
		(surface: PreviewSurfaceKey) => {
			setPreviewTransformForSurface(surface, DEFAULT_PREVIEW_TRANSFORM);
		},
		[setPreviewTransformForSurface],
	);

	const cancelBatchRun = useCallback(async () => {
		const activeRun = batchRunRef.current;

		if (!activeRun || activeRun.cancelled) {
			return;
		}

		activeRun.cancelled = true;
		await tearDownBatchScheduler();
		setIsBatchRunning(false);
		setProgress(1);
		setStatus(m.status_batch_cancelled());
		setBatchJobs((current) =>
			current.map((job) =>
				job.status === 'done' || job.status === 'error'
					? job
					: {
							...job,
							status: 'cancelled',
							error: m.batch_status_cancelled(),
						},
			),
		);
	}, [tearDownBatchScheduler]);

	const replaceSourceAsset = async (
		file: File,
		source: ImageAsset['source'],
	) => {
		sourceFileRef.current = file;

		if (rawUrlRef.current) {
			URL.revokeObjectURL(rawUrlRef.current);
		}

		const nextAsset = await readImageAsset(file, source);
		rawUrlRef.current = nextAsset.url;
		setRawPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
		setProcessedPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
		setIsPanMode(false);
		setAsset(nextAsset);
	};

	const runOcr = async (
		file: File,
		source: ImageAsset['source'],
		presetCode: OcrPresetCode = ocrPreset,
		cropOverride?: CropSelection | null,
	): Promise<OcrExecutionResult> => {
		const runId = ++runIdRef.current;
		const presetLabel = getPresetLabel(presetCode);
		const cropForRun = cropOverride === undefined ? activeCrop : cropOverride;
		const runProcessing = { ...processing };
		const runSignature = getRunSignature(runProcessing, cropForRun);

		setError(null);
		setCopied(false);
		setOcrText('');
		setDetectedWords([]);
		setSelectedWordIndex(null);
		setConfidence(null);
		setProgress(0);
		setStatus(m.status_processing_image());
		setIsRunning(true);
		setLastRunSnapshot(null);

		await tearDownWorker();

		try {
			const preparedImage = await createProcessedImage(
				file,
				runProcessing,
				cropForRun,
			);

			if (runId !== runIdRef.current) {
				URL.revokeObjectURL(preparedImage.url);
				return null;
			}

			if (processedUrlRef.current) {
				URL.revokeObjectURL(processedUrlRef.current);
			}

			processedUrlRef.current = preparedImage.url;
			setProcessedPreview(preparedImage);
			setProgress(0.08);
			setStatus(m.status_preparing_ocr({ language: presetLabel }));

			const { createWorker } = await import('tesseract.js');
			const worker = await createWorker(presetCode, 1, {
				logger: (message: { progress?: number; status?: string }) => {
					if (runId !== runIdRef.current) {
						return;
					}

					setStatus(formatStatus(message.status));

					if (typeof message.progress === 'number') {
						setProgress(Math.max(0, Math.min(1, message.progress)));
					}
				},
			});

			workerRef.current = worker;
			const result = await worker.recognize(preparedImage.blob);

			if (runId !== runIdRef.current) {
				return null;
			}

			const parsedOutput = extractOcrOutput(result.data);

			setOcrText(parsedOutput.text);
			setDetectedWords(parsedOutput.words);
			setConfidence(parsedOutput.confidence);
			setProgress(1);
			const snapshot = {
				preset: presetCode,
				processing: runProcessing,
				crop: preparedImage.crop,
				source,
				processedWidth: preparedImage.width,
				processedHeight: preparedImage.height,
				signature: runSignature,
			} satisfies OcrRunSnapshot;
			setLastRunSnapshot(snapshot);
			setStatus(
				parsedOutput.text
					? m.status_ocr_complete({ language: presetLabel })
					: m.status_no_text({ language: presetLabel.toLowerCase() }),
			);

			return {
				ok: true,
				text: parsedOutput.text,
				words: parsedOutput.words,
				confidence: parsedOutput.confidence,
				snapshot,
			};
		} catch (cause) {
			if (runId !== runIdRef.current) {
				return null;
			}

			const message =
				cause instanceof Error
					? cause.message
					: m.status_ocr_failed({ language: presetLabel });

			setError(message);
			setStatus(m.status_ocr_failed({ language: presetLabel }));
			return {
				ok: false,
				error: message,
			};
		} finally {
			if (runId === runIdRef.current) {
				setIsRunning(false);
			}

			await tearDownWorker();
		}
	};

	const handleImageFiles = async (
		files: File[] | FileList | null | undefined,
		source: ImageAsset['source'],
	) => {
		const nextFiles = Array.from(files ?? []).filter(Boolean);

		if (!nextFiles.length) {
			return;
		}

		const imageFiles = nextFiles.filter((file) =>
			file.type.startsWith('image/'),
		);

		if (!imageFiles.length) {
			setError(m.only_image_error());
			return;
		}

		if (imageFiles.length !== nextFiles.length) {
			setError(m.only_image_error());
		}

		const thumbnails = await Promise.all(
			imageFiles.map(async (file) => {
				try {
					return await createThumbnailDataUrl(file);
				} catch {
					return null;
				}
			}),
		);

		const jobs = imageFiles.map((file, index) => ({
			id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
			file,
			name: file.name,
			thumbnailDataUrl: thumbnails[index] ?? null,
			source,
			status: 'queued',
			confidence: null,
			wordCount: 0,
			lineCount: 0,
			text: '',
			words: [],
			snapshot: null,
			error: null,
		})) satisfies BatchJob[];

		if (jobs.length === 1) {
			setBatchJobs([]);
			setActiveBatchJobId(null);
			setCropSelection((current) => current);
			await replaceSourceAsset(jobs[0].file, source);
			await runOcr(jobs[0].file, source, ocrPreset);
			return;
		}

		setBatchJobs(jobs);
		setActiveBatchJobId(jobs[0]?.id ?? null);
		await replaceSourceAsset(jobs[0].file, source);
		setIsBatchRunning(true);
		setProgress(0);
		setStatus(m.status_batch_start({ count: jobs.length }));

		try {
			const batchRun = {
				id: ++batchRunIdRef.current,
				cancelled: false,
			};
			batchRunRef.current = batchRun;
			const batchPreset = ocrPreset;
			const batchProcessing = { ...processing };
			const batchCrop = activeCrop;
			const batchWorkerCount = getBatchWorkerCount(jobs.length);
			const { createScheduler, createWorker } = await import('tesseract.js');
			const scheduler = createScheduler();
			batchSchedulerRef.current = scheduler;

			const workers = await Promise.all(
				Array.from({ length: batchWorkerCount }, () =>
					createWorker(batchPreset, 1),
				),
			);

			for (const worker of workers) {
				scheduler.addWorker(worker);
			}

			setStatus(
				m.status_batch_running({
					current: 0,
					total: jobs.length,
					workers: batchWorkerCount,
				}),
			);

			let completedCount = 0;
			let nextJobIndex = 0;

			const runBatchJob = async (job: BatchJob) => {
				if (batchRunRef.current !== batchRun || batchRun.cancelled) {
					return;
				}

				setBatchJobs((current) =>
					current.map((entry) =>
						entry.id === job.id
							? { ...entry, status: 'running', error: null }
							: entry,
					),
				);

				const preparedImage = await createProcessedImage(
					job.file,
					batchProcessing,
					batchCrop,
				);

				if (batchRunRef.current !== batchRun || batchRun.cancelled) {
					URL.revokeObjectURL(preparedImage.url);
					return;
				}

				try {
					const result = await scheduler.addJob(
						'recognize',
						preparedImage.blob,
					);
					const parsedOutput = extractOcrOutput(result.data);
					const nextWordCount = parsedOutput.text.trim()
						? parsedOutput.text.trim().split(/\s+/).length
						: 0;
					const nextLineCount = parsedOutput.text
						? parsedOutput.text.split(/\n+/).filter(Boolean).length
						: 0;

					if (batchRunRef.current !== batchRun || batchRun.cancelled) {
						return;
					}

					setBatchJobs((current) =>
						current.map((entry) =>
							entry.id === job.id
								? {
										...entry,
										status: 'done',
										confidence: parsedOutput.confidence,
										wordCount: nextWordCount,
										lineCount: nextLineCount,
										text: parsedOutput.text,
										words: parsedOutput.words,
										snapshot: {
											preset: batchPreset,
											processing: batchProcessing,
											crop: preparedImage.crop,
											source: job.source,
											processedWidth: preparedImage.width,
											processedHeight: preparedImage.height,
											signature: getRunSignature(
												batchProcessing,
												preparedImage.crop,
											),
										},
										error: null,
									}
								: entry,
						),
					);
				} catch (cause) {
					if (batchRunRef.current !== batchRun || batchRun.cancelled) {
						return;
					}

					const message =
						cause instanceof Error ? cause.message : m.batch_status_cancelled();
					setBatchJobs((current) =>
						current.map((entry) =>
							entry.id === job.id
								? {
										...entry,
										status: 'error',
										error: message,
									}
								: entry,
						),
					);
				} finally {
					URL.revokeObjectURL(preparedImage.url);

					if (batchRunRef.current === batchRun && !batchRun.cancelled) {
						completedCount += 1;
						setProgress(completedCount / jobs.length);
						setStatus(
							m.status_batch_running({
								current: completedCount,
								total: jobs.length,
								workers: batchWorkerCount,
							}),
						);
					}
				}
			};

			const runners = Array.from({ length: batchWorkerCount }, async () => {
				while (
					batchRunRef.current === batchRun &&
					!batchRun.cancelled &&
					nextJobIndex < jobs.length
				) {
					const job = jobs[nextJobIndex];
					nextJobIndex += 1;
					await runBatchJob(job);
				}
			});

			await Promise.all(runners);

			if (batchRunRef.current === batchRun && !batchRun.cancelled) {
				setStatus(m.status_batch_done({ count: jobs.length }));
			}

			await tearDownBatchScheduler();
		} finally {
			batchRunRef.current = null;
			setIsBatchRunning(false);
			setProgress(1);
			await tearDownBatchScheduler();
		}
	};

	const handlePaste = useEffectEvent(async (event: ClipboardEvent) => {
		const imageFiles = Array.from(event.clipboardData?.items ?? [])
			.filter((item) => item.type.startsWith('image/'))
			.map((item) => item.getAsFile())
			.filter((file): file is File => Boolean(file));

		if (!imageFiles.length) {
			return;
		}

		event.preventDefault();

		await handleImageFiles(imageFiles, 'paste');
	});

	const restorePersistedBatchJob = useEffectEvent(async (jobId: string) => {
		const job = batchJobs.find(
			(entry) =>
				entry.id === jobId &&
				entry.status === 'done' &&
				Boolean(entry.snapshot),
		);

		if (!job?.snapshot || isBusy) {
			return;
		}

		setActiveBatchJobId(job.id);
		setOcrPreset(job.snapshot.preset);
		setProcessing(job.snapshot.processing);
		setCropEnabled(Boolean(job.snapshot.crop));
		setCropSelection(job.snapshot.crop);
		setOcrText(job.text);
		setDetectedWords(job.words);
		setSelectedWordIndex(null);
		setConfidence(job.confidence);
		setError(null);
		setCopied(false);
		setProgress(1);
		setLastRunSnapshot(job.snapshot);
		setStatus(m.status_batch_opened({ name: job.name }));
		await replaceSourceAsset(job.file, job.source);
	});

	useEffect(() => {
		if (!ocrLangOpen) return;
		const handle = (e: MouseEvent) => {
			if (!ocrLangRef.current?.contains(e.target as Node)) {
				setOcrLangOpen(false);
			}
		};
		document.addEventListener('mousedown', handle);
		return () => document.removeEventListener('mousedown', handle);
	}, [ocrLangOpen]);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			try {
				const persistedQueue = await readPersistedBatchQueue();

				if (cancelled || !persistedQueue?.jobs.length) {
					return;
				}

				setBatchJobs(
					persistedQueue.jobs.map((job) => ({
						...job,
						status: job.status === 'running' ? 'queued' : job.status,
						error: job.status === 'running' ? null : job.error,
					})),
				);
				setActiveBatchJobId(persistedQueue.activeBatchJobId);
			} catch {
				// Ignore persistence read failures and continue with an empty queue.
			} finally {
				if (!cancelled) {
					setHasHydratedBatchQueue(true);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!hasHydratedBatchQueue) {
			return;
		}

		void (async () => {
			try {
				if (!batchJobs.length) {
					await clearPersistedBatchQueue();
					return;
				}

				await writePersistedBatchQueue(
					getBatchQueuePayload(batchJobs, activeBatchJobId),
				);
			} catch {
				// Ignore persistence write failures to avoid blocking OCR interaction.
			}
		})();
	}, [activeBatchJobId, batchJobs, hasHydratedBatchQueue]);

	useEffect(() => {
		if (!hasHydratedBatchQueue || asset || !batchJobs.length || isBusy) {
			return;
		}

		const candidateJob = batchJobs.find(
			(job) =>
				job.id === activeBatchJobId &&
				job.status === 'done' &&
				Boolean(job.snapshot),
		);

		if (!candidateJob) {
			return;
		}

		void restorePersistedBatchJob(candidateJob.id);
	}, [activeBatchJobId, asset, batchJobs, hasHydratedBatchQueue, isBusy]);

	useEffect(() => {
		const onPaste = (event: ClipboardEvent) => {
			void handlePaste(event);
		};

		window.addEventListener('paste', onPaste);

		return () => {
			window.removeEventListener('paste', onPaste);
		};
	}, []);

	useEffect(() => {
		if (!asset && !processedPreview) {
			return;
		}

		const rawSurface = rawPreviewSurfaceRef.current;
		const processedSurface = processedPreviewSurfaceRef.current;

		if (!rawSurface && !processedSurface) {
			return;
		}

		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === rawSurface) {
					setRawStageSize({
						width: entry.contentRect.width,
						height: entry.contentRect.height,
					});
				}

				if (entry.target === processedSurface) {
					setProcessedStageSize({
						width: entry.contentRect.width,
						height: entry.contentRect.height,
					});
				}
			}
		});

		if (rawSurface) {
			resizeObserver.observe(rawSurface);
		}

		if (processedSurface) {
			resizeObserver.observe(processedSurface);
		}

		return () => {
			resizeObserver.disconnect();
		};
	}, [asset, processedPreview]);

	useEffect(() => {
		if (!asset || !sourceFileRef.current) {
			if (processedUrlRef.current) {
				URL.revokeObjectURL(processedUrlRef.current);
				processedUrlRef.current = null;
			}

			setProcessedPreview(null);
			return;
		}

		let cancelled = false;
		const file = sourceFileRef.current;

		void (async () => {
			try {
				const previewImage = await createProcessedImage(
					file,
					deferredProcessing,
					deferredCrop,
				);

				if (cancelled) {
					URL.revokeObjectURL(previewImage.url);
					return;
				}

				if (processedUrlRef.current) {
					URL.revokeObjectURL(processedUrlRef.current);
				}

				processedUrlRef.current = previewImage.url;
				setProcessedPreview(previewImage);
			} catch (cause) {
				if (!cancelled && cause instanceof Error) {
					setError(cause.message);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [asset, deferredCrop, deferredProcessing]);

	const getPointFromClient = useCallback(
		(clientX: number, clientY: number) => {
			const surface = rawPreviewSurfaceRef.current;
			const layout = asset ? getContainLayout(rawStageSize, asset) : null;

			if (!surface || !layout) {
				return null;
			}

			const rect = surface.getBoundingClientRect();
			const x = clientX - rect.left - layout.left;
			const y = clientY - rect.top - layout.top;

			if (x < 0 || y < 0 || x > layout.width || y > layout.height) {
				return null;
			}

			return {
				x: clamp(x / layout.width, 0, 1),
				y: clamp(y / layout.height, 0, 1),
			};
		},
		[asset, rawStageSize],
	);

	useEffect(() => {
		if (!isPreviewPanning) {
			return;
		}

		const handlePointerMove = (event: PointerEvent) => {
			const activePan = previewPanRef.current;

			if (!activePan) {
				return;
			}

			setPreviewTransformForSurface(activePan.surface, {
				...activePan.startTransform,
				x: activePan.startTransform.x + (event.clientX - activePan.startX),
				y: activePan.startTransform.y + (event.clientY - activePan.startY),
			});
		};

		const handlePointerEnd = () => {
			previewPanRef.current = null;
			setIsPreviewPanning(false);
		};

		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerEnd);
		window.addEventListener('pointercancel', handlePointerEnd);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerup', handlePointerEnd);
			window.removeEventListener('pointercancel', handlePointerEnd);
		};
	}, [isPreviewPanning, setPreviewTransformForSurface]);

	useEffect(() => {
		if (!isMovingCrop) {
			return;
		}

		const handlePointerMove = (event: PointerEvent) => {
			const activeMove = cropMoveRef.current;

			if (!activeMove) {
				return;
			}

			const point = getPointFromClient(event.clientX, event.clientY);

			if (!point) {
				return;
			}

			setCropSelection(
				translateCropSelection(
					activeMove.startCrop,
					point.x - activeMove.startX,
					point.y - activeMove.startY,
				),
			);
		};

		const handlePointerEnd = () => {
			cropMoveRef.current = null;
			setIsMovingCrop(false);
		};

		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerEnd);
		window.addEventListener('pointercancel', handlePointerEnd);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerup', handlePointerEnd);
			window.removeEventListener('pointercancel', handlePointerEnd);
		};
	}, [getPointFromClient, isMovingCrop]);

	useEffect(() => {
		if (!isResizingCrop) {
			return;
		}

		const handlePointerMove = (event: PointerEvent) => {
			const activeResize = cropResizeRef.current;

			if (!activeResize) {
				return;
			}

			const point = getPointFromClient(event.clientX, event.clientY);

			if (!point) {
				return;
			}

			setCropSelection(
				resizeCropSelection(
					activeResize.startCrop,
					activeResize.handle,
					point.x,
					point.y,
				),
			);
		};

		const handlePointerEnd = () => {
			cropResizeRef.current = null;
			setIsResizingCrop(false);
		};

		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerEnd);
		window.addEventListener('pointercancel', handlePointerEnd);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerup', handlePointerEnd);
			window.removeEventListener('pointercancel', handlePointerEnd);
		};
	}, [getPointFromClient, isResizingCrop]);

	useEffect(() => {
		return () => {
			runIdRef.current += 1;

			if (copyTimerRef.current) {
				window.clearTimeout(copyTimerRef.current);
			}

			if (rawUrlRef.current) {
				URL.revokeObjectURL(rawUrlRef.current);
			}

			if (processedUrlRef.current) {
				URL.revokeObjectURL(processedUrlRef.current);
			}

			void cancelBatchRun();
			void tearDownBatchScheduler();

			const activeWorker = workerRef.current;

			if (activeWorker) {
				workerRef.current = null;
				void activeWorker.terminate();
			}
		};
	}, [cancelBatchRun, tearDownBatchScheduler]);

	useEffect(() => {
		if (!asset && !ocrText && !error && !isRunning) {
			setStatus(initialStatus);
		}
	}, [asset, error, initialStatus, isRunning, ocrText]);

	const handleCopy = async () => {
		if (!ocrText) {
			return;
		}

		try {
			await navigator.clipboard.writeText(ocrText);
			setCopied(true);

			if (copyTimerRef.current) {
				window.clearTimeout(copyTimerRef.current);
			}

			copyTimerRef.current = window.setTimeout(() => {
				setCopied(false);
			}, 1800);
		} catch {
			setError(m.clipboard_error());
		}
	};

	const handleReset = async () => {
		await cancelBatchRun();
		runIdRef.current += 1;
		setAsset(null);
		setProcessedPreview(null);
		setOcrText('');
		setDetectedWords([]);
		setSelectedWordIndex(null);
		setProgress(0);
		setConfidence(null);
		setError(null);
		setCopied(false);
		setCropSelection(null);
		setCropEnabled(false);
		setLastRunSnapshot(null);
		setIsRunning(false);
		setBatchJobs([]);
		setActiveBatchJobId(null);
		setRawPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
		setProcessedPreviewTransform(DEFAULT_PREVIEW_TRANSFORM);
		setIsPanMode(false);
		setStatus(m.status_initial());

		if (rawUrlRef.current) {
			URL.revokeObjectURL(rawUrlRef.current);
			rawUrlRef.current = null;
		}

		if (processedUrlRef.current) {
			URL.revokeObjectURL(processedUrlRef.current);
			processedUrlRef.current = null;
		}

		sourceFileRef.current = null;

		if (fileInputRef.current) {
			fileInputRef.current.value = '';
		}

		await tearDownWorker();
	};

	const handlePresetChange = async (presetCode: OcrPresetCode) => {
		if (presetCode === ocrPreset || isRunning) {
			return;
		}

		setOcrPreset(presetCode);
		setError(null);

		const presetLabel = getPresetLabel(presetCode);

		if (sourceFileRef.current && asset) {
			setStatus(m.status_language_switching({ language: presetLabel }));
			await runOcr(sourceFileRef.current, asset.source, presetCode);
			return;
		}

		setStatus(m.status_language_selected({ language: presetLabel }));
	};

	const handleProcessingChange = <K extends keyof ProcessingSettings>(
		key: K,
		value: ProcessingSettings[K],
	) => {
		setProcessing((current) => ({
			...current,
			[key]: value,
		}));
	};

	const handleApplyProcessing = async () => {
		if (!sourceFileRef.current || !asset || isBusy) {
			return;
		}

		await runOcr(sourceFileRef.current, asset.source, ocrPreset);
	};

	const handleResetProcessing = () => {
		setProcessing(DEFAULT_PROCESSING);
	};

	const handlePreviewWheel = (
		surface: PreviewSurfaceKey,
		event: React.WheelEvent<HTMLDivElement>,
	) => {
		event.preventDefault();

		const direction =
			event.deltaY < 0 ? PREVIEW_SCALE_STEP : -PREVIEW_SCALE_STEP;
		setPreviewTransformForSurface(surface, (current) => ({
			...current,
			scale: current.scale + direction,
		}));
	};

	const handlePreviewZoom = (surface: PreviewSurfaceKey, direction: 1 | -1) => {
		setPreviewTransformForSurface(surface, (current) => ({
			...current,
			scale: current.scale + PREVIEW_SCALE_STEP * direction,
		}));
	};

	const startPreviewPan = (
		surface: PreviewSurfaceKey,
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		const transform = getPreviewTransform(surface);

		if (transform.scale <= 1) {
			return;
		}

		event.preventDefault();
		previewPanRef.current = {
			pointerId: event.pointerId,
			surface,
			startX: event.clientX,
			startY: event.clientY,
			startTransform: transform,
		};
		setIsPreviewPanning(true);
		setSelectedWordIndex(null);
	};

	const getPointerPoint = (event: React.PointerEvent<HTMLDivElement>) =>
		getPointFromClient(event.clientX, event.clientY);

	const handleRawPreviewPointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		if (isPanMode) {
			startPreviewPan('raw', event);
			return;
		}

		handleCropPointerDown(event);
	};

	const handleProcessedPreviewPointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		startPreviewPan('processed', event);
	};

	const handleCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!cropEnabled || !asset || isBusy || isMovingCrop || isResizingCrop) {
			return;
		}

		const point = getPointerPoint(event);

		if (!point) {
			return;
		}

		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		cropDragRef.current = {
			pointerId: event.pointerId,
			startX: point.x,
			startY: point.y,
		};
		setIsCropping(true);
		setCropSelection({
			left: point.x,
			top: point.y,
			width: 0,
			height: 0,
		});
	};

	const handleCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const activeDrag = cropDragRef.current;

		if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
			return;
		}

		const point = getPointerPoint(event);

		if (!point) {
			return;
		}

		const nextCrop = normalizeCrop(
			activeDrag.startX,
			activeDrag.startY,
			point.x,
			point.y,
		);
		setCropSelection(nextCrop);
	};

	const finishCropDrag = (event: React.PointerEvent<HTMLDivElement>) => {
		const activeDrag = cropDragRef.current;

		if (!activeDrag || activeDrag.pointerId !== event.pointerId) {
			return;
		}

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}

		cropDragRef.current = null;
		setIsCropping(false);
		setCropSelection((current) => {
			if (!current) {
				return null;
			}

			return current;
		});
	};

	const handleCropMovePointerDown = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		if (!cropSelection || !cropEnabled || isBusy || isPanMode) {
			return;
		}

		const point = getPointerPoint(event);

		if (!point) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		cropMoveRef.current = {
			pointerId: event.pointerId,
			startX: point.x,
			startY: point.y,
			startCrop: cropSelection,
		};
		setIsMovingCrop(true);
	};

	const handleCropHandlePointerDown = (
		handle: CropHandle,
		event: React.PointerEvent<HTMLButtonElement>,
	) => {
		if (!cropSelection || !cropEnabled || isBusy || isPanMode) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		cropResizeRef.current = {
			pointerId: event.pointerId,
			handle,
			startCrop: cropSelection,
		};
		setIsResizingCrop(true);
	};

	const handleExportText = () => {
		if (!asset || !ocrText) {
			return;
		}

		downloadBlob(
			`${sanitizeBaseName(asset.name)}.txt`,
			new Blob([ocrText], { type: 'text/plain;charset=utf-8' }),
		);
	};

	const handleExportJson = () => {
		if (!asset || !lastRunSnapshot) {
			return;
		}

		downloadJson(`${sanitizeBaseName(asset.name)}.json`, {
			generatedAt: new Date().toISOString(),
			source: {
				name: asset.name,
				size: asset.size,
				type: asset.type,
				origin: asset.source,
				width: asset.width,
				height: asset.height,
			},
			ocr: {
				preset: lastRunSnapshot.preset,
				confidence,
				words: wordCount,
				lines: lineCount,
				text: ocrText,
			},
			processing: lastRunSnapshot.processing,
			crop: lastRunSnapshot.crop
				? {
						normalized: lastRunSnapshot.crop,
						pixels: getCropPixels(lastRunSnapshot.crop, asset),
					}
				: null,
			processedImage: {
				width: lastRunSnapshot.processedWidth,
				height: lastRunSnapshot.processedHeight,
			},
			words: detectedWords,
		});
	};

	const handleExportBoxes = () => {
		if (!asset || !lastRunSnapshot || !detectedWords.length) {
			return;
		}

		downloadJson(`${sanitizeBaseName(asset.name)}-word-boxes.json`, {
			generatedAt: new Date().toISOString(),
			coordinateSpace: {
				width: lastRunSnapshot.processedWidth,
				height: lastRunSnapshot.processedHeight,
				description: 'Coordinates are relative to the processed OCR image.',
			},
			crop: lastRunSnapshot.crop
				? {
						normalized: lastRunSnapshot.crop,
						pixels: getCropPixels(lastRunSnapshot.crop, asset),
					}
				: null,
			words: detectedWords.map((word) => ({
				text: word.text,
				confidence: word.confidence,
				...word.bbox,
			})),
		});
	};

	const handleExportBoxesCsv = () => {
		if (!asset || !lastRunSnapshot || !detectedWords.length) {
			return;
		}

		downloadBlob(
			`${sanitizeBaseName(asset.name)}-word-boxes.csv`,
			new Blob([getWordBoxesCsv(detectedWords)], {
				type: 'text/csv;charset=utf-8',
			}),
		);
	};

	const handleExportBatchZip = () => {
		if (!batchJobs.length) {
			return;
		}

		const generatedAt = new Date().toISOString();
		const archiveFiles: Record<string, Uint8Array> = {
			'manifest.json': strToU8(
				JSON.stringify(
					{
						generatedAt,
						jobs: batchJobs.map((job) => ({
							id: job.id,
							name: job.name,
							status: job.status,
							source: job.source,
							confidence: job.confidence,
							wordCount: job.wordCount,
							lineCount: job.lineCount,
							error: job.error,
						})),
					},
					null,
					2,
				),
			),
		};

		for (const [index, job] of batchJobs.entries()) {
			const folder = `${String(index + 1).padStart(2, '0')}-${sanitizeBaseName(job.name)}`;
			archiveFiles[`${folder}/summary.json`] = strToU8(
				JSON.stringify(
					{
						name: job.name,
						status: job.status,
						source: job.source,
						confidence: job.confidence,
						wordCount: job.wordCount,
						lineCount: job.lineCount,
						error: job.error,
						snapshot: job.snapshot,
					},
					null,
					2,
				),
			);

			if (job.text) {
				archiveFiles[`${folder}/ocr.txt`] = strToU8(job.text);
			}

			if (job.snapshot) {
				archiveFiles[`${folder}/ocr.json`] = strToU8(
					JSON.stringify(
						{
							generatedAt,
							source: {
								name: job.name,
								size: job.file.size,
								type: job.file.type,
								origin: job.source,
							},
							ocr: {
								preset: job.snapshot.preset,
								confidence: job.confidence,
								words: job.wordCount,
								lines: job.lineCount,
								text: job.text,
							},
							processing: job.snapshot.processing,
							crop: job.snapshot.crop,
							processedImage: {
								width: job.snapshot.processedWidth,
								height: job.snapshot.processedHeight,
							},
							words: job.words,
						},
						null,
						2,
					),
				);

				if (job.words.length) {
					archiveFiles[`${folder}/word-boxes.json`] = strToU8(
						JSON.stringify(
							job.words.map((word) => ({
								text: word.text,
								confidence: word.confidence,
								...word.bbox,
							})),
							null,
							2,
						),
					);
					archiveFiles[`${folder}/word-boxes.csv`] = strToU8(
						getWordBoxesCsv(job.words),
					);
				}
			}
		}

		const zipBytes = zipSync(archiveFiles);
		const zipFile = new Uint8Array(zipBytes.byteLength);
		zipFile.set(zipBytes);

		downloadBlob(
			`da-ocr-batch-${Date.now()}.zip`,
			new Blob([zipFile], { type: 'application/zip' }),
		);
	};

	const handleOpenBatchJob = async (jobId: string) => {
		if (isBusy) {
			return;
		}

		const job = batchJobs.find((entry) => entry.id === jobId);

		if (!job) {
			return;
		}

		setActiveBatchJobId(job.id);

		if (job.status === 'done' && job.snapshot) {
			setOcrPreset(job.snapshot.preset);
			setProcessing(job.snapshot.processing);
			setCropEnabled(Boolean(job.snapshot.crop));
			setCropSelection(job.snapshot.crop);
			setOcrText(job.text);
			setDetectedWords(job.words);
			setSelectedWordIndex(null);
			setConfidence(job.confidence);
			setError(null);
			setCopied(false);
			setProgress(1);
			setLastRunSnapshot(job.snapshot);
			setStatus(m.status_batch_opened({ name: job.name }));
			await replaceSourceAsset(job.file, job.source);
			return;
		}

		await replaceSourceAsset(job.file, job.source);
		await runOcr(job.file, job.source, ocrPreset);
	};

	const wordCount = ocrText.trim() ? ocrText.trim().split(/\s+/).length : 0;
	const lineCount = ocrText ? ocrText.split(/\n+/).filter(Boolean).length : 0;
	const rawLayout = asset ? getContainLayout(rawStageSize, asset) : null;
	const processedLayout = processedPreview
		? getContainLayout(processedStageSize, processedPreview)
		: null;
	const visibleWords = detectedWords.slice(0, 24);
	const activePreset =
		OCR_PRESETS.find((entry) => entry.code === ocrPreset) ?? OCR_PRESETS[0];
	const selectedWord =
		selectedWordIndex === null
			? null
			: (detectedWords[selectedWordIndex] ?? null);
	const contrastLabel =
		processing.contrast > 0
			? `+${processing.contrast}`
			: `${processing.contrast}`;
	const overlayActionLabel = showBoxes ? m.overlay_hide() : m.overlay_show();
	const rawZoom = Math.round(rawPreviewTransform.scale * 100);
	const processedZoom = Math.round(processedPreviewTransform.scale * 100);
	const meterProgress = Math.round(
		(isBatchRunning ? batchProgress : progress) * 100,
	);
	const previewStatus = isRunning
		? m.preview_status_running()
		: lastRunSnapshot && lastRunSnapshot.signature !== currentSignature
			? m.preview_status_stale()
			: m.preview_status_ready();
	const stats = [
		[m.confidence_label(), confidence === null ? '--' : `${confidence}%`],
		[m.words_label(), `${wordCount}`],
		[m.lines_label(), `${lineCount}`],
	] as const;
	const currentSourceLabel = asset ? getSourceLabel(asset.source) : null;
	const cropPixels = asset ? getCropPixels(activeCrop, asset) : null;
	const cropHandles = ['nw', 'ne', 'sw', 'se'] as const;
	const cropBoxStyle =
		cropSelection && rawLayout
			? {
					left: rawLayout.left + cropSelection.left * rawLayout.width,
					top: rawLayout.top + cropSelection.top * rawLayout.height,
					width: cropSelection.width * rawLayout.width,
					height: cropSelection.height * rawLayout.height,
				}
			: null;
	const shouldShowOverlay = Boolean(
		showBoxes &&
			processedPreview &&
			processedLayout &&
			detectedWords.length &&
			lastRunSnapshot?.signature === currentSignature,
	);
	const overlayPreview = shouldShowOverlay ? processedPreview : null;
	const rawPreviewTransformStyle = {
		transform: `translate(${rawPreviewTransform.x}px, ${rawPreviewTransform.y}px) scale(${rawPreviewTransform.scale})`,
	};
	const processedPreviewTransformStyle = {
		transform: `translate(${processedPreviewTransform.x}px, ${processedPreviewTransform.y}px) scale(${processedPreviewTransform.scale})`,
	};

	return (
		<main className="ocr-workspace">
			<div className="ocr-panel">
				<div className="panel-head">
					<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
						{m.ocr_input_title()}
					</h2>
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						className="action-pill compact-pill"
						disabled={isBusy}
					>
						<ImagePlus size={16} />
						{m.select_image()}
					</button>
				</div>

				<div ref={ocrLangRef} className="ocr-lang-select">
					<button
						type="button"
						className={`toolbar-btn locale-btn ocr-lang-btn${ocrLangOpen ? ' is-active' : ''}`}
						aria-haspopup="listbox"
						aria-expanded={ocrLangOpen}
						disabled={isBusy}
						onClick={() => setOcrLangOpen((v) => !v)}
					>
						<span className="ocr-lang-short">
							{OCR_PRESETS.find((p) => p.code === ocrPreset)?.shortLabel}
						</span>
						<span className="ocr-lang-label">{getPresetLabel(ocrPreset)}</span>
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="3"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
							className={`locale-arrow${ocrLangOpen ? ' open' : ''}`}
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
					{ocrLangOpen && (
						<ul
							className="locale-menu ocr-lang-menu"
							aria-label={m.ocr_language_legend()}
						>
							{OCR_PRESETS.map((preset) => (
								<li key={preset.code}>
									<button
										type="button"
										className={`locale-option ocr-lang-option${ocrPreset === preset.code ? ' is-active' : ''}`}
										aria-current={
											ocrPreset === preset.code ? 'true' : undefined
										}
										onClick={() => {
											void handlePresetChange(preset.code);
											setOcrLangOpen(false);
										}}
									>
										<span className="ocr-lang-short">{preset.shortLabel}</span>
										{getPresetLabel(preset.code)}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="control-grid">
					<section className="control-card">
						<div className="control-head">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.preprocess_title()}
							</h3>
							<SlidersHorizontal size={16} />
						</div>

						<label className="switch-row">
							<input
								type="checkbox"
								checked={processing.grayscale}
								onChange={(event) => {
									handleProcessingChange('grayscale', event.target.checked);
								}}
							/>
							<span>{m.preprocess_grayscale()}</span>
						</label>

						<label className="switch-row">
							<input
								type="checkbox"
								checked={processing.thresholdEnabled}
								onChange={(event) => {
									handleProcessingChange(
										'thresholdEnabled',
										event.target.checked,
									);
								}}
							/>
							<span>{m.preprocess_threshold()}</span>
						</label>

						<label className="control-field">
							<div className="control-label-row">
								<span>{m.preprocess_threshold()}</span>
								<strong>{processing.threshold}</strong>
							</div>
							<input
								className="range-input"
								type="range"
								min="0"
								max="255"
								value={processing.threshold}
								disabled={!processing.thresholdEnabled}
								onChange={(event) => {
									handleProcessingChange(
										'threshold',
										Number(event.target.value),
									);
								}}
							/>
						</label>

						<label className="control-field">
							<div className="control-label-row">
								<span>{m.preprocess_contrast()}</span>
								<strong>{contrastLabel}</strong>
							</div>
							<input
								className="range-input"
								type="range"
								min="-100"
								max="100"
								value={processing.contrast}
								onChange={(event) => {
									handleProcessingChange(
										'contrast',
										Number(event.target.value),
									);
								}}
							/>
						</label>

						<p className="control-copy muted-copy">
							{m.preprocess_threshold_hint()}
						</p>

						<div className="control-actions">
							<button
								type="button"
								onClick={() => {
									void handleApplyProcessing();
								}}
								className="action-pill compact-pill"
								disabled={!sourceFileRef.current || isBusy}
							>
								{m.preprocess_apply()}
							</button>
							<button
								type="button"
								onClick={handleResetProcessing}
								className="action-pill ghost-pill compact-pill"
								disabled={isBusy}
							>
								{m.preprocess_reset()}
							</button>
						</div>
					</section>

					<section className="control-card">
						<div className="control-head">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.crop_title()}
							</h3>
							<Crop size={16} />
						</div>

						<label className="switch-row">
							<input
								type="checkbox"
								checked={cropEnabled}
								onChange={(event) => {
									setCropEnabled(event.target.checked);
									if (!event.target.checked) {
										setCropSelection(null);
									}
								}}
								disabled={isBusy}
							/>
							<span>{m.crop_enable()}</span>
						</label>

						<p className="control-copy muted-copy">{m.crop_hint()}</p>

						{cropPixels ? (
							<div className="selection-card is-stacked">
								<strong>{m.crop_selection_active()}</strong>
								<span>
									{m.crop_selection_size({
										width: cropPixels.width,
										height: cropPixels.height,
									})}
								</span>
								<span>
									{m.crop_selection_origin({
										x: cropPixels.x,
										y: cropPixels.y,
									})}
								</span>
							</div>
						) : (
							<p className="control-copy muted-copy">{m.crop_empty()}</p>
						)}

						<div className="control-actions">
							<button
								type="button"
								onClick={() => {
									void handleApplyProcessing();
								}}
								className="action-pill compact-pill"
								disabled={!sourceFileRef.current || !cropPixels || isBusy}
							>
								{m.crop_apply()}
							</button>
							<button
								type="button"
								onClick={() => {
									setCropSelection(null);
									setCropEnabled(false);
								}}
								className="action-pill ghost-pill compact-pill"
								disabled={!cropSelection || isBusy}
							>
								{m.crop_clear()}
							</button>
						</div>
					</section>

					<section className="control-card">
						<div className="control-head">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.overlay_title()}
							</h3>
							<button
								type="button"
								onClick={() => {
									setShowBoxes((current) => !current);
								}}
								className="action-pill ghost-pill compact-pill"
								disabled={!detectedWords.length}
							>
								{showBoxes ? <EyeOff size={16} /> : <Eye size={16} />}
								{overlayActionLabel}
							</button>
						</div>

						{selectedWord ? (
							<div className="selection-card">
								<strong>{selectedWord.text}</strong>
								<span>{Math.round(selectedWord.confidence)}%</span>
							</div>
						) : (
							<p className="control-copy muted-copy">{m.overlay_empty()}</p>
						)}
					</section>
				</div>

				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept="image/*"
					className="hidden"
					onChange={(event) => {
						void handleImageFiles(event.target.files, 'picker');
					}}
				/>

				<section
					className={`ocr-dropzone ${isDragging ? 'is-dragging' : ''} ${asset ? 'has-image' : ''}`}
					aria-label={m.dropzone_aria()}
					onDragEnter={(event) => {
						event.preventDefault();
						setIsDragging(true);
					}}
					onDragOver={(event) => {
						event.preventDefault();
						setIsDragging(true);
					}}
					onDragLeave={(event) => {
						event.preventDefault();
						setIsDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setIsDragging(false);
						void handleImageFiles(event.dataTransfer.files, 'drop');
					}}
				>
					{asset ? (
						<>
							<div className="preview-meta">
								<span>{activePreset.shortLabel}</span>
								<span>{currentSourceLabel}</span>
								<span>{formatBytes(asset.size)}</span>
								<span>{asset.type.replace('image/', '')}</span>
							</div>
							<div className="preview-grid">
								<section className="preview-card">
									<div className="preview-card-head">
										<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
											{m.raw_preview_title()}
										</h3>
										<button
											type="button"
											onClick={() => fileInputRef.current?.click()}
											className="action-pill ghost-pill compact-pill"
											disabled={isBusy}
										>
											{m.replace_image()}
										</button>
									</div>
									<div className="preview-toolbar">
										<button
											type="button"
											onClick={() => handlePreviewZoom('raw', -1)}
											className="action-pill ghost-pill compact-pill"
											disabled={rawPreviewTransform.scale <= MIN_PREVIEW_SCALE}
										>
											<SearchX size={16} />
											{m.preview_zoom_out()}
										</button>
										<button
											type="button"
											onClick={() => resetPreviewTransform('raw')}
											className="action-pill ghost-pill compact-pill"
											disabled={rawPreviewTransform.scale === 1}
										>
											{m.preview_zoom_reset()}
										</button>
										<button
											type="button"
											onClick={() => handlePreviewZoom('raw', 1)}
											className="action-pill ghost-pill compact-pill"
											disabled={rawPreviewTransform.scale >= MAX_PREVIEW_SCALE}
										>
											<Search size={16} />
											{m.preview_zoom_in()}
										</button>
										<button
											type="button"
											onClick={() => {
												setIsPanMode((current) => !current);
											}}
											className={`action-pill ghost-pill compact-pill ${isPanMode ? 'is-active' : ''}`}
										>
											<Move size={16} />
											{isPanMode ? m.preview_pan_off() : m.preview_pan_on()}
										</button>
										<span className="preview-zoom-level">
											{m.preview_zoom_level({ scale: rawZoom })}
										</span>
									</div>
									<p className="preview-pan-hint">{m.preview_pan_hint()}</p>
									<div className="preview-stage is-split">
										<div
											ref={rawPreviewSurfaceRef}
											className={`preview-surface ${cropEnabled ? 'is-crop-enabled' : ''} ${rawPreviewTransform.scale > 1 ? 'is-pannable' : ''} ${isPanMode ? 'is-pan-mode' : ''}`}
											onPointerDown={handleRawPreviewPointerDown}
											onPointerMove={handleCropPointerMove}
											onPointerUp={finishCropDrag}
											onPointerCancel={finishCropDrag}
											onWheel={(event) => {
												handlePreviewWheel('raw', event);
											}}
										>
											<div
												className="preview-canvas"
												style={rawPreviewTransformStyle}
											>
												<img
													src={asset.url}
													alt={asset.name}
													className="ocr-preview"
												/>
												{cropEnabled && cropBoxStyle ? (
													<div
														className={`crop-layer ${isPanMode ? 'is-pan-mode' : ''}`}
														aria-hidden="true"
													>
														<div
															className={`crop-box ${isCropping ? 'is-drawing' : ''} ${isMovingCrop ? 'is-moving' : ''}`}
															style={cropBoxStyle}
															onPointerDown={handleCropMovePointerDown}
														>
															<span className="crop-box-label">
																{m.crop_label()}
															</span>
															{cropHandles.map((handle) => (
																<button
																	key={handle}
																	type="button"
																	onPointerDown={(event) => {
																		handleCropHandlePointerDown(handle, event);
																	}}
																	className={`crop-handle is-${handle}`}
																	aria-label={m.crop_resize_handle({
																		handle,
																	})}
																	disabled={isBusy}
																/>
															))}
														</div>
													</div>
												) : null}
											</div>
										</div>
									</div>
								</section>

								<section className="preview-card">
									<div className="preview-card-head">
										<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
											{m.processed_preview_title()}
										</h3>
										<span className="preview-status-pill">{previewStatus}</span>
									</div>
									<div className="preview-toolbar">
										<button
											type="button"
											onClick={() => handlePreviewZoom('processed', -1)}
											className="action-pill ghost-pill compact-pill"
											disabled={
												processedPreviewTransform.scale <= MIN_PREVIEW_SCALE
											}
										>
											<SearchX size={16} />
											{m.preview_zoom_out()}
										</button>
										<button
											type="button"
											onClick={() => resetPreviewTransform('processed')}
											className="action-pill ghost-pill compact-pill"
											disabled={processedPreviewTransform.scale === 1}
										>
											{m.preview_zoom_reset()}
										</button>
										<button
											type="button"
											onClick={() => handlePreviewZoom('processed', 1)}
											className="action-pill ghost-pill compact-pill"
											disabled={
												processedPreviewTransform.scale >= MAX_PREVIEW_SCALE
											}
										>
											<Search size={16} />
											{m.preview_zoom_in()}
										</button>
										<span className="preview-zoom-level">
											{m.preview_zoom_level({ scale: processedZoom })}
										</span>
									</div>
									<p className="preview-pan-hint">{m.preview_pan_hint()}</p>
									<div className="preview-stage is-split">
										<div
											ref={processedPreviewSurfaceRef}
											className={`preview-surface ${processedPreviewTransform.scale > 1 ? 'is-pannable' : ''}`}
											onPointerDown={handleProcessedPreviewPointerDown}
											onWheel={(event) => {
												handlePreviewWheel('processed', event);
											}}
										>
											{processedPreview ? (
												<div
													className="preview-canvas"
													style={processedPreviewTransformStyle}
												>
													<img
														src={processedPreview.url}
														alt={m.processed_preview_alt()}
														className="ocr-preview"
													/>
													{overlayPreview && processedLayout ? (
														<div className="overlay-layer" aria-hidden="true">
															{detectedWords.map((word, index) => {
																const left =
																	processedLayout.left +
																	(word.bbox.x0 / overlayPreview.width) *
																		processedLayout.width;
																const top =
																	processedLayout.top +
																	(word.bbox.y0 / overlayPreview.height) *
																		processedLayout.height;
																const width =
																	((word.bbox.x1 - word.bbox.x0) /
																		overlayPreview.width) *
																	processedLayout.width;
																const height =
																	((word.bbox.y1 - word.bbox.y0) /
																		overlayPreview.height) *
																	processedLayout.height;

																return (
																	<div
																		key={getWordKey(word)}
																		className={`word-box ${selectedWordIndex === index ? 'is-selected' : ''}`}
																		style={{ left, top, width, height }}
																	/>
																);
															})}
														</div>
													) : null}
												</div>
											) : (
												<div className="preview-loading">
													{m.processed_preview_loading()}
												</div>
											)}
										</div>
									</div>
								</section>
							</div>
							<div className="preview-footer">
								<strong>{asset.name}</strong>
								<span>{previewStatus}</span>
							</div>
						</>
					) : (
						<div className="dropzone-empty">
							<div className="dropzone-icon">
								<ClipboardPaste size={24} />
							</div>
							<p className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.dropzone_title()}
							</p>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								className="action-pill"
								disabled={isBusy}
							>
								<ImagePlus size={16} />
								{m.select_image()}
							</button>
						</div>
					)}
				</section>

				<div className="meter-wrap">
					<div className="meter-copy">
						<span>{status}</span>
						<span>{meterProgress}%</span>
					</div>
					<div className="meter-track" aria-hidden="true">
						<div
							className="meter-fill"
							style={{ width: `${meterProgress}%` }}
						/>
					</div>
				</div>

				{error ? <p className="status-error">{error}</p> : null}

				<div className="mt-5 grid gap-3 sm:grid-cols-3">
					{stats.map(([label, value]) => (
						<div key={label} className="stat-card">
							<span className="stat-label">{label}</span>
							<strong>{value}</strong>
						</div>
					))}
				</div>

				{detectedWords.length ? (
					<section className="mt-5">
						<div className="panel-head gap-y-3">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.detected_words_title({ count: detectedWords.length })}
							</h3>
							<button
								type="button"
								onClick={() => {
									setSelectedWordIndex(null);
								}}
								className="action-pill ghost-pill compact-pill"
								disabled={selectedWordIndex === null}
							>
								{m.detected_words_clear()}
							</button>
						</div>
						<div className="word-list">
							{visibleWords.map((word, index) => {
								const isActive = selectedWordIndex === index;

								return (
									<button
										key={getWordKey(word)}
										type="button"
										onClick={() => {
											setSelectedWordIndex(isActive ? null : index);
										}}
										className={`word-chip ${isActive ? 'is-active' : ''}`}
									>
										<span>{word.text}</span>
										<small>{Math.round(word.confidence)}%</small>
									</button>
								);
							})}
						</div>
					</section>
				) : null}
			</div>

			<div className="ocr-panel">
				<div className="panel-head">
					<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
						{m.output_title()}
					</h2>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={handleCopy}
							disabled={!ocrText}
							className="action-pill"
						>
							{copied ? <Check size={18} /> : <Copy size={18} />}
							{copied ? m.copied_text() : m.copy_text()}
						</button>
						<button
							type="button"
							onClick={() => void handleReset()}
							className="action-pill ghost-pill"
							disabled={isBusy}
						>
							<RotateCcw size={18} />
							{m.reset()}
						</button>
					</div>
				</div>

				<div className={`ocr-output ${!ocrText ? 'is-empty' : ''}`}>
					{isRunning ? (
						<div className="output-state">
							<LoaderCircle className="animate-spin" size={24} />
							<p>{m.output_running()}</p>
						</div>
					) : null}

					{!isRunning && !ocrText ? (
						<div className="output-state">
							<ScanText size={24} />
							<p>{m.output_empty()}</p>
						</div>
					) : null}

					{ocrText ? <pre>{ocrText}</pre> : null}
				</div>

				<section className="mt-5">
					<div className="panel-head gap-y-3">
						<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
							{m.export_title()}
						</h3>
					</div>
					<div className="export-card-grid">
						<button
							type="button"
							onClick={handleExportText}
							disabled={!ocrText}
							className="export-card"
						>
							<Download size={18} />
							<div className="export-card-body">
								<span className="export-card-label">{m.export_txt()}</span>
								<span className="export-card-hint">.txt</span>
							</div>
						</button>
						<button
							type="button"
							onClick={handleExportJson}
							disabled={!lastRunSnapshot}
							className="export-card"
						>
							<Download size={18} />
							<div className="export-card-body">
								<span className="export-card-label">{m.export_json()}</span>
								<span className="export-card-hint">.json</span>
							</div>
						</button>
						<button
							type="button"
							onClick={handleExportBoxes}
							disabled={!detectedWords.length || !lastRunSnapshot}
							className="export-card"
						>
							<Download size={18} />
							<div className="export-card-body">
								<span className="export-card-label">{m.export_boxes()}</span>
								<span className="export-card-hint">.json</span>
							</div>
						</button>
						<button
							type="button"
							onClick={handleExportBoxesCsv}
							disabled={!detectedWords.length || !lastRunSnapshot}
							className="export-card"
						>
							<Download size={18} />
							<div className="export-card-body">
								<span className="export-card-label">{m.export_csv()}</span>
								<span className="export-card-hint">.csv</span>
							</div>
						</button>
					</div>
				</section>

				{batchJobs.length ? (
					<section className="mt-5">
						<div className="panel-head gap-y-3">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.batch_title({ count: batchJobs.length })}
							</h3>
							<div className="batch-toolbar">
								<button
									type="button"
									onClick={handleExportBatchZip}
									className="action-pill ghost-pill compact-pill"
									disabled={!batchJobs.length}
								>
									<Download size={16} />
									{m.batch_export_zip()}
								</button>
								<button
									type="button"
									onClick={() => {
										void cancelBatchRun();
									}}
									className="action-pill ghost-pill compact-pill"
									disabled={!isBatchRunning}
								>
									<X size={16} />
									{m.batch_cancel()}
								</button>
								<button
									type="button"
									onClick={() => {
										setBatchJobs([]);
										setActiveBatchJobId(null);
									}}
									className="action-pill ghost-pill compact-pill"
									disabled={isBatchRunning}
								>
									{m.batch_clear()}
								</button>
							</div>
						</div>
						<div className="batch-list">
							{batchJobs.map((job) => {
								const isActive = activeBatchJobId === job.id;
								const summary =
									job.status === 'done'
										? m.batch_stats({
												words: job.wordCount,
												lines: job.lineCount,
												confidence: job.confidence ?? 0,
											})
										: job.error || m.batch_pending();

								return (
									<article
										key={job.id}
										className={`batch-card ${isActive ? 'is-active' : ''}`}
									>
										<div className="batch-card-strip">
											<div className="batch-thumb-strip" aria-hidden="true">
												{job.thumbnailDataUrl ? (
													<img
														src={job.thumbnailDataUrl}
														alt={job.name}
														className="batch-thumb-image"
													/>
												) : (
													<div className="batch-thumb-fallback">
														<ImagePlus size={18} />
													</div>
												)}
											</div>
											<div className="batch-card-body">
												<div className="batch-head">
													<strong>{job.name}</strong>
													<span className={`batch-status is-${job.status}`}>
														{getBatchStatusLabel(job.status)}
													</span>
												</div>
												<div className="batch-meta">
													<span>{getSourceLabel(job.source)}</span>
													{job.snapshot ? (
														<span>{getPresetLabel(job.snapshot.preset)}</span>
													) : null}
												</div>
												<p className="batch-copy">{summary}</p>
												<div className="batch-actions">
													<button
														type="button"
														onClick={() => {
															void handleOpenBatchJob(job.id);
														}}
														className="action-pill ghost-pill compact-pill"
														disabled={isBusy || job.status === 'running'}
													>
														{m.batch_open()}
													</button>
												</div>
											</div>
										</div>
									</article>
								);
							})}
						</div>
					</section>
				) : null}
			</div>
		</main>
	);
}
