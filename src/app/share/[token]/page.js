import { getAdapter } from "@/lib/db/driver.js";
import { getShareToken, touchShareToken } from "@/lib/db/repos/abuseRepo.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

/**
 * Public read-only monitor for one API key. Reached by link only — the token is the
 * whole authorisation. It answers with aggregates and never with a credential: no key
 * value, no provider credentials, no way to make a request.
 *
 * Look is the dashboard's own instrument-plate language — near-square corners, one
 * hairline border, a divided header strip, ember accent, tabular figures — built from
 * the shared theme tokens so it follows the workspace palette in light and dark.
 * Every chart here is hand-drawn SVG reading real rows; nothing is generated imagery.
 */

const DAYS_SHOWN = 14;
const LATENCY_SAMPLE = 400;

function dayStartIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function monthStartIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Number(n) || 0);
}

/** 4_568_104 → 4.57M, so a plate stays one line wide. */
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function ms(value) {
  const v = Number(value) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function lastDays(count) {
  const out = [];
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function percentiles(values) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!list.length) return null;
  const at = (q) => list[Math.min(list.length - 1, Math.floor((q / 100) * list.length))];
  return {
    n: list.length,
    avg: Math.round(list.reduce((s, v) => s + v, 0) / list.length),
    p50: at(50),
    p95: at(95),
    min: list[0],
    max: list[list.length - 1],
  };
}

async function collect(db, keyRow) {
  const keyValue = keyRow?.key || "";
  const one = (sql, args) => db.get(sql, args) || {};
  const scope = `FROM usageHistory WHERE apiKey = ?`;

  const total = one(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(promptTokens),0) AS input, COALESCE(SUM(completionTokens),0) AS output,
            COALESCE(SUM(cost),0) AS cost ${scope}`,
    [keyValue]
  );
  const today = one(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(promptTokens),0) AS input, COALESCE(SUM(completionTokens),0) AS output
     ${scope} AND timestamp >= ?`,
    [keyValue, dayStartIso()]
  );
  const month = one(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(promptTokens),0) AS input, COALESCE(SUM(completionTokens),0) AS output
     ${scope} AND timestamp >= ?`,
    [keyValue, monthStartIso()]
  );

  const statusRows = db.all(`SELECT status, COUNT(*) AS n ${scope} GROUP BY status`, [keyValue]) || [];
  const statuses = new Map(statusRows.map((r) => [String(r.status || "unknown"), Number(r.n) || 0]));
  const failed = Array.from(statuses.entries())
    .filter(([s]) => !["ok", "success", "200"].includes(s.toLowerCase()))
    .reduce((sum, [, n]) => sum + n, 0);

  const dayRows = db.all(
    `SELECT substr(timestamp,1,10) AS day, COUNT(*) AS n, COALESCE(SUM(promptTokens+completionTokens),0) AS tokens
     ${scope} GROUP BY day`,
    [keyValue]
  ) || [];
  const byDay = new Map(dayRows.map((r) => [r.day, { requests: Number(r.n) || 0, tokens: Number(r.tokens) || 0 }]));
  const days = lastDays(DAYS_SHOWN).map((day) => ({ day, ...(byDay.get(day) || { requests: 0, tokens: 0 }) }));

  const models = (db.all(
    `SELECT model, COUNT(*) AS n, COALESCE(SUM(promptTokens+completionTokens),0) AS tokens
     ${scope} GROUP BY model ORDER BY n DESC LIMIT 6`,
    [keyValue]
  ) || []).map((r) => ({ model: String(r.model || "unknown"), requests: Number(r.n) || 0, tokens: Number(r.tokens) || 0 }));

  const recent = (db.all(
    `SELECT timestamp, model, promptTokens, completionTokens, cost, status
     ${scope} ORDER BY timestamp DESC LIMIT 8`,
    [keyValue]
  ) || []).map((r) => ({
    timestamp: r.timestamp,
    model: String(r.model || "—"),
    tokens: (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0),
    cost: Number(r.cost) || 0,
    status: String(r.status || "unknown"),
  }));

  // Latency lives in requestDetails, which keys rows by the masked credential.
  let latency = { ttft: null, total: null };
  const masked = keyValue.length > 10 ? `${keyValue.slice(0, 6)}...${keyValue.slice(-4)}` : "";
  if (masked) {
    const detail = (db.all(
      `SELECT data FROM requestDetails WHERE data LIKE ? ORDER BY timestamp DESC LIMIT ?`,
      [`%${masked}%`, LATENCY_SAMPLE]
    ) || []);
    const ttft = [];
    const totals = [];
    for (const row of detail) {
      try {
        const parsed = JSON.parse(row.data);
        if (parsed?.latency?.ttft) ttft.push(Number(parsed.latency.ttft));
        if (parsed?.latency?.total) totals.push(Number(parsed.latency.total));
      } catch {
        /* a row that will not parse is simply not a latency sample */
      }
    }
    latency = { ttft: percentiles(ttft), total: percentiles(totals) };
  }

  const sum = (row) => ({
    ...row,
    tokens: (Number(row.input) || 0) + (Number(row.output) || 0),
  });

  return {
    total: sum(total),
    today: sum(today),
    month: sum(month),
    errorCount: failed,
    statuses: Array.from(statuses.entries()).map(([status, n]) => ({ status, n })),
    days,
    models,
    recent,
    latency,
  };
}

/* ------------------------------------------------------------------ primitives */

function Plate({ label, value, unit, footnote, tone = "main", className = "" }) {
  const toneClass = {
    main: "text-text-main",
    success: "text-success",
    danger: "text-danger",
    primary: "text-primary",
    muted: "text-text-muted",
  }[tone];

  return (
    <div className={`relative overflow-hidden rounded-[6px] border border-border bg-surface ${className}`}>
      <span className="absolute inset-y-0 left-0 w-[2px] bg-primary/70" aria-hidden="true" />
      <div className="flex items-baseline justify-between gap-2 border-b border-border py-2 pl-[18px] pr-4">
        <span className="text-[11px] uppercase tracking-[0.08em] text-text-muted">{label}</span>
        {unit ? <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted/70">{unit}</span> : null}
      </div>
      <div className="py-4 pl-[18px] pr-4">
        <div className={`text-[26px] font-semibold leading-none tabular-nums ${toneClass}`}>{value}</div>
        {footnote ? <div className="mt-2 text-[11px] text-text-muted">{footnote}</div> : null}
      </div>
    </div>
  );
}

function Section({ title, note, children, className = "" }) {
  return (
    <section className={`overflow-hidden rounded-[6px] border border-border bg-surface ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-[18px] py-2">
        <span className="text-[11px] uppercase tracking-[0.08em] text-text-muted">{title}</span>
        {note ? <span className="text-[10px] text-text-muted/70">{note}</span> : null}
      </div>
      <div className="px-[18px] py-4">{children}</div>
    </section>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <span
        className="grid size-7 place-items-center rounded-[5px] bg-primary text-[13px] font-bold text-white"
        aria-hidden="true"
      >
        X
      </span>
      <span className="text-[13px] font-semibold tracking-[0.14em] text-text-main">X ROUTER</span>
    </div>
  );
}

