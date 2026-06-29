import { Film, ImagePlus, Mic } from 'lucide-react';
import { m } from '../../i18n';
import type { StudioMode } from './types';

type ModeTabsProps = {
	activeMode: StudioMode;
	isImageBusy: boolean;
	isAudioRunning: boolean;
	isVideoRunning: boolean;
	onModeChange: (mode: StudioMode) => void;
};

export default function ModeTabs({
	activeMode,
	isImageBusy,
	isAudioRunning,
	isVideoRunning,
	onModeChange,
}: ModeTabsProps) {
	return (
		<div className="mode-tabs" role="tablist" aria-label={m.mode_tabs_aria()}>
			<button
				type="button"
				role="tab"
				aria-selected={activeMode === 'image'}
				onClick={() => {
					onModeChange('image');
				}}
				className={`mode-tab ${activeMode === 'image' ? 'is-active' : ''}`}
				disabled={isVideoRunning || isAudioRunning}
			>
				<ImagePlus size={16} />
				{m.mode_image()}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={activeMode === 'video'}
				onClick={() => {
					onModeChange('video');
				}}
				className={`mode-tab ${activeMode === 'video' ? 'is-active' : ''}`}
				disabled={isImageBusy || isAudioRunning}
			>
				<Film size={16} />
				{m.mode_video()}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={activeMode === 'audio'}
				onClick={() => {
					onModeChange('audio');
				}}
				className={`mode-tab ${activeMode === 'audio' ? 'is-active' : ''}`}
				disabled={isImageBusy || isVideoRunning}
			>
				<Mic size={16} />
				{m.mode_audio()}
			</button>
		</div>
	);
}
