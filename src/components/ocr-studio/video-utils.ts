import { m } from '../../i18n';
import { MAX_VIDEO_FRAMES, VIDEO_FRAME_MAX_EDGE } from './constants';
import type {
	CropSelection,
	VideoAsset,
	VideoFrameResult,
	VideoFrameStatus,
	VideoTimelineCue,
} from './types';
import { clamp, getCropPixels } from './utils';

export function isVideoFile(file: File) {
	return (
		file.type.startsWith('video/') ||
		/\.(avi|m4v|mkv|mov|mp4|ogv|webm)$/i.test(file.name)
	);
}

export function getVideoFrameStatusLabel(status: VideoFrameStatus) {
	switch (status) {
		case 'running':
			return m.video_frame_status_running();
		case 'done':
			return m.video_frame_status_done();
		case 'error':
			return m.video_frame_status_error();
		default:
			return m.video_frame_status_queued();
	}
}

export function normalizeOcrTextForDedupe(text: string) {
	return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function sanitizeSubtitleText(text: string) {
	return text
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.join('\n');
}

export function formatTimelineTime(seconds: number) {
	if (!Number.isFinite(seconds)) {
		return '00:00.0';
	}

	const safeSeconds = Math.max(0, seconds);
	const minutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds - minutes * 60;

	return `${String(minutes).padStart(2, '0')}:${remainingSeconds
		.toFixed(1)
		.padStart(4, '0')}`;
}

function formatSrtTime(seconds: number) {
	const totalMilliseconds = Math.max(
		0,
		Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000),
	);
	const hours = Math.floor(totalMilliseconds / 3_600_000);
	const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
	const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
	const milliseconds = totalMilliseconds % 1000;

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
		2,
		'0',
	)}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(
		3,
		'0',
	)}`;
}

function formatVttTime(seconds: number) {
	return formatSrtTime(seconds).replace(',', '.');
}

export function getVideoSampleTimes(duration: number, interval: number) {
	if (!Number.isFinite(duration) || duration <= 0) {
		return [0];
	}

	const requestedCount = Math.max(1, Math.ceil(duration / interval));
	const sampleCount = Math.min(requestedCount, MAX_VIDEO_FRAMES);
	const effectiveInterval =
		requestedCount > MAX_VIDEO_FRAMES ? duration / sampleCount : interval;
	const lastSeekableTime = Math.max(0, duration - 0.05);

	return Array.from({ length: sampleCount }, (_, index) =>
		clamp(index * effectiveInterval, 0, lastSeekableTime),
	);
}

export function getVideoTimelineCues(
	frames: VideoFrameResult[],
	duration: number,
): VideoTimelineCue[] {
	const sortedFrames = frames
		.filter((frame) => frame.status === 'done')
		.slice()
		.sort((left, right) => left.time - right.time);
	const cues: VideoTimelineCue[] = [];
	let activeCue: VideoTimelineCue | null = null;

	for (const [index, frame] of sortedFrames.entries()) {
		const nextTime = sortedFrames[index + 1]?.time ?? duration;
		const end = Math.max(nextTime, frame.time + 0.1);

		if (!frame.normalizedText) {
			activeCue = null;
			continue;
		}

		if (
			activeCue &&
			normalizeOcrTextForDedupe(activeCue.text) === frame.normalizedText
		) {
			activeCue.end = end;
			activeCue.frameIndexes.push(frame.index);
			continue;
		}

		activeCue = {
			id: `${frame.id}-cue`,
			start: frame.time,
			end,
			text: sanitizeSubtitleText(frame.text),
			frameIndexes: [frame.index],
		};
		cues.push(activeCue);
	}

	return cues.filter((cue) => cue.text);
}

export function getSubtitleFile(cues: VideoTimelineCue[]) {
	return cues
		.map(
			(cue, index) =>
				`${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(
					cue.end,
				)}\n${cue.text}`,
		)
		.join('\n\n');
}

export function getWebVttFile(cues: VideoTimelineCue[]) {
	return [
		'WEBVTT',
		'',
		...cues.map(
			(cue, index) =>
				`${index + 1}\n${formatVttTime(cue.start)} --> ${formatVttTime(
					cue.end,
				)}\n${cue.text}`,
		),
	].join('\n\n');
}

async function waitForVideoEvent(video: HTMLVideoElement, eventName: string) {
	await new Promise<void>((resolve, reject) => {
		const handleEvent = () => {
			cleanup();
			resolve();
		};
		const handleError = () => {
			cleanup();
			reject(new Error('Failed to decode the video file.'));
		};
		const cleanup = () => {
			video.removeEventListener(eventName, handleEvent);
			video.removeEventListener('error', handleError);
		};

		video.addEventListener(eventName, handleEvent, { once: true });
		video.addEventListener('error', handleError, { once: true });
	});
}

export async function createLoadedVideoElement(url: string) {
	const video = document.createElement('video');
	video.preload = 'auto';
	video.muted = true;
	video.playsInline = true;
	video.src = url;

	await waitForVideoEvent(video, 'loadedmetadata');
	return video;
}

export async function readVideoAsset(file: File) {
	const url = URL.createObjectURL(file);

	try {
		const video = await createLoadedVideoElement(url);
		const asset = {
			name: file.name,
			size: file.size,
			type: file.type || 'video',
			url,
			width: video.videoWidth,
			height: video.videoHeight,
			duration: Number.isFinite(video.duration) ? video.duration : 0,
		} satisfies VideoAsset;

		video.removeAttribute('src');
		video.load();
		return asset;
	} catch (cause) {
		URL.revokeObjectURL(url);
		throw cause;
	}
}

async function seekVideoFrame(video: HTMLVideoElement, time: number) {
	const targetTime = clamp(time, 0, Math.max(0, video.duration - 0.05));

	if (Math.abs(video.currentTime - targetTime) <= 0.01) {
		return;
	}

	const seekPromise = waitForVideoEvent(video, 'seeked');
	video.currentTime = targetTime;
	await seekPromise;
}

export async function extractVideoFrame(
	video: HTMLVideoElement,
	time: number,
	crop: CropSelection | null = null,
) {
	if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		await waitForVideoEvent(video, 'loadeddata');
	}

	await seekVideoFrame(video, time);

	const sourceWidth = video.videoWidth;
	const sourceHeight = video.videoHeight;
	const cropPixels = getCropPixels(crop, {
		width: sourceWidth,
		height: sourceHeight,
	});
	const sourceX = cropPixels?.x ?? 0;
	const sourceY = cropPixels?.y ?? 0;
	const frameWidth = cropPixels?.width ?? sourceWidth;
	const frameHeight = cropPixels?.height ?? sourceHeight;
	const scale = Math.min(
		VIDEO_FRAME_MAX_EDGE / frameWidth,
		VIDEO_FRAME_MAX_EDGE / frameHeight,
		1,
	);
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(frameWidth * scale));
	canvas.height = Math.max(1, Math.round(frameHeight * scale));

	const context = canvas.getContext('2d');

	if (!context) {
		throw new Error(
			'Canvas frame extraction is not available in this browser.',
		);
	}

	context.drawImage(
		video,
		sourceX,
		sourceY,
		frameWidth,
		frameHeight,
		0,
		0,
		canvas.width,
		canvas.height,
	);
	const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.72);
	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((value) => {
			if (!value) {
				reject(new Error('Failed to extract a video frame.'));
				return;
			}

			resolve(value);
		}, 'image/png');
	});

	return {
		blob,
		thumbnailDataUrl,
		width: canvas.width,
		height: canvas.height,
	};
}
