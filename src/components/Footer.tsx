import { Github } from 'lucide-react';
import { m } from '../i18n';

export default function Footer() {
	const year = new Date().getFullYear();

	return (
		<footer className="border-t-3 border-[var(--border)] px-4 py-2 text-[var(--ink-soft)]">
			<div className="flex items-center justify-between gap-4 text-xs font-bold uppercase tracking-widest">
				<p className="m-0">{m.footer_copy({ year })}</p>
				<div className="flex items-center gap-4">
					<a
						href="https://github.com/altqx/da-ocr"
						target="_blank"
						rel="noopener noreferrer"
						aria-label={m.sr_go_github()}
						className="flex items-center gap-1.5 text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors no-underline"
					>
						<Github size={12} />
						<span>GitHub</span>
					</a>
					<p className="m-0 flex items-center gap-1.5">
						<span className="inline-block w-1.5 h-1.5 bg-[var(--accent-dark)]" />
						{m.privacy_kicker()}
					</p>
				</div>
			</div>
		</footer>
	);
}
