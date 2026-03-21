import { useEffect, useRef, useState } from 'react';
import { getLocale, locales, setLocale } from '#/paraglide/runtime';
import { m } from '../i18n';

export default function ParaglideLocaleSwitcher() {
	const currentLocale = getLocale();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handleClick = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [open]);

	return (
		<div ref={ref} className="locale-switcher">
			<button
				type="button"
				className={`toolbar-btn locale-btn${open ? ' is-active' : ''}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={m.language_label()}
				onClick={() => setOpen((v) => !v)}
			>
				{currentLocale.toUpperCase()}
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`locale-arrow${open ? ' open' : ''}`}>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			{open && (
				<ul className="locale-menu" aria-label={m.language_label()}>
					{locales.map((locale) => (
						<li key={locale}>
							<button
								type="button"
								className={`locale-option${locale === currentLocale ? ' is-active' : ''}`}
								aria-current={locale === currentLocale ? 'true' : undefined}
								onClick={() => {
									setLocale(locale);
									setOpen(false);
								}}
							>
								{locale.toUpperCase()}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
