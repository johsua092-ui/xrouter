"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          router.replace("/dashboard");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <div className="min-h-screen bg-bg text-text-main flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[6px] border border-border bg-surface p-6 sm:p-8 text-center shadow-[var(--shadow-elev)] space-y-4">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-2xl">error_outline</span>
        </div>
        <div>
          <h1 className="text-lg font-bold text-text-main">404 - Page Not Found</h1>
          <p className="mt-1 text-xs text-text-muted">
            The page you are looking for does not exist. Redirecting to Dashboard in {countdown}s...
          </p>
        </div>
        <div className="pt-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center gap-2 rounded-[6px] bg-primary px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-primary/90 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">dashboard</span>
            Back to Dashboard Now
          </Link>
        </div>
      </div>
    </div>
  );
}
