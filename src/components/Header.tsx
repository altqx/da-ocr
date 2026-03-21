import { Link } from '@tanstack/react-router';
import ParaglideLocaleSwitcher from './LocaleSwitcher.tsx';
import ThemeToggle from './ThemeToggle';

export default function Header() {
	return (
		<header className="sticky top-0 z-50 border-b-3 border-[var(--border)] bg-[var(--header-bg)]">
			<nav className="flex items-center">
				<h2 className="m-0 border-r-3 border-[var(--border)] px-4 py-2.5 text-sm font-extrabold tracking-tight">
					<Link
						to="/"
						className="text-[var(--ink)] no-underline uppercase tracking-widest"
					>
						<span className="bg-[var(--accent-strong)] text-[var(--accent)] px-1.5 py-0.5 mr-1">
							DA
						</span>
						OCR
					</Link>
				</h2>

				<div className="ml-auto flex items-center">
					<div className="border-l-3 border-[var(--border)]">
						<ParaglideLocaleSwitcher />
					</div>
					<div className="border-l-3 border-[var(--border)]">
						<ThemeToggle />
					</div>
				</div>
			</nav>
		</header>
	);
}
