import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center px-6 py-32 text-center">
      <div className="display text-gradient text-7xl font-semibold">404</div>
      <h1 className="display mt-4 text-2xl font-semibold tracking-tight text-fg">This page is off the book</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        The page you are looking for does not rest on any leaf. It may have been cancelled, or the key
        never existed.
      </p>
      <Link
        href="/"
        className="mt-7 inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Torna
      </Link>
    </div>
  );
}
