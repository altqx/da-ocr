import {
	Captions,
	FileText,
	HardDrive,
	LoaderCircle,
	Mic,
	RotateCcw,
	Trash2,
	Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { m } from '../../i18n';
import {
	getAudioTimelineCues,
	getAudioWordCount,
	isAudioSourceFile,
	readAudioSourceAsset,
} from './audio-utils';
import { QWEN_ASR_MODEL_LABEL } from './constants';
import {
	clearQwenAsrCache,
	getQwenAsrCacheSummary,
	loadQwenAsrPipeline,
	type QwenAsrProgressInfo,
	transcribeWithQwenAsr,
} from './qwen-asr';
import type { AudioAsset, AudioTimelineCue } from './types';
import {
	downloadBlob,
	downloadJson,
	formatBytes,
	sanitizeBaseName,
} from './utils';
import {
	formatTimelineTime,
	getSubtitleFile,
	getWebVttFile,
	isVideoFile,
} from './video-utils';

type WebGpuStatus = 'checking' | 'available' | 'unavailable';
type ModelStatus = 'idle' | 'checking-cache' | 'loading' | 'ready' | 'error';

type AudioTranscriptionStudioProps = {
	hidden: boolean;
	isImageBusy: boolean;
	isVideoRunning: boolean;
	isAudioRunning: boolean;
	setIsAudioRunning: (isRunning: boolean) => void;
};

type NavigatorWithGpu = Navigator & {
	gpu?: {
		requestAdapter: () => Promise<unknown>;
	};
};

function getAsrErrorMessage(cause: unknown) {
	const message = cause instanceof Error ? cause.message : String(cause);

	if (
		/qwen3_asr|Qwen3ASR|model_fp16\.onnx|model type/i.test(message) ||
		/Could not locate file|not found/i.test(message)
	) {
		return m.audio_runtime_unsupported();
	}

	return message || m.audio_status_failed();
}

function getProgressLabel(info: QwenAsrProgressInfo) {
	switch (info.status) {
		case 'initiate':
			return m.audio_model_status_file_start({ file: info.file });
		case 'download':
			return m.audio_model_status_file_download({ file: info.file });
		case 'progress':
			return m.audio_model_status_file_progress({
				file: info.file,
				progress: Math.round(info.progress),
			});
		case 'progress_total':
			return m.audio_model_status_total_progress({
				progress: Math.round(info.progress),
			});
		case 'transcribe_progress':
			return m.audio_status_transcribing_progress({
				progress: Math.round(info.progress),
			});
		case 'chunk':
			return m.audio_status_transcribing_chunk({
				chunk: info.chunk,
				total: info.total,
			});
		case 'done':
			return m.audio_model_status_file_done({ file: info.file });
		case 'ready':
			return m.audio_model_status_ready();
		default:
			return m.audio_status_initializing();
	}
}

export default function AudioTranscriptionStudio({
	hidden,
	isImageBusy,
	isVideoRunning,
	isAudioRunning,
	setIsAudioRunning,
}: AudioTranscriptionStudioProps) {
	const audioInputRef = useRef<HTMLInputElement>(null);
	const audioUrlRef = useRef<string | null>(null);
	const audioRunIdRef = useRef(0);
	const [webGpuStatus, setWebGpuStatus] = useState<WebGpuStatus>('checking');
	const [audioAsset, setAudioAsset] = useState<AudioAsset | null>(null);
	const [audioCues, setAudioCues] = useState<AudioTimelineCue[]>([]);
	const [audioSubtitleUrl, setAudioSubtitleUrl] = useState<string | null>(null);
	const [transcript, setTranscript] = useState('');
	const [modelStatus, setModelStatus] = useState<ModelStatus>('idle');
	const [cacheLabel, setCacheLabel] = useState<string>(() =>
		m.audio_cache_checking(),
	);
	const [audioProgress, setAudioProgress] = useState(0);
	const [audioStatus, setAudioStatus] = useState<string>(() =>
		m.audio_status_initial(),
	);
	const [audioError, setAudioError] = useState<string | null>(null);
	const [isAudioDragging, setIsAudioDragging] = useState(false);

	const isModelBusy =
		modelStatus === 'loading' || modelStatus === 'checking-cache';
	const isBlockedByOtherMode = isImageBusy || isVideoRunning;
	const webGpuUnavailable = webGpuStatus === 'unavailable';
	const audioImportDisabled =
		isAudioRunning ||
		isModelBusy ||
		isBlockedByOtherMode ||
		webGpuStatus !== 'available';
	const audioActionDisabled =
		!audioAsset ||
		isAudioRunning ||
		isModelBusy ||
		isBlockedByOtherMode ||
		webGpuStatus !== 'available';
	const meterProgress = Math.round(audioProgress * 100);
	const wordCount = getAudioWordCount(audioCues);
	const durationLabel = audioAsset
		? formatTimelineTime(audioAsset.duration)
		: '--';
	const audioTrackUrl =
		audioSubtitleUrl ?? 'data:text/vtt;charset=utf-8,WEBVTT%0A';
	const audioStats = [
		[m.audio_stat_cues(), `${audioCues.length}`],
		[m.audio_stat_words(), `${wordCount}`],
		[m.audio_stat_duration(), durationLabel],
	] as const;

	const refreshCacheStatus = useCallback(async (markBusy = true) => {
		if (markBusy) {
			setModelStatus((current) =>
				current === 'loading' ? current : 'checking-cache',
			);
		}

		try {
			const cacheSummary = await getQwenAsrCacheSummary();

			if (cacheSummary.allCached) {
				setCacheLabel(m.audio_cache_cached());
				return;
			}

			if (cacheSummary.filesTotal > 0) {
				setCacheLabel(
					m.audio_cache_partial({
						cached: cacheSummary.filesCached,
						total: cacheSummary.filesTotal,
					}),
				);
				return;
			}

			setCacheLabel(m.audio_cache_not_cached());
		} finally {
			if (markBusy) {
				setModelStatus((current) =>
					current === 'checking-cache' ? 'idle' : current,
				);
			}
		}
	}, []);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			const gpu = (navigator as NavigatorWithGpu).gpu;

			if (!gpu) {
				if (!cancelled) {
					setWebGpuStatus('unavailable');
					setAudioStatus(m.audio_status_no_webgpu());
				}
				return;
			}

			try {
				const adapter = await gpu.requestAdapter();

				if (!cancelled) {
					setWebGpuStatus(adapter ? 'available' : 'unavailable');
					setAudioStatus(
						adapter ? m.audio_status_initial() : m.audio_status_no_webgpu(),
					);
				}
			} catch {
				if (!cancelled) {
					setWebGpuStatus('unavailable');
					setAudioStatus(m.audio_status_no_webgpu());
				}
			}
		})();

		void refreshCacheStatus();

		return () => {
			cancelled = true;
		};
	}, [refreshCacheStatus]);

	useEffect(() => {
		return () => {
			audioRunIdRef.current += 1;

			if (audioUrlRef.current) {
				URL.revokeObjectURL(audioUrlRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (!audioCues.length) {
			setAudioSubtitleUrl(null);
			return;
		}

		const subtitleUrl = URL.createObjectURL(
			new Blob([`${getWebVttFile(audioCues)}\n`], {
				type: 'text/vtt;charset=utf-8',
			}),
		);
		setAudioSubtitleUrl(subtitleUrl);

		return () => {
			URL.revokeObjectURL(subtitleUrl);
		};
	}, [audioCues]);

	const handleModelProgress = (info: QwenAsrProgressInfo) => {
		setAudioStatus(getProgressLabel(info));

		if (info.status === 'progress_total') {
			setAudioProgress(Math.max(0.02, Math.min(0.85, info.progress / 100)));
			return;
		}

		if (info.status === 'progress') {
			setAudioProgress(Math.max(0.02, Math.min(0.75, info.progress / 100)));
		}
	};

	const handleAudioFiles = async (
		files: File[] | FileList | null | undefined,
	) => {
		const nextFiles = Array.from(files ?? []).filter(Boolean);

		if (!nextFiles.length) {
			return;
		}

		const audioFile = nextFiles.find((file) => isAudioSourceFile(file));

		if (!audioFile) {
			setAudioError(m.only_audio_source_error());
			return;
		}

		if (
			nextFiles.length > 1 ||
			nextFiles.some((file) => !isAudioSourceFile(file))
		) {
			setAudioError(m.audio_source_single_file_hint());
		} else {
			setAudioError(null);
		}

		const loadId = ++audioRunIdRef.current;
		setAudioProgress(0);
		setAudioStatus(
			isVideoFile(audioFile)
				? m.audio_status_extracting_video_audio()
				: m.audio_status_loading(),
		);
		setAudioCues([]);
		setTranscript('');
		setAudioAsset(null);

		if (audioUrlRef.current) {
			URL.revokeObjectURL(audioUrlRef.current);
			audioUrlRef.current = null;
		}

		try {
			const nextAsset = await readAudioSourceAsset(audioFile);

			if (loadId !== audioRunIdRef.current) {
				URL.revokeObjectURL(nextAsset.url);
				return;
			}

			audioUrlRef.current = nextAsset.url;
			setAudioAsset(nextAsset);
			setAudioStatus(
				webGpuUnavailable ? m.audio_status_no_webgpu() : m.audio_status_ready(),
			);
		} catch (cause) {
			if (loadId !== audioRunIdRef.current) {
				return;
			}

			const message =
				cause instanceof Error ? cause.message : m.audio_status_failed();
			setAudioError(message);
			setAudioStatus(m.audio_status_failed());
		}
	};

	const handleLoadModel = async () => {
		if (webGpuStatus !== 'available' || isModelBusy || isAudioRunning) {
			return;
		}

		setModelStatus('loading');
		setAudioError(null);
		setAudioProgress(0.02);
		setAudioStatus(m.audio_status_initializing());

		try {
			await loadQwenAsrPipeline(handleModelProgress);
			setModelStatus('ready');
			setAudioProgress(1);
			setAudioStatus(m.audio_model_status_ready());
			await refreshCacheStatus(false);
		} catch (cause) {
			const message = getAsrErrorMessage(cause);
			setModelStatus('error');
			setAudioError(message);
			setAudioStatus(m.audio_status_failed());
		}
	};

	const handleTranscribe = async () => {
		if (!audioAsset || audioActionDisabled) {
			return;
		}

		const runId = ++audioRunIdRef.current;
		setIsAudioRunning(true);
		setModelStatus((current) => (current === 'ready' ? current : 'loading'));
		setAudioError(null);
		setAudioProgress(0.02);
		setAudioStatus(m.audio_status_initializing());
		setAudioCues([]);
		setTranscript('');

		try {
			await loadQwenAsrPipeline(handleModelProgress);

			if (runId !== audioRunIdRef.current) {
				return;
			}

			setModelStatus('ready');
			setAudioProgress(0.88);
			setAudioStatus(m.audio_status_transcribing());

			const result = await transcribeWithQwenAsr(
				audioAsset.samples,
				handleModelProgress,
			);

			if (runId !== audioRunIdRef.current) {
				return;
			}

			const cues = getAudioTimelineCues(result, audioAsset.duration);
			setAudioCues(cues);
			setTranscript(result.text);
			setAudioProgress(1);
			setAudioStatus(m.audio_status_done({ cues: cues.length }));
			await refreshCacheStatus(false);
		} catch (cause) {
			if (runId !== audioRunIdRef.current) {
				return;
			}

			const message = getAsrErrorMessage(cause);
			setModelStatus('error');
			setAudioError(message);
			setAudioStatus(m.audio_status_failed());
		} finally {
			if (runId === audioRunIdRef.current) {
				setIsAudioRunning(false);
				setAudioProgress((current) => Math.max(current, 1));
			}
		}
	};

	const handleClearModelCache = async () => {
		if (isAudioRunning || modelStatus === 'loading') {
			return;
		}

		setModelStatus('checking-cache');
		setAudioError(null);
		setAudioStatus(m.audio_cache_clearing());

		try {
			const result = await clearQwenAsrCache();
			setCacheLabel(m.audio_cache_not_cached());
			setModelStatus('idle');
			setAudioStatus(m.audio_cache_cleared({ count: result.filesDeleted }));
		} catch (cause) {
			const message =
				cause instanceof Error ? cause.message : m.audio_cache_clear_failed();
			setModelStatus('error');
			setAudioError(message);
			setAudioStatus(m.audio_cache_clear_failed());
		}
	};

	const handleAudioReset = () => {
		audioRunIdRef.current += 1;
		setAudioAsset(null);
		setAudioCues([]);
		setTranscript('');
		setAudioProgress(0);
		setAudioStatus(
			webGpuUnavailable ? m.audio_status_no_webgpu() : m.audio_status_initial(),
		);
		setAudioError(null);
		setIsAudioDragging(false);
		setIsAudioRunning(false);

		if (audioUrlRef.current) {
			URL.revokeObjectURL(audioUrlRef.current);
			audioUrlRef.current = null;
		}

		if (audioInputRef.current) {
			audioInputRef.current.value = '';
		}
	};

	const handleExportAudioSrt = () => {
		if (!audioAsset || !audioCues.length) {
			return;
		}

		downloadBlob(
			`${sanitizeBaseName(audioAsset.name)}.srt`,
			new Blob([`${getSubtitleFile(audioCues)}\n`], {
				type: 'application/x-subrip;charset=utf-8',
			}),
		);
	};

	const handleExportAudioVtt = () => {
		if (!audioAsset || !audioCues.length) {
			return;
		}

		downloadBlob(
			`${sanitizeBaseName(audioAsset.name)}.vtt`,
			new Blob([`${getWebVttFile(audioCues)}\n`], {
				type: 'text/vtt;charset=utf-8',
			}),
		);
	};

	const handleExportAudioJson = () => {
		if (!audioAsset) {
			return;
		}

		downloadJson(`${sanitizeBaseName(audioAsset.name)}-transcript.json`, {
			generatedAt: new Date().toISOString(),
			model: QWEN_ASR_MODEL_LABEL,
			source: {
				name: audioAsset.name,
				size: audioAsset.size,
				type: audioAsset.type,
				duration: audioAsset.duration,
				sourceKind: audioAsset.sourceKind,
				originalName: audioAsset.originalName,
				originalSize: audioAsset.originalSize,
				originalType: audioAsset.originalType,
			},
			text: transcript,
			cues: audioCues,
		});
	};

	return (
		<div className="audio-workspace" hidden={hidden}>
			<div className="ocr-panel">
				<div className="panel-head">
					<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
						{m.audio_input_title()}
					</h2>
					<button
						type="button"
						onClick={() => audioInputRef.current?.click()}
						className="action-pill compact-pill"
						disabled={audioImportDisabled}
					>
						<Upload size={16} />
						{m.select_audio()}
					</button>
				</div>

				{webGpuUnavailable ? (
					<p className="status-error">{m.audio_status_no_webgpu()}</p>
				) : null}

				<input
					ref={audioInputRef}
					type="file"
					accept="audio/*,video/*"
					className="hidden"
					disabled={audioImportDisabled}
					onChange={(event) => {
						void handleAudioFiles(event.target.files);
					}}
				/>

				<section
					className={`ocr-dropzone audio-dropzone ${isAudioDragging ? 'is-dragging' : ''} ${audioAsset ? 'has-image' : ''}`}
					aria-label={m.audio_dropzone_aria()}
					onDragEnter={(event) => {
						event.preventDefault();
						setIsAudioDragging(true);
					}}
					onDragOver={(event) => {
						event.preventDefault();
						setIsAudioDragging(true);
					}}
					onDragLeave={(event) => {
						event.preventDefault();
						setIsAudioDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setIsAudioDragging(false);
						void handleAudioFiles(event.dataTransfer.files);
					}}
				>
					{audioAsset ? (
						<div className="audio-preview">
							<div className="preview-meta">
								<span>ASR</span>
								<span>
									{audioAsset.sourceKind === 'video'
										? m.audio_extracted_from_video()
										: QWEN_ASR_MODEL_LABEL}
								</span>
								<span>{formatBytes(audioAsset.size)}</span>
								<span>{durationLabel}</span>
							</div>
							<div className="audio-preview-body">
								<div className="dropzone-icon">
									<Mic size={24} />
								</div>
								<strong>{audioAsset.name}</strong>
								<audio controls src={audioAsset.url}>
									<track
										default
										kind="captions"
										src={audioTrackUrl}
										srcLang="en"
										label={m.video_player_captions()}
									/>
								</audio>
							</div>
						</div>
					) : (
						<div className="dropzone-empty">
							<div className="dropzone-icon">
								<Mic size={24} />
							</div>
							<p className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.audio_dropzone_title()}
							</p>
							<button
								type="button"
								onClick={() => audioInputRef.current?.click()}
								className="action-pill"
								disabled={audioImportDisabled}
							>
								<Upload size={16} />
								{m.select_audio()}
							</button>
						</div>
					)}
				</section>

				<div className="control-grid">
					<section className="control-card">
						<div className="control-head">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.audio_model_title()}
							</h3>
							<HardDrive size={16} />
						</div>

						<div className="audio-model-readout">
							<span>{QWEN_ASR_MODEL_LABEL}</span>
							<strong>
								{webGpuStatus === 'checking'
									? m.audio_model_status_checking_webgpu()
									: cacheLabel}
							</strong>
						</div>

						<div className="control-actions">
							<button
								type="button"
								onClick={() => {
									void handleLoadModel();
								}}
								className="action-pill compact-pill"
								disabled={
									webGpuStatus !== 'available' ||
									isAudioRunning ||
									isModelBusy ||
									isBlockedByOtherMode
								}
							>
								<HardDrive size={16} />
								{m.audio_load_model()}
							</button>
							<button
								type="button"
								onClick={() => {
									void handleClearModelCache();
								}}
								className="action-pill ghost-pill compact-pill"
								disabled={isAudioRunning || modelStatus === 'loading'}
							>
								<Trash2 size={16} />
								{m.audio_delete_model_cache()}
							</button>
						</div>
					</section>

					<section className="control-card">
						<div className="control-head">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.audio_transcription_title()}
							</h3>
							<Captions size={16} />
						</div>

						<div className="control-actions">
							<button
								type="button"
								onClick={() => {
									void handleTranscribe();
								}}
								className="action-pill compact-pill"
								disabled={audioActionDisabled}
							>
								<Captions size={16} />
								{m.audio_transcribe()}
							</button>
							<button
								type="button"
								onClick={handleAudioReset}
								className="action-pill ghost-pill compact-pill"
								disabled={isAudioRunning}
							>
								<RotateCcw size={16} />
								{m.reset()}
							</button>
						</div>
					</section>
				</div>

				<div className="meter-wrap">
					<div className="meter-copy">
						<span>{audioStatus}</span>
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
						{m.audio_timeline_title()}
					</h2>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={handleExportAudioSrt}
							disabled={!audioCues.length}
							className="action-pill"
						>
							<Captions size={18} />
							{m.video_export_srt()}
						</button>
						<button
							type="button"
							onClick={handleExportAudioVtt}
							disabled={!audioCues.length}
							className="action-pill ghost-pill"
						>
							<Captions size={18} />
							{m.audio_export_vtt()}
						</button>
						<button
							type="button"
							onClick={handleExportAudioJson}
							disabled={!audioAsset}
							className="action-pill ghost-pill"
						>
							<FileText size={18} />
							{m.export_json()}
						</button>
					</div>
				</div>

				{audioError ? <p className="status-error">{audioError}</p> : null}

				<div className="mt-5 grid gap-3 sm:grid-cols-3">
					{audioStats.map(([label, value]) => (
						<div key={label} className="stat-card">
							<span className="stat-label">{label}</span>
							<strong>{value}</strong>
						</div>
					))}
				</div>

				<div className={`video-output ${!audioCues.length ? 'is-empty' : ''}`}>
					{isAudioRunning && !audioCues.length ? (
						<div className="output-state">
							<LoaderCircle className="animate-spin" size={24} />
							<p>{m.audio_output_running()}</p>
						</div>
					) : null}

					{!isAudioRunning && !audioCues.length ? (
						<div className="output-state">
							<Captions size={24} />
							<p>{m.audio_output_empty()}</p>
						</div>
					) : null}

					{audioCues.length ? (
						<ol className="video-timeline-list">
							{audioCues.map((cue, index) => (
								<li key={cue.id} className="video-cue">
									<div className="video-cue-marker">
										<span>{String(index + 1).padStart(2, '0')}</span>
									</div>
									<div className="video-cue-body">
										<div className="video-cue-time">
											<span>{formatTimelineTime(cue.start)}</span>
											<small>{m.video_time_to()}</small>
											<span>{formatTimelineTime(cue.end)}</span>
										</div>
										<pre>{cue.text}</pre>
									</div>
								</li>
							))}
						</ol>
					) : null}
				</div>
			</div>
		</div>
	);
}