/** Requests per day as a column chart. Height is proportional to the busiest day. */
function DailyBars({ days }) {
  const peak = Math.max(1, ...days.map((d) => d.requests));
  const width = 640;
  const height = 132;
  const gap = 8;
  const barWidth = (width - gap * (days.length - 1)) / days.length;
  const today = days[days.length - 1]?.day;

  return (
    <svg viewBox={`0 0 ${width} ${height + 26}`} className="h-[168px] w-full" role="img" aria-label="Requests per day">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1="0"
          x2={width}
          y1={height - height * f}
          y2={height - height * f}
          className="stroke-border"
          strokeWidth="1"
          strokeDasharray={f === 1 ? "0" : "3 5"}
        />
      ))}
      {days.map((d, i) => {
        const h = Math.round((d.requests / peak) * (height - 6));
        const x = i * (barWidth + gap);
        const isToday = d.day === today;
        return (
          <g key={d.day}>
            <title>{`${d.day} — ${fmt(d.requests)} requests, ${fmt(d.tokens)} tokens`}</title>
            <rect
              x={x}
              y={height - h}
              width={barWidth}
              height={Math.max(h, d.requests > 0 ? 3 : 0)}
              rx="2"
              className={isToday ? "fill-primary" : "fill-primary/45"}
            />
            <text
              x={x + barWidth / 2}
              y={height + 14}
              textAnchor="middle"
              className="fill-text-muted text-[9px]"
              style={{ fontSize: 9 }}
            >
              {d.day.slice(8)}
            </text>
            {d.requests > 0 && peak === d.requests ? (
              <text
                x={x + barWidth / 2}
                y={height - h - 6}
                textAnchor="middle"
                className="fill-text-main"
                style={{ fontSize: 9 }}
              >
                {d.requests}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** p50 → p95 spread on a track from fastest to slowest observed. */
function SpreadBar({ stats }) {
  if (!stats || stats.n < 1) return <div className="text-[11px] text-text-muted">no samples retained</div>;
  const span = Math.max(1, stats.max - stats.min);
  const at = (v) => `${Math.min(100, Math.max(0, ((v - stats.min) / span) * 100))}%`;

  return (
    <div className="pt-1">
      <div className="relative h-[6px] rounded-full bg-surface-3">
        <div
          className="absolute inset-y-0 rounded-full bg-primary/45"
          style={{ left: at(stats.p50), right: `calc(100% - ${at(stats.p95)})` }}
        />
        <span className="absolute -top-[3px] size-3 -translate-x-1/2 rounded-full border-2 border-surface bg-primary" style={{ left: at(stats.p50) }} />
      </div>
      <div className="mt-2 flex justify-between text-[10px] tabular-nums text-text-muted">
        <span>fastest {ms(stats.min)}</span>
        <span>p95 {ms(stats.p95)}</span>
        <span>slowest {ms(stats.max)}</span>
      </div>
    </div>
  );
}

/** Horizontal bars for the model mix. */
function ModelBars({ models }) {
  const peak = Math.max(1, ...models.map((m) => m.requests));
  return (
    <div className="flex flex-col gap-2.5">
      {models.map((m) => (
        <div key={m.model}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-mono text-[11px] text-text-main" title={m.model}>
              {m.model}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-text-muted">
              {fmt(m.requests)} req · {compact(m.tokens)} tok
            </span>
          </div>
          <div className="mt-1 h-[5px] w-full overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-primary/70" style={{ width: `${(m.requests / peak) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** success/failed split as one segmented bar. */
function StatusSplit({ statuses, total }) {
  if (!total) return <div className="text-[11px] text-text-muted">no traffic recorded</div>;
  const slices = [
    { key: "ok", className: "bg-success" },
    { key: "failed", className: "bg-danger" },
  ];
  const ok = statuses
    .filter((s) => ["ok", "success", "200"].includes(s.status.toLowerCase()))
    .reduce((sum, s) => sum + s.n, 0);
  const failedTotal = Math.max(0, total - ok);
  const values = { ok, failed: failedTotal };

  return (
    <div>
      <div className="flex h-[6px] w-full overflow-hidden rounded-full bg-surface-3">
        {slices.map((s) => (
          <div key={s.key} className={s.className} style={{ width: `${(values[s.key] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-[2px] bg-success" aria-hidden="true" />
          <span className="text-text-muted">succeeded</span>
          <span className="ml-auto tabular-nums text-text-main">{fmt(values.ok)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-[2px] bg-danger" aria-hidden="true" />
          <span className="text-text-muted">failed</span>
          <span className="ml-auto tabular-nums text-text-main">{fmt(values.failed)}</span>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const ok = ["ok", "success", "200"].includes(String(status).toLowerCase());
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${
        ok ? "border-success-border bg-success-bg text-success" : "border-danger-border bg-danger-bg text-danger"
      }`}
    >
      {status}
    </span>
  );
}

function stamp(iso) {
  return String(iso || "").replace("T", " ").slice(0, 19);
}

/* ---------------------------------------------------------------------- page */

export default async function SharePage({ params }) {
  const { token } = await params;
  const share = await getShareToken(token);

  if (!share) {
    return (
      <main className="min-h-screen bg-bg text-text-main">
        <div className="mx-auto w-full max-w-[980px] px-5 py-10">
          <Wordmark />
          <div className="relative mt-8 overflow-hidden rounded-[6px] border border-border bg-surface">
            <span className="absolute inset-y-0 left-0 w-[2px] bg-danger/70" aria-hidden="true" />
            <div className="border-b border-border px-[18px] py-2">
              <span className="text-[11px] uppercase tracking-[0.08em] text-text-muted">Link unavailable</span>
            </div>
            <p className="px-[18px] py-4 text-sm text-text-muted">
              This share link is unknown, expired, or has been revoked. Ask whoever issued it for a new one.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const key = await getApiKeyById(share.apiKeyId).catch(() => null);
  const db = await getAdapter();
  const s = await collect(db, key);
  await touchShareToken(token);

  const requests = Number(s.total.requests) || 0;
  const successRate = requests > 0 ? (((requests - s.errorCount) / requests) * 100).toFixed(1) : "100.0";
  const avgTokens = requests > 0 ? Math.round((Number(s.total.tokens) || 0) / requests) : 0;
  const avgCost = requests > 0 ? (Number(s.total.cost) || 0) / requests : 0;

  return (
    <main className="min-h-screen bg-bg text-text-main">
      <div className="mx-auto w-full max-w-[980px] px-5 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Wordmark />
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success-border bg-success-bg px-2.5 py-0.5 text-[11px] text-success">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              read-only
            </span>
            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-[11px] text-text-muted">
              {key?.name ? key.name : "shared"} · {share.token.slice(0, 8)}…
            </span>
          </div>
        </div>

        <header className="mt-8 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-0.01em]">{key?.name || "Shared key"}</h1>
            <p className="mt-1 text-xs text-text-muted">
              Usage monitor — totals only, no credentials and no model list
            </p>
          </div>
          <div className="text-right text-[11px] text-text-muted">
            <div>
              {share.expiresAt
                ? `expires ${new Date(share.expiresAt).toISOString().slice(0, 10)}`
                : "no expiry"}
            </div>
            <div className="tabular-nums">{fmt((Number(share.viewCount) || 0) + 1)} views</div>
          </div>
        </header>

        <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Plate label="Requests" value={fmt(requests)} footnote={`${fmt(s.today.requests)} today`} />
          <Plate
            label="Tokens"
            value={compact(s.total.tokens)}
            footnote={`${fmt(avgTokens)} avg / req`}
          />
          <Plate label="Spend" value={`$${(Number(s.total.cost) || 0).toFixed(2)}`} footnote={`$${avgCost.toFixed(5)} avg / req`} />
          <Plate
            label="Success"
            value={`${successRate}%`}
            tone={Number(successRate) >= 99 ? "success" : s.errorCount > 0 ? "danger" : "main"}
            footnote={`${fmt(s.errorCount)} failed`}
          />
        </section>

        <section className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Plate
            label="Time to first token"
            value={s.latency.ttft ? ms(s.latency.ttft.avg) : "—"}
            footnote={s.latency.ttft ? `avg · p50 ${ms(s.latency.ttft.p50)} · p95 ${ms(s.latency.ttft.p95)}` : "no samples retained"}
          />
          <Plate
            label="Total latency"
            value={s.latency.total ? ms(s.latency.total.avg) : "—"}
            footnote={s.latency.total ? `avg · p50 ${ms(s.latency.total.p50)} · p95 ${ms(s.latency.total.p95)}` : "no samples retained"}
            className="sm:col-span-2"
          />
        </section>

        <Section
          title="Total latency spread"
          note={s.latency.total ? `${s.latency.total.n} retained request${s.latency.total.n === 1 ? "" : "s"}` : "no samples"}
          className="mt-3"
        >
          <SpreadBar stats={s.latency.total} />
        </Section>

        <Section
          title={`Requests per day — last ${DAYS_SHOWN}`}
          note={`peak ${fmt(Math.max(0, ...s.days.map((d) => d.requests)))} · UTC`}
          className="mt-3"
        >
          <DailyBars days={s.days} />
        </Section>

        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Section title="Model mix" note={s.models.length ? `top ${s.models.length}` : "no traffic"}>
            {s.models.length ? <ModelBars models={s.models} /> : <p className="text-[11px] text-text-muted">Nothing recorded yet.</p>}
          </Section>

          <Section title="Outcomes" note={`${fmt(requests)} requests`}>
            <StatusSplit statuses={s.statuses} total={requests} />
          </Section>
        </div>

        <Section title="Recent requests" note="newest first" className="mt-3">
          {s.recent.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-text-muted">
                    <th className="pb-2 pr-3 font-medium">when (UTC)</th>
                    <th className="pb-2 pr-3 font-medium">model</th>
                    <th className="pb-2 pr-3 text-right font-medium">tokens</th>
                    <th className="pb-2 pr-3 text-right font-medium">cost</th>
                    <th className="pb-2 font-medium">status</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent.map((r, i) => (
                    <tr key={`${r.timestamp}-${i}`} className="border-t border-border/60">
                      <td className="py-1.5 pr-3 font-mono tabular-nums text-text-muted">{stamp(r.timestamp)}</td>
                      <td className="max-w-[220px] truncate py-1.5 pr-3 font-mono text-text-main" title={r.model}>
                        {r.model}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-text-main">{fmt(r.tokens)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-text-muted">${r.cost.toFixed(5)}</td>
                      <td className="py-1.5">
                        <StatusPill status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-text-muted">No requests recorded on this key yet.</p>
          )}
        </Section>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[11px] text-text-muted">
          <span>Powered by X Router</span>
          <span>Figures are read from this instance&apos;s own records.</span>
        </footer>
      </div>
    </main>
  );
}
