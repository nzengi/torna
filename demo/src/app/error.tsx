"use client";

// Route-level error boundary (renders inside the layout).
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md px-6 py-32 text-center">
      <h2 className="text-xl font-semibold text-fg">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px"
      >
        Try again
      </button>
    </div>
  );
}
