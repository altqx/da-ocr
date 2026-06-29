import {
	Captions,
	Maximize2,
	Pause,
	Play,
	Volume2,
	VolumeX,
} from 'lucide-react';
import type {
	CSSProperties,
	ForwardedRef,
	PointerEvent as ReactPointerEvent,
} from 'react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { m } from '../../i18n';
import type { CropHandle, CropSelection, VideoAsset } from './types';
import { formatTimelineTime } from './video-utils';

type VideoLayout = {
	width: number;
	height: number;
	left: number;
	top: number;
};

type VideoPlayerProps = {
	asset: VideoAsset;
	subtitleUrl: string | null;
	cropEnabled: boolean;
	videoLayout: VideoLayout | null;
	cropSelection: CropSelection | null;
	isVideoCropping: boolean;
	isMovingVideoCrop: boolean;
	onPreviewPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPreviewPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPreviewPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPreviewPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onCropMovePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onCropHandlePointerDown: (
		handle: CropHandle,
		event: ReactPointerEvent<HTMLButtonElement>,
	) => void;
};

function setForwardedRef(
	ref: ForwardedRef<HTMLDivElement>,
	node: HTMLDivElement | null,
) {
	if (typeof ref === 'function') {
		ref(node);
		return;
	}

	if (ref) {
		ref.current = node;
	}
}

