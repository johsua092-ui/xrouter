"use client";

import React from "react";

export default function LogoMark({ className = "size-full" }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`.trim()}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/favicon.svg"
        alt="X Router"
        className="size-full object-contain hidden dark:block [filter:var(--logo-filter,none)]"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/favicon-light.svg"
        alt="X Router"
        className="size-full object-contain block dark:hidden [filter:var(--logo-filter,none)]"
      />
    </span>
  );
}
