import { useServerFn } from '@tanstack/react-start';
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
import { m } from '../i18n';
import { runLensOcr } from '../lib/lens-ocr';
import AudioTranscriptionStudio from './ocr-studio/AudioTranscriptionStudio';
import {
	DEFAULT_PREVIEW_TRANSFORM,
	DEFAULT_PROCESSING,
	MAX_PREVIEW_SCALE,
	MIN_PREVIEW_SCALE,
	PREVIEW_SCALE_STEP,
} from './ocr-studio/constants';
import ModeTabs from './ocr-studio/ModeTabs';
import type {
	BatchJob,
	CompatibilityFeature,
	CropHandle,
	CropSelection,
	DetectedWord,
	ImageAsset,
	OcrExecutionResult,
	OcrRunSnapshot,
	PreparedImage,
	PreviewStageSize,
	PreviewSurfaceKey,
	PreviewTransform,
	ProcessingSettings,
	StudioMode,
} from './ocr-studio/types';
import {
	clamp,
	clampPreviewTransform,
	clearPersistedBatchQueue,
	createProcessedImage,
	createThumbnailDataUrl,
	downloadBlob,
	downloadJson,
	formatBytes,
	getBatchQueuePayload,
	getBatchStatusLabel,
	getBatchWorkerCount,
	getCompatibilityFeatureLabel,
	getCompatibilityIssues,
	getContainLayout,
	getCropPixels,
	getDetectedLanguageLabel,
	getRunSignature,
	getSourceLabel,
	getWordBoxesCsv,
	getWordKey,
	normalizeCrop,
	readImageAsset,
	readPersistedBatchQueue,
	resizeCropSelection,
	sanitizeBaseName,
	translateCropSelection,
	writePersistedBatchQueue,
} from './ocr-studio/utils';
import VideoStudio from './ocr-studio/VideoStudio';