export default forwardRef<HTMLDivElement, VideoPlayerProps>(
	function VideoPlayer(
		{
			asset,
			subtitleUrl,
			cropEnabled,
			videoLayout,
			cropSelection,
			isVideoCropping,
			isMovingVideoCrop,
			onPreviewPointerDown,
			onPreviewPointerMove,
			onPreviewPointerUp,
			onPreviewPointerCancel,
			onCropMovePointerDown,
			onCropHandlePointerDown,
		},
		forwardedRef,
	) {
		const playerRef = useRef<HTMLDivElement>(null);
		const videoRef = useRef<HTMLVideoElement>(null);
		const [currentTime, setCurrentTime] = useState(0);
		const [duration, setDuration] = useState(asset.duration);
		const [isPlaying, setIsPlaying] = useState(false);
		const [isMuted, setIsMuted] = useState(false);
		const [volume, setVolume] = useState(1);
		const [isFullscreen, setIsFullscreen] = useState(false);

		const seekProgress = duration > 0 ? (currentTime / duration) * 100 : 0;
		const volumeProgress = isMuted ? 0 : volume * 100;

		const setPreviewRef = useCallback(
			(node: HTMLDivElement | null) => {
				setForwardedRef(forwardedRef, node);
			},
			[forwardedRef],
		);

		const syncMediaState = useCallback(() => {
			const video = videoRef.current;

			if (!video) {
				return;
			}

			setCurrentTime(video.currentTime);
			setDuration(
				Number.isFinite(video.duration) ? video.duration : asset.duration,
			);
			setIsPlaying(!video.paused && !video.ended);
			setIsMuted(video.muted);
			setVolume(video.volume);
		}, [asset.duration]);

		useEffect(() => {
			const video = videoRef.current;

			if (video?.currentSrc && video.currentSrc !== asset.url) {
				video.pause();
			}

			setCurrentTime(0);
			setDuration(asset.duration);
			setIsPlaying(false);
		}, [asset.duration, asset.url]);

		useEffect(() => {
			if (cropEnabled) {
				videoRef.current?.pause();
			}
		}, [cropEnabled]);

		useEffect(() => {
			const handleFullscreenChange = () => {
				setIsFullscreen(document.fullscreenElement === playerRef.current);
			};

			document.addEventListener('fullscreenchange', handleFullscreenChange);

			return () => {
				document.removeEventListener(
					'fullscreenchange',
					handleFullscreenChange,
				);
			};
		}, []);

		const togglePlayback = async () => {
			const video = videoRef.current;

			if (!video) {
				return;
			}

			if (video.paused || video.ended) {
				await video.play().catch(() => undefined);
				syncMediaState();
				return;
			}

			video.pause();
			syncMediaState();
		};

		const handleSeek = (value: number) => {
			const video = videoRef.current;

			if (!video) {
				return;
			}

			video.currentTime = value;
			setCurrentTime(value);
		};

		const toggleMute = () => {
			const video = videoRef.current;

			if (!video) {
				return;
			}

			video.muted = !video.muted;
			syncMediaState();
		};

		const handleVolumeChange = (value: number) => {
			const video = videoRef.current;

			if (!video) {
				return;
			}

			video.volume = value;
			video.muted = value === 0;
			syncMediaState();
		};

		const toggleFullscreen = async () => {
			const player = playerRef.current;

			if (!player) {
				return;
			}

			if (document.fullscreenElement) {
				await document.exitFullscreen().catch(() => undefined);
				return;
			}

			await player.requestFullscreen().catch(() => undefined);
		};

		return (
			<div ref={playerRef} className="video-player-shell">
				<div
					ref={setPreviewRef}
					className={`video-preview-wrap ${cropEnabled ? 'is-crop-enabled' : ''}`}
					onPointerDown={onPreviewPointerDown}
					onPointerMove={onPreviewPointerMove}
					onPointerUp={onPreviewPointerUp}
					onPointerCancel={onPreviewPointerCancel}
				>
					<video
						ref={videoRef}
						src={asset.url}
						className="video-preview"
						controls={false}
						preload="metadata"
						playsInline
						onLoadedMetadata={syncMediaState}
						onTimeUpdate={syncMediaState}
						onDurationChange={syncMediaState}
						onPlay={syncMediaState}
						onPause={syncMediaState}
						onEnded={syncMediaState}
						onVolumeChange={syncMediaState}
					>
						<track
							kind="captions"
							label={m.video_generated_captions_label()}
							src={subtitleUrl ?? 'data:text/vtt,WEBVTT%0A%0A'}
							default={Boolean(subtitleUrl)}
						/>
					</video>
					{cropEnabled && videoLayout ? (
						<div
							className="crop-layer video-crop-layer"
							style={{
								left: videoLayout.left,
								top: videoLayout.top,
								width: videoLayout.width,
								height: videoLayout.height,
							}}
						>
							{cropSelection ? (
								<div
									className={`crop-box ${
										isVideoCropping ? 'is-drawing' : ''
									} ${isMovingVideoCrop ? 'is-moving' : ''}`}
									style={{
										left: `${cropSelection.left * 100}%`,
										top: `${cropSelection.top * 100}%`,
										width: `${cropSelection.width * 100}%`,
										height: `${cropSelection.height * 100}%`,
									}}
									onPointerDown={onCropMovePointerDown}
								>
									<span className="crop-box-label">
										{m.video_focus_label()}
									</span>
									{(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
										<button
											key={handle}
											type="button"
											className={`crop-handle is-${handle}`}
											aria-label={m.video_focus_resize()}
											onPointerDown={(event) => {
												onCropHandlePointerDown(handle, event);
											}}
										/>
									))}
								</div>
							) : null}
						</div>
					) : null}
				</div>

				<div className="video-player-controls">
					<button
						type="button"
						className="video-player-icon-button"
						onClick={() => {
							void togglePlayback();
						}}
						aria-label={
							isPlaying ? m.video_player_pause() : m.video_player_play()
						}
						title={isPlaying ? m.video_player_pause() : m.video_player_play()}
					>
						{isPlaying ? <Pause size={16} /> : <Play size={16} />}
					</button>

					<label className="video-player-seek">
						<span className="sr-only">{m.video_player_seek()}</span>
						<input
							type="range"
							min="0"
							max={Math.max(duration, 0)}
							step="0.05"
							value={Math.min(currentTime, duration || 0)}
							onChange={(event) => {
								handleSeek(Number(event.target.value));
							}}
							style={
								{
									'--video-range-progress': `${seekProgress}%`,
								} as CSSProperties
							}
						/>
					</label>

					<span className="video-player-time">
						{formatTimelineTime(currentTime)} / {formatTimelineTime(duration)}
					</span>

					<button
						type="button"
						className="video-player-icon-button"
						onClick={toggleMute}
						aria-label={
							isMuted || volume === 0
								? m.video_player_unmute()
								: m.video_player_mute()
						}
						title={
							isMuted || volume === 0
								? m.video_player_unmute()
								: m.video_player_mute()
						}
					>
						{isMuted || volume === 0 ? (
							<VolumeX size={16} />
						) : (
							<Volume2 size={16} />
						)}
					</button>

					<label className="video-player-volume">
						<span className="sr-only">{m.video_player_volume()}</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={isMuted ? 0 : volume}
							onChange={(event) => {
								handleVolumeChange(Number(event.target.value));
							}}
							style={
								{
									'--video-range-progress': `${volumeProgress}%`,
								} as CSSProperties
							}
						/>
					</label>

					<button
						type="button"
						className="video-player-icon-button"
						disabled={!subtitleUrl}
						aria-label={m.video_player_captions()}
						aria-pressed={Boolean(subtitleUrl)}
						title={m.video_player_captions()}
					>
						<Captions size={16} />
					</button>

					<button
						type="button"
						className="video-player-icon-button"
						onClick={() => {
							void toggleFullscreen();
						}}
						aria-label={m.video_player_fullscreen()}
						aria-pressed={isFullscreen}
						title={m.video_player_fullscreen()}
					>
						<Maximize2 size={16} />
					</button>
				</div>
			</div>
		);
	},
);
