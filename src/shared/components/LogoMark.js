"use client";

import React from "react";

export default function LogoMark({ className = "size-full", variant = "auto" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={className}
      fill="none"
    >
      <defs>
        <linearGradient id="xr-primary-grad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--color-primary, #E25539)" />
          <stop offset="100%" stopColor="var(--color-primary-hover, #EB6446)" />
        </linearGradient>
      </defs>

      {/* Adaptive Squircle Container */}
      <rect
        x="4"
        y="4"
        width="92"
        height="92"
        rx="22"
        className="fill-surface-2 dark:fill-[#18191C] stroke-border/70 dark:stroke-[#26282D]"
        strokeWidth="2"
      />

      {/* Arms */}
      <g
        stroke="url(#xr-primary-grad)"
        strokeLinecap="round"
        strokeWidth="7.5"
      >
        <line x1="26" y1="74" x2="44" y2="56" />
        <line x1="26" y1="26" x2="44" y2="44" />
        <line x1="56" y1="44" x2="72" y2="28" />
        <line x1="56" y1="56" x2="72" y2="72" />
      </g>

      {/* Arrowheads */}
      <path d="M63 23 H77 V37 L70 30 Z" fill="var(--color-primary, #EB6446)" />
      <path d="M77 63 V77 H63 L70 70 Z" fill="var(--color-primary, #EB6446)" />

      {/* Center Hub */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M50 39.5 C44.2 39.5 39.5 44.2 39.5 50 C39.5 55.8 44.2 60.5 50 60.5 C55.8 60.5 60.5 55.8 60.5 50 C60.5 44.2 55.8 39.5 50 39.5 Z 
           M50 45 C47.2 45 45 47.2 45 50 C45 52.8 47.2 55 50 55 C52.8 55 55 52.8 55 50 C55 47.2 52.8 45 50 45 Z"
        fill="url(#xr-primary-grad)"
      />
    </svg>
  );
}