export default function OcrStudio() {
	const runLensOcrFn = useServerFn(runLensOcr);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const rawPreviewSurfaceRef = useRef<HTMLDivElement>(null);
	const processedPreviewSurfaceRef = useRef<HTMLDivElement>(null);
	const sourceFileRef = useRef<File | null>(null);
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
	const batchRunRef = useRef<{ id: number; cancelled: boolean } | null>(null);
	const batchRunIdRef = useRef(0);
	const previewPanRef = useRef<{
		pointerId: number;
		surface: PreviewSurfaceKey;
		startX: number;
		startY: number;
		startTransform: PreviewTransform;
	} | null>(null);

	const [activeMode, setActiveMode] = useState<StudioMode>('image');
	const [asset, setAsset] = useState<ImageAsset | null>(null);
	const [processedPreview, setProcessedPreview] =
		useState<PreparedImage | null>(null);
	const [ocrText, setOcrText] = useState('');
	const [detectedWords, setDetectedWords] = useState<DetectedWord[]>([]);
	const [progress, setProgress] = useState(0);
	const [status, setStatus] = useState<string>(() => m.status_initial());
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
	const [isVideoRunning, setIsVideoRunning] = useState(false);
	const [isAudioRunning, setIsAudioRunning] = useState(false);
	const [compatibilityIssues, setCompatibilityIssues] = useState<
		CompatibilityFeature[]
	>([]);

	const activeCrop = cropEnabled ? cropSelection : null;
	const deferredProcessing = useDeferredValue(processing);
	const deferredCrop = useDeferredValue(activeCrop);
	const initialStatus = m.status_initial();
	const currentSignature = getRunSignature(processing, activeCrop);
	const isBusy =
		isRunning || isBatchRunning || isVideoRunning || isAudioRunning;
	const compatibilityMessage = compatibilityIssues.length
		? m.compatibility_error({
				features: compatibilityIssues
					.map((feature) => getCompatibilityFeatureLabel(feature))
					.join(', '),
			})
		: null;
	const hasCompatibilityIssue = compatibilityIssues.length > 0;
	const interactionDisabled = isBusy || hasCompatibilityIssue;
	const batchProgress =
		batchJobs.length === 0
			? 0
			: batchJobs.filter(
					(job) =>
						job.status === 'done' ||
						job.status === 'error' ||
						job.status === 'cancelled',
				).length / batchJobs.length;

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
	}, []);

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

	const scanPreparedImage = async (
		preparedImage: PreparedImage,
		fileName: string,
	) => {
		const formData = new FormData();
		formData.set(
			'image',
			new File([preparedImage.blob], `${sanitizeBaseName(fileName)}.png`, {
				type: 'image/png',
			}),
		);
		formData.set('width', String(preparedImage.width));
		formData.set('height', String(preparedImage.height));

		return runLensOcrFn({ data: formData });
	};

	const runOcr = async (
		file: File,
		source: ImageAsset['source'],
		cropOverride?: CropSelection | null,
	): Promise<OcrExecutionResult> => {
		if (compatibilityMessage) {
			setStatus(m.compatibility_status());
			return {
				ok: false,
				error: compatibilityMessage,
			};
		}

		const runId = ++runIdRef.current;
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
			setProgress(0.2);
			setStatus(m.status_preparing_ocr({ language: 'Lens' }));

			const result = await scanPreparedImage(preparedImage, file.name);

			if (runId !== runIdRef.current) {
				return null;
			}

			const detectedLanguageLabel = getDetectedLanguageLabel(
				result.detectedLanguage,
			);
			const parsedOutput = {
				text: result.text,
				words: result.boxes.map((box) => ({
					text: box.text,
					confidence: null,
					bbox: box.bbox,
				})),
				confidence: null,
			};

			setOcrText(parsedOutput.text);
			setDetectedWords(parsedOutput.words);
			setConfidence(parsedOutput.confidence);
			setProgress(1);
			const snapshot = {
				detectedLanguage: result.detectedLanguage,
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
					? m.status_ocr_complete({ language: detectedLanguageLabel })
					: m.status_no_text({ language: detectedLanguageLabel.toLowerCase() }),
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

			const fallbackLabel = 'Lens';
			const message =
				cause instanceof Error
					? cause.message
					: m.status_ocr_failed({ language: fallbackLabel });

			setError(message);
			setStatus(m.status_ocr_failed({ language: fallbackLabel }));
			return {
				ok: false,
				error: message,
			};
		} finally {
			if (runId === runIdRef.current) {
				setIsRunning(false);
			}
		}
	};

	const handleImageFiles = async (
		files: File[] | FileList | null | undefined,
		source: ImageAsset['source'],
	) => {
		if (compatibilityMessage) {
			setStatus(m.compatibility_status());
			setError(compatibilityMessage);
			return;
		}

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
			await runOcr(jobs[0].file, source);
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
			const batchProcessing = { ...processing };
			const batchCrop = activeCrop;

			const batchWorkerCount = getBatchWorkerCount(jobs.length);

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
					const result = await scanPreparedImage(preparedImage, job.name);
					const parsedOutput = {
						text: result.text,
						words: result.boxes.map((box) => ({
							text: box.text,
							confidence: null,
							bbox: box.bbox,
						})),
						confidence: null,
					};
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
											detectedLanguage: result.detectedLanguage,
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
		} finally {
			batchRunRef.current = null;
			setIsBatchRunning(false);
			setProgress(1);
		}
	};

	const handlePaste = useEffectEvent(async (event: ClipboardEvent) => {
		if (activeMode !== 'image') {
			return;
		}

		if (compatibilityMessage) {
			setStatus(m.compatibility_status());
			setError(compatibilityMessage);
			return;
		}

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
		const issues = getCompatibilityIssues();
		setCompatibilityIssues(issues);

		if (issues.length) {
			setStatus(m.compatibility_status());
		}
	}, []);

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
		if (hasCompatibilityIssue) {
			return;
		}

		const onPaste = (event: ClipboardEvent) => {
			void handlePaste(event);
		};

		window.addEventListener('paste', onPaste);

		return () => {
			window.removeEventListener('paste', onPaste);
		};
	}, [hasCompatibilityIssue]);

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

	const rawWheelCleanupRef = useRef<(() => void) | null>(null);
	const rawPreviewWheelRef = useCallback((node: HTMLDivElement | null) => {
		rawWheelCleanupRef.current?.();
		rawWheelCleanupRef.current = null;
		rawPreviewSurfaceRef.current = node;
		if (node) {
			const handler = (e: WheelEvent) => handlePreviewWheel('raw', e);
			node.addEventListener('wheel', handler, { passive: false });
			rawWheelCleanupRef.current = () =>
				node.removeEventListener('wheel', handler);
		}
	}, []);

	const processedWheelCleanupRef = useRef<(() => void) | null>(null);
	const processedPreviewWheelRef = useCallback(
		(node: HTMLDivElement | null) => {
			processedWheelCleanupRef.current?.();
			processedWheelCleanupRef.current = null;
			processedPreviewSurfaceRef.current = node;
			if (node) {
				const handler = (e: WheelEvent) => handlePreviewWheel('processed', e);
				node.addEventListener('wheel', handler, { passive: false });
				processedWheelCleanupRef.current = () =>
					node.removeEventListener('wheel', handler);
			}
		},
		[],
	);

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
		};
	}, [cancelBatchRun]);

	useEffect(() => {
		if (hasCompatibilityIssue) {
			return;
		}

		if (!asset && !ocrText && !error && !isRunning) {
			setStatus(initialStatus);
		}
	}, [asset, error, hasCompatibilityIssue, initialStatus, isRunning, ocrText]);

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
		if (!sourceFileRef.current || !asset || interactionDisabled) {
			return;
		}

		await runOcr(sourceFileRef.current, asset.source);
	};

	const handleResetProcessing = () => {
		setProcessing(DEFAULT_PROCESSING);
	};

	const handlePreviewWheel = useEffectEvent(
		(surface: PreviewSurfaceKey, event: WheelEvent) => {
			event.preventDefault();

			const direction =
				event.deltaY < 0 ? PREVIEW_SCALE_STEP : -PREVIEW_SCALE_STEP;
			setPreviewTransformForSurface(surface, (current) => ({
				...current,
				scale: current.scale + direction,
			}));
		},
	);

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
				detectedLanguage: lastRunSnapshot.detectedLanguage,
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
								detectedLanguage: job.snapshot.detectedLanguage,
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
		await runOcr(job.file, job.source);
	};

	const wordCount = ocrText.trim() ? ocrText.trim().split(/\s+/).length : 0;
	const lineCount = ocrText ? ocrText.split(/\n+/).filter(Boolean).length : 0;
	const rawLayout = asset ? getContainLayout(rawStageSize, asset) : null;
	const processedLayout = processedPreview
		? getContainLayout(processedStageSize, processedPreview)
		: null;
	const visibleWords = detectedWords.slice(0, 24);
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
		<main className="ocr-shell">
			<ModeTabs
				activeMode={activeMode}
				isImageBusy={isRunning || isBatchRunning}
				isAudioRunning={isAudioRunning}
				isVideoRunning={isVideoRunning}
				onModeChange={setActiveMode}
			/>
			<div className="ocr-workspace" hidden={activeMode !== 'image'}>
				<div className="ocr-panel">
					<div className="panel-head">
						<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
							{m.ocr_input_title()}
						</h2>
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className="action-pill compact-pill"
							disabled={interactionDisabled}
						>
							<ImagePlus size={16} />
							{m.select_image()}
						</button>
					</div>

					{compatibilityMessage ? (
						<p className="status-error">{compatibilityMessage}</p>
					) : null}

					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept="image/*"
						className="hidden"
						disabled={interactionDisabled}
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
									<span>LENS</span>
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
												disabled={interactionDisabled}
											>
												{m.replace_image()}
											</button>
										</div>
										<div className="preview-toolbar">
											<button
												type="button"
												onClick={() => handlePreviewZoom('raw', -1)}
												className="action-pill ghost-pill compact-pill"
												disabled={
													rawPreviewTransform.scale <= MIN_PREVIEW_SCALE
												}
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
												disabled={
													rawPreviewTransform.scale >= MAX_PREVIEW_SCALE
												}
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
												ref={rawPreviewWheelRef}
												className={`preview-surface ${cropEnabled ? 'is-crop-enabled' : ''} ${rawPreviewTransform.scale > 1 ? 'is-pannable' : ''} ${isPanMode ? 'is-pan-mode' : ''}`}
												onPointerDown={handleRawPreviewPointerDown}
												onPointerMove={handleCropPointerMove}
												onPointerUp={finishCropDrag}
												onPointerCancel={finishCropDrag}
											>
												<div
													className="preview-canvas"
													style={rawPreviewTransformStyle}
												>
													<img
														src={asset.url}
														alt={asset.name}
														className="ocr-preview"
														draggable={false}
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
																			handleCropHandlePointerDown(
																				handle,
																				event,
																			);
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
											<span className="preview-status-pill">
												{previewStatus}
											</span>
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
												ref={processedPreviewWheelRef}
												className={`preview-surface ${processedPreviewTransform.scale > 1 ? 'is-pannable' : ''}`}
												onPointerDown={handleProcessedPreviewPointerDown}
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
															draggable={false}
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
									disabled={interactionDisabled}
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
									<span>
										{selectedWord.confidence === null
											? '--'
											: `${Math.round(selectedWord.confidence)}%`}
									</span>
								</div>
							) : (
								<p className="control-copy muted-copy">{m.overlay_empty()}</p>
							)}
						</section>
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
											<small>
												{word.confidence === null
													? '--'
													: `${Math.round(word.confidence)}%`}
											</small>
										</button>
									);
								})}
							</div>
						</section>
					) : null}

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
													confidence: job.confidence ?? '--',
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
															<span>
																{getDetectedLanguageLabel(
																	job.snapshot.detectedLanguage,
																)}
															</span>
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
			</div>
			<VideoStudio
				hidden={activeMode !== 'video'}
				processing={processing}
				compatibilityMessage={compatibilityMessage}
				hasCompatibilityIssue={hasCompatibilityIssue}
				isImageBusy={isRunning || isBatchRunning}
				isVideoRunning={isVideoRunning}
				setIsVideoRunning={setIsVideoRunning}
			/>
			<AudioTranscriptionStudio
				hidden={activeMode !== 'audio'}
				isImageBusy={isRunning || isBatchRunning}
				isVideoRunning={isVideoRunning}
				isAudioRunning={isAudioRunning}
				setIsAudioRunning={setIsAudioRunning}
			/>
		</main>
	);
}
