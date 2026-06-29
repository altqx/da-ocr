import { useServerFn } from '@tanstack/react-start';
import {
	Captions,
	Clock,
	FileText,
	FileVideoCamera,
	Film,
	LoaderCircle,
	RotateCcw,
	X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { m } from '../../i18n';
import { runLensOcr } from '../../lib/lens-ocr';
import {
	DEFAULT_VIDEO_FRAME_INTERVAL,
	MAX_VIDEO_FRAME_INTERVAL,
	MIN_VIDEO_FRAME_INTERVAL,
} from './constants';
import type {
	PreparedImage,
	ProcessingSettings,
	VideoAsset,
	VideoFrameResult,
	VideoTimelineCue,
} from './types';
import {
	createProcessedImage,
	downloadBlob,
	downloadJson,
	formatBytes,
	sanitizeBaseName,
} from './utils';
import {
	createLoadedVideoElement,
	extractVideoFrame,
	formatTimelineTime,
	getSubtitleFile,
	getVideoFrameStatusLabel,
	getVideoSampleTimes,
	getVideoTimelineCues,
	getWebVttFile,
	isVideoFile,
	normalizeOcrTextForDedupe,
	readVideoAsset,
	sanitizeSubtitleText,
} from './video-utils';

type VideoStudioProps = {
	hidden: boolean;
	processing: ProcessingSettings;
	compatibilityMessage: string | null;
	hasCompatibilityIssue: boolean;
	isImageBusy: boolean;
	isVideoRunning: boolean;
	setIsVideoRunning: (isRunning: boolean) => void;
};

export default function VideoStudio({
	hidden,
	processing,
	compatibilityMessage,
	hasCompatibilityIssue,
	isImageBusy,
	isVideoRunning,
	setIsVideoRunning,
}: VideoStudioProps) {
	const runLensOcrFn = useServerFn(runLensOcr);
	const videoInputRef = useRef<HTMLInputElement>(null);
	const videoSourceFileRef = useRef<File | null>(null);
	const videoUrlRef = useRef<string | null>(null);
	const videoRunRef = useRef<{ id: number; cancelled: boolean } | null>(null);
	const videoRunIdRef = useRef(0);

	const [videoAsset, setVideoAsset] = useState<VideoAsset | null>(null);
	const [videoFrameInterval, setVideoFrameInterval] = useState(
		DEFAULT_VIDEO_FRAME_INTERVAL,
	);
	const [videoFrames, setVideoFrames] = useState<VideoFrameResult[]>([]);
	const [videoCues, setVideoCues] = useState<VideoTimelineCue[]>([]);
	const [isVideoDragging, setIsVideoDragging] = useState(false);
	const [videoProgress, setVideoProgress] = useState(0);
	const [videoStatus, setVideoStatus] = useState<string>(() =>
		m.video_status_initial(),
	);
	const [videoError, setVideoError] = useState<string | null>(null);
	const [videoSubtitleUrl, setVideoSubtitleUrl] = useState<string | null>(null);

	const videoImportDisabled =
		isImageBusy || isVideoRunning || hasCompatibilityIssue;
	const videoMeterProgress = Math.round(videoProgress * 100);
	const completedVideoFrameCount = videoFrames.filter(
		(frame) => frame.status === 'done',
	).length;
	const erroredVideoFrameCount = videoFrames.filter(
		(frame) => frame.status === 'error',
	).length;
	const videoDurationLabel = videoAsset
		? formatTimelineTime(videoAsset.duration)
		: '--';
	const videoStats = [
		[
			m.video_stat_frames(),
			`${completedVideoFrameCount}/${videoFrames.length}`,
		],
		[m.video_stat_cues(), `${videoCues.length}`],
		[m.video_stat_duration(), videoDurationLabel],
	] as const;

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

	const cancelVideoRun = useCallback(() => {
		const activeRun = videoRunRef.current;

		if (!activeRun || activeRun.cancelled) {
			return;
		}

		activeRun.cancelled = true;
		videoRunRef.current = null;
		setIsVideoRunning(false);
		setVideoProgress(1);
		setVideoStatus(m.video_status_cancelled());
		setVideoFrames((current) =>
			current.map((frame) =>
				frame.status === 'done' || frame.status === 'error'
					? frame
					: {
							...frame,
							status: 'error',
							error: m.video_status_cancelled(),
						},
			),
		);
	}, [setIsVideoRunning]);

	const handleVideoFiles = async (
		files: File[] | FileList | null | undefined,
	) => {
		if (compatibilityMessage) {
			setVideoStatus(m.compatibility_status());
			setVideoError(compatibilityMessage);
			return;
		}

		const nextFiles = Array.from(files ?? []).filter(Boolean);

		if (!nextFiles.length) {
			return;
		}

		const videoFile = nextFiles.find((file) => isVideoFile(file));

		if (!videoFile) {
			setVideoError(m.only_video_error());
			return;
		}

		if (nextFiles.length > 1 || nextFiles.some((file) => !isVideoFile(file))) {
			setVideoError(m.video_single_file_hint());
		} else {
			setVideoError(null);
		}

		videoSourceFileRef.current = videoFile;
		cancelVideoRun();
		const videoRun = {
			id: ++videoRunIdRef.current,
			cancelled: false,
		};
		videoRunRef.current = videoRun;
		const runProcessing = { ...processing };
		const runInterval = videoFrameInterval;

		setIsVideoRunning(true);
		setVideoProgress(0);
		setVideoStatus(m.video_status_loading());
		setVideoFrames([]);
		setVideoCues([]);

		try {
			const nextAsset = await readVideoAsset(videoFile);

			if (videoRunRef.current !== videoRun || videoRun.cancelled) {
				URL.revokeObjectURL(nextAsset.url);
				return;
			}

			if (videoUrlRef.current) {
				URL.revokeObjectURL(videoUrlRef.current);
			}

			videoUrlRef.current = nextAsset.url;
			setVideoAsset(nextAsset);

			const sampleTimes = getVideoSampleTimes(nextAsset.duration, runInterval);
			let workingFrames: VideoFrameResult[] = sampleTimes.map(
				(time, index) => ({
					id: `${sanitizeBaseName(videoFile.name)}-${index}-${time.toFixed(2)}`,
					index,
					time,
					status: 'queued',
					thumbnailDataUrl: null,
					text: '',
					normalizedText: '',
					words: [],
					error: null,
				}),
			);

			setVideoFrames(workingFrames);
			setVideoStatus(
				m.video_status_extracting({
					current: 0,
					total: sampleTimes.length,
				}),
			);

			const updateVideoFrame = (
				frameIndex: number,
				updater: (frame: VideoFrameResult) => VideoFrameResult,
			) => {
				workingFrames = workingFrames.map((frame) =>
					frame.index === frameIndex ? updater(frame) : frame,
				);
				setVideoFrames(workingFrames);
				setVideoCues(getVideoTimelineCues(workingFrames, nextAsset.duration));
			};

			const video = await createLoadedVideoElement(nextAsset.url);

			try {
				for (const [index, time] of sampleTimes.entries()) {
					if (videoRunRef.current !== videoRun || videoRun.cancelled) {
						return;
					}

					updateVideoFrame(index, (frame) => ({
						...frame,
						status: 'running',
						error: null,
					}));
					setVideoStatus(
						m.video_status_extracting({
							current: index + 1,
							total: sampleTimes.length,
						}),
					);

					try {
						const extractedFrame = await extractVideoFrame(video, time);
						const frameFile = new File(
							[extractedFrame.blob],
							`${sanitizeBaseName(videoFile.name)}-frame-${String(
								index + 1,
							).padStart(4, '0')}.png`,
							{ type: 'image/png' },
						);
						const preparedImage = await createProcessedImage(
							frameFile,
							runProcessing,
							null,
						);

						try {
							if (videoRunRef.current !== videoRun || videoRun.cancelled) {
								URL.revokeObjectURL(preparedImage.url);
								return;
							}

							setVideoStatus(
								m.video_status_ocr_frame({
									current: index + 1,
									total: sampleTimes.length,
								}),
							);

							const result = await scanPreparedImage(
								preparedImage,
								frameFile.name,
							);
							const text = sanitizeSubtitleText(result.text);
							const words = result.boxes.map((box) => ({
								text: box.text,
								confidence: null,
								bbox: box.bbox,
							}));

							updateVideoFrame(index, (frame) => ({
								...frame,
								status: 'done',
								thumbnailDataUrl: extractedFrame.thumbnailDataUrl,
								text,
								normalizedText: normalizeOcrTextForDedupe(text),
								words,
								error: null,
							}));
						} finally {
							URL.revokeObjectURL(preparedImage.url);
						}
					} catch (cause) {
						const message =
							cause instanceof Error
								? cause.message
								: m.video_frame_status_error();
						updateVideoFrame(index, (frame) => ({
							...frame,
							status: 'error',
							error: message,
						}));
					} finally {
						setVideoProgress((index + 1) / sampleTimes.length);
					}
				}
			} finally {
				video.removeAttribute('src');
				video.load();
			}

			if (videoRunRef.current !== videoRun || videoRun.cancelled) {
				return;
			}

			const finalCues = getVideoTimelineCues(workingFrames, nextAsset.duration);
			setVideoCues(finalCues);
			setVideoStatus(
				m.video_status_done({
					frames: workingFrames.length,
					cues: finalCues.length,
				}),
			);
		} catch (cause) {
			if (videoRunRef.current !== videoRun || videoRun.cancelled) {
				return;
			}

			const message =
				cause instanceof Error ? cause.message : m.video_status_failed();
			setVideoError(message);
			setVideoStatus(m.video_status_failed());
		} finally {
			if (videoRunRef.current === videoRun) {
				videoRunRef.current = null;
				setIsVideoRunning(false);
				setVideoProgress(1);
			}
		}
	};

	const handleVideoReset = () => {
		cancelVideoRun();
		videoRunIdRef.current += 1;
		videoSourceFileRef.current = null;
		setVideoAsset(null);
		setVideoFrames([]);
		setVideoCues([]);
		setVideoProgress(0);
		setVideoStatus(m.video_status_initial());
		setVideoError(null);
		setIsVideoDragging(false);
		setIsVideoRunning(false);

		if (videoUrlRef.current) {
			URL.revokeObjectURL(videoUrlRef.current);
			videoUrlRef.current = null;
		}

		if (videoInputRef.current) {
			videoInputRef.current.value = '';
		}
	};

	const handleRerunVideo = async () => {
		if (
			!videoAsset ||
			!videoSourceFileRef.current ||
			isImageBusy ||
			isVideoRunning
		) {
			return;
		}

		await handleVideoFiles([videoSourceFileRef.current]);
	};

	const handleExportVideoSrt = () => {
		if (!videoAsset || !videoCues.length) {
			return;
		}

		downloadBlob(
			`${sanitizeBaseName(videoAsset.name)}.srt`,
			new Blob([`${getSubtitleFile(videoCues)}\n`], {
				type: 'application/x-subrip;charset=utf-8',
			}),
		);
	};

	const handleExportVideoJson = () => {
		if (!videoAsset) {
			return;
		}

		downloadJson(`${sanitizeBaseName(videoAsset.name)}-timeline.json`, {
			generatedAt: new Date().toISOString(),
			source: {
				name: videoAsset.name,
				size: videoAsset.size,
				type: videoAsset.type,
				width: videoAsset.width,
				height: videoAsset.height,
				duration: videoAsset.duration,
			},
			frameInterval: videoFrameInterval,
			frames: videoFrames.map((frame) => ({
				index: frame.index,
				time: frame.time,
				status: frame.status,
				text: frame.text,
				wordCount: frame.text.trim()
					? frame.text.trim().split(/\s+/).length
					: 0,
				words: frame.words,
				error: frame.error,
			})),
			cues: videoCues,
		});
	};

	useEffect(() => {
		if (!videoCues.length) {
			setVideoSubtitleUrl(null);
			return;
		}

		const subtitleUrl = URL.createObjectURL(
			new Blob([`${getWebVttFile(videoCues)}\n`], {
				type: 'text/vtt;charset=utf-8',
			}),
		);
		setVideoSubtitleUrl(subtitleUrl);

		return () => {
			URL.revokeObjectURL(subtitleUrl);
		};
	}, [videoCues]);

	useEffect(() => {
		return () => {
			const activeRun = videoRunRef.current;

			if (activeRun) {
				activeRun.cancelled = true;
				videoRunRef.current = null;
			}

			if (videoUrlRef.current) {
				URL.revokeObjectURL(videoUrlRef.current);
			}
		};
	}, []);

	return (
		<div className="video-workspace" hidden={hidden}>
			<div className="ocr-panel">
				<div className="panel-head">
					<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
						{m.video_input_title()}
					</h2>
					<button
						type="button"
						onClick={() => videoInputRef.current?.click()}
						className="action-pill compact-pill"
						disabled={videoImportDisabled}
					>
						<FileVideoCamera size={16} />
						{m.select_video()}
					</button>
				</div>

				{compatibilityMessage ? (
					<p className="status-error">{compatibilityMessage}</p>
				) : null}

				<input
					ref={videoInputRef}
					type="file"
					accept="video/*"
					className="hidden"
					disabled={videoImportDisabled}
					onChange={(event) => {
						void handleVideoFiles(event.target.files);
					}}
				/>

				<section
					className={`ocr-dropzone video-dropzone ${isVideoDragging ? 'is-dragging' : ''} ${videoAsset ? 'has-image' : ''}`}
					aria-label={m.video_dropzone_aria()}
					onDragEnter={(event) => {
						event.preventDefault();
						setIsVideoDragging(true);
					}}
					onDragOver={(event) => {
						event.preventDefault();
						setIsVideoDragging(true);
					}}
					onDragLeave={(event) => {
						event.preventDefault();
						setIsVideoDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setIsVideoDragging(false);
						void handleVideoFiles(event.dataTransfer.files);
					}}
				>
					{videoAsset ? (
						<>
							<div className="preview-meta">
								<span>LENS</span>
								<span>{m.mode_video()}</span>
								<span>{formatBytes(videoAsset.size)}</span>
								<span>{videoDurationLabel}</span>
							</div>
							<div className="video-preview-wrap">
								<video
									src={videoAsset.url}
									className="video-preview"
									controls
									preload="metadata"
									playsInline
								>
									<track
										kind="captions"
										label={m.video_generated_captions_label()}
										src={videoSubtitleUrl ?? 'data:text/vtt,WEBVTT%0A%0A'}
										default={Boolean(videoSubtitleUrl)}
									/>
								</video>
							</div>
							<div className="preview-footer">
								<strong>{videoAsset.name}</strong>
								<span>
									{videoAsset.width}x{videoAsset.height}
								</span>
							</div>

							<div className="control-grid">
								<section className="control-card">
									<div className="control-head">
										<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
											{m.video_sampling_title()}
										</h3>
										<Clock size={16} />
									</div>

									<label className="control-field">
										<div className="control-label-row">
											<span>{m.video_frame_interval()}</span>
											<strong>{videoFrameInterval.toFixed(1)}s</strong>
										</div>
										<input
											className="range-input"
											type="range"
											min={MIN_VIDEO_FRAME_INTERVAL}
											max={MAX_VIDEO_FRAME_INTERVAL}
											step="0.5"
											value={videoFrameInterval}
											disabled={isVideoRunning}
											onChange={(event) => {
												setVideoFrameInterval(Number(event.target.value));
											}}
										/>
									</label>

									<div className="control-actions">
										<button
											type="button"
											onClick={() => {
												void handleRerunVideo();
											}}
											className="action-pill compact-pill"
											disabled={!videoAsset || isImageBusy || isVideoRunning}
										>
											{m.video_extract()}
										</button>
										<button
											type="button"
											onClick={cancelVideoRun}
											className="action-pill ghost-pill compact-pill"
											disabled={!isVideoRunning}
										>
											<X size={16} />
											{m.batch_cancel()}
										</button>
										<button
											type="button"
											onClick={handleVideoReset}
											className="action-pill ghost-pill compact-pill"
											disabled={isVideoRunning}
										>
											<RotateCcw size={16} />
											{m.reset()}
										</button>
									</div>
								</section>
							</div>
						</>
					) : (
						<div className="dropzone-empty">
							<div className="dropzone-icon">
								<Film size={24} />
							</div>
							<p className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.video_dropzone_title()}
							</p>
							<button
								type="button"
								onClick={() => videoInputRef.current?.click()}
								className="action-pill"
								disabled={videoImportDisabled}
							>
								<FileVideoCamera size={16} />
								{m.select_video()}
							</button>
						</div>
					)}
				</section>

				<div className="meter-wrap">
					<div className="meter-copy">
						<span>{videoStatus}</span>
						<span>{videoMeterProgress}%</span>
					</div>
					<div className="meter-track" aria-hidden="true">
						<div
							className="meter-fill"
							style={{ width: `${videoMeterProgress}%` }}
						/>
					</div>
				</div>
			</div>

			<div className="ocr-panel">
				<div className="panel-head">
					<h2 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
						{m.video_timeline_title()}
					</h2>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={handleExportVideoSrt}
							disabled={!videoCues.length}
							className="action-pill"
						>
							<Captions size={18} />
							{m.video_export_srt()}
						</button>
						<button
							type="button"
							onClick={handleExportVideoJson}
							disabled={!videoAsset || !videoFrames.length}
							className="action-pill ghost-pill"
						>
							<FileText size={18} />
							{m.export_json()}
						</button>
					</div>
				</div>

				{videoError ? <p className="status-error">{videoError}</p> : null}

				<div className="mt-5 grid gap-3 sm:grid-cols-3">
					{videoStats.map(([label, value]) => (
						<div key={label} className="stat-card">
							<span className="stat-label">{label}</span>
							<strong>{value}</strong>
						</div>
					))}
				</div>

				<div className={`video-output ${!videoCues.length ? 'is-empty' : ''}`}>
					{isVideoRunning && !videoCues.length ? (
						<div className="output-state">
							<LoaderCircle className="animate-spin" size={24} />
							<p>{m.video_output_running()}</p>
						</div>
					) : null}

					{!isVideoRunning && !videoCues.length ? (
						<div className="output-state">
							<Captions size={24} />
							<p>{m.video_output_empty()}</p>
						</div>
					) : null}

					{videoCues.length ? (
						<ol className="video-timeline-list">
							{videoCues.map((cue, index) => (
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
										<div className="batch-meta">
											<span>
												{m.video_frames_merged({
													count: cue.frameIndexes.length,
												})}
											</span>
										</div>
									</div>
								</li>
							))}
						</ol>
					) : null}
				</div>

				{videoFrames.length ? (
					<section className="mt-5">
						<div className="panel-head gap-y-3">
							<h3 className="text-xs font-bold uppercase tracking-widest text-[var(--ink)]">
								{m.video_frames_title({ count: videoFrames.length })}
							</h3>
							<div className="batch-meta">
								<span>
									{m.video_frames_done({
										count: completedVideoFrameCount,
									})}
								</span>
								{erroredVideoFrameCount ? (
									<span>
										{m.video_frame_errors({
											count: erroredVideoFrameCount,
										})}
									</span>
								) : null}
							</div>
						</div>
						<div className="video-frame-list">
							{videoFrames.map((frame) => (
								<article key={frame.id} className="video-frame-card">
									<div className="batch-thumb-strip" aria-hidden="true">
										{frame.thumbnailDataUrl ? (
											<img
												src={frame.thumbnailDataUrl}
												alt=""
												className="batch-thumb-image"
											/>
										) : (
											<div className="batch-thumb-fallback">
												<Film size={18} />
											</div>
										)}
									</div>
									<div className="video-frame-body">
										<div className="batch-head">
											<strong>{formatTimelineTime(frame.time)}</strong>
											<span className={`batch-status is-${frame.status}`}>
												{getVideoFrameStatusLabel(frame.status)}
											</span>
										</div>
										<p className="batch-copy">
											{frame.text || frame.error || m.video_frame_no_text()}
										</p>
									</div>
								</article>
							))}
						</div>
					</section>
				) : null}
			</div>
		</div>
	);
}
