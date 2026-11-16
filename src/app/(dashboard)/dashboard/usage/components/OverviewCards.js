"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import Badge from "@/shared/components/Badge";
import { Sparkline } from "./UsageChartsBits.js";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

/**
 * Industrial Telemetry Card. High-density, left-aligned, crisp typography,
 * top hairline accent strip, and sparkline trend.
 */
function TrendCard({
  label,
  value,
  title = "",
  icon,
  accentColor = "bg-border",
  tone = "text-text-main",
  footnote = null,
  trend = [],
  trendLabel = "",
  className,
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col justify-between rounded-[6px] border border-border bg-surface p-3.5 shadow-[var(--shadow-elev)] transition-all duration-150 hover:border-brand-500/50 hover:bg-surface-2 overflow-hidden",
        className
      )}
    >
      {/* Top metric accent rule */}
      <span className={cn("absolute top-0 inset-x-0 h-[2px]", accentColor)} aria-hidden="true" />

      {/* Header: Icon + Monospace Label */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="flex items-center gap-1.5 text-[10.5px] font-mono font-semibold uppercase tracking-wider text-text-muted truncate">
          {icon && <span className="material-symbols-outlined text-[15px] shrink-0 text-text-subtle">{icon}</span>}
          <span className="truncate">{label}</span>
        </span>
      </div>

      {/* Primary Metric Value */}
      <div className="my-2 min-w-0">
        <div
          className={cn("truncate text-xl sm:text-2xl xl:text-[26px] font-bold font-mono tracking-tight", tone)}
          title={title}
        >
          {value}
        </div>
      </div>

      {/* Footer / Footnote / Sparkline */}
      <div className="flex flex-col gap-1.5 min-h-[22px] justify-end">
        {footnote && (
          <div className="text-[10px] text-text-muted flex items-center min-w-0">
            {footnote}
          </div>
        )}
        {trend && trend.length >= 2 && (
          <div className={cn("w-full opacity-80", tone)}>
            <Sparkline values={trend} height={20} ariaLabel={trendLabel || `${label} trend`} />
          </div>
        )}
      </div>
    </div>
  );
}

TrendCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  title: PropTypes.string,
  icon: PropTypes.string,
  accentColor: PropTypes.string,
  tone: PropTypes.string,
  footnote: PropTypes.node,
  trend: PropTypes.arrayOf(PropTypes.number),
  trendLabel: PropTypes.string,
  className: PropTypes.string,
};

export default function OverviewCards({ stats, trends = null }) {
  const cacheHitRate =
    stats.totalPromptTokens > 0
      ? ((stats.totalCachedTokens || 0) / stats.totalPromptTokens) * 100
      : 0;

  const t = trends?.totals || {};
  const days = trends?.days || 0;

  return (
    <div className="grid min-w-0 grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3.5">
      <TrendCard
        label="Total Requests"
        value={fmt(stats.totalRequests)}
        title={fmt(stats.totalRequests)}
        icon="call_made"
        accentColor="bg-text-subtle"
        trend={t.requests}
        trendLabel={`Requests per day over the last ${days} days`}
      />

      <TrendCard
        label="Input Tokens"
        value={fmt(stats.totalPromptTokens)}
        title={fmt(stats.totalPromptTokens)}
        icon="arrow_downward"
        accentColor="bg-brand-500"
        tone="text-primary"
        trend={t.input}
        trendLabel={`Input tokens per day over the last ${days} days`}
      />

      <TrendCard
        label="Cached Tokens"
        value={fmt(stats.totalCachedTokens)}
        title={fmt(stats.totalCachedTokens)}
        icon="cached"
        accentColor="bg-info"
        tone="text-info"
        footnote={
          cacheHitRate > 0 ? (
            <Badge variant="info" size="sm">
              {cacheHitRate.toFixed(1)}% cache hit
            </Badge>
          ) : (
            <span className="text-text-subtle font-mono">0% hit rate</span>
          )
        }
        trend={t.cached}
        trendLabel={`Cached tokens per day over the last ${days} days`}
      />

      <TrendCard
        label="Output Tokens"
        value={fmt(stats.totalCompletionTokens)}
        title={fmt(stats.totalCompletionTokens)}
        icon="arrow_upward"
        accentColor="bg-success"
        tone="text-success"
        trend={t.output}
        trendLabel={`Output tokens per day over the last ${days} days`}
      />

      <TrendCard
        label="Est. Cost"
        value={`~${fmtCost(stats.totalCost)}`}
        title={`~${fmtCost(stats.totalCost)}`}
        icon="payments"
        accentColor="bg-warning"
        tone="text-warning"
        footnote={<span className="text-[10px] text-text-muted font-mono truncate">est. billing</span>}
        trend={t.cost}
        trendLabel={`Estimated cost per day over the last ${days} days`}
        className="col-span-2 sm:col-span-1"
      />
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
  trends: PropTypes.object,
};
