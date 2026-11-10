import { getAdapter } from "@/lib/db/driver.js";
import { getShareToken, touchShareToken } from "@/lib/db/repos/abuseRepo.js";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

/**
 * Public read-only monitor for one API key. Reached by link only — the token is the
 * whole authorisation. It answers with aggregates and never with a credential: no key
 * value, no provider credentials, no way to make a request.
 */

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

async function aggregate(db, keyValue) {
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
  const failed = one(
    `SELECT COUNT(*) AS n ${scope} AND status IS NOT NULL AND status NOT IN ('success','ok','200')`,
    [keyValue]
  );

  return {
    total: { ...total, tokens: (Number(total.input) || 0) + (Number(total.output) || 0) },
    today: { ...today, tokens: (Number(today.input) || 0) + (Number(today.output) || 0) },
    month: { ...month, tokens: (Number(month.input) || 0) + (Number(month.output) || 0) },
    errorCount: Number(failed.n) || 0,
  };
}

function Card({ title, requests, tokens }) {
  return (
    <div className="card">
      <div className="label">{title}</div>
      <div className="value">{fmt(requests)}</div>
      <div className="sub">requests</div>
      <div className="tokens">{fmt(tokens)} tokens</div>
    </div>
  );
}

export default async function SharePage({ params }) {
  const { token } = await params;
  const share = await getShareToken(token);

  if (!share) {
    return (
      <main>
        <div className="wrap">
          <div className="card wide">
            <div className="label">Link unavailable</div>
            <p className="sub">
              This share link is unknown, expired, or has been revoked. Ask whoever issued it for a new one.
            </p>
          </div>
        </div>
        <Styles />
      </main>
    );
  }

  const key = await getApiKeyById(share.apiKeyId).catch(() => null);
  const db = await getAdapter();
  const stats = await aggregate(db, key?.key || "");
  await touchShareToken(token);

  const successRate =
    stats.total.requests > 0
      ? (((stats.total.requests - stats.errorCount) / stats.total.requests) * 100).toFixed(1)
      : "100.0";

  return (
    <main>
      <div className="wrap">
        <header>
          <h1>{key?.name || "Shared key"}</h1>
          <p className="sub">
            Usage monitor · read-only
            {share.expiresAt ? ` · link expires ${new Date(share.expiresAt).toISOString().slice(0, 10)}` : " · no expiry"}
          </p>
        </header>

        <section className="grid">
          <Card title="All time" requests={stats.total.requests} tokens={stats.total.tokens} />
          <Card title="Today (UTC)" requests={stats.today.requests} tokens={stats.today.tokens} />
          <Card title="This month (UTC)" requests={stats.month.requests} tokens={stats.month.tokens} />
        </section>

        <section className="grid">
          <div className="card">
            <div className="label">Errors</div>
            <div className="value">{fmt(stats.errorCount)}</div>
            <div className="sub">failed requests</div>
          </div>
          <div className="card">
            <div className="label">Success rate</div>
            <div className="value">{successRate}%</div>
            <div className="sub">of {fmt(stats.total.requests)} requests</div>
          </div>
          <div className="card">
            <div className="label">Cost</div>
            <div className="value">${(Number(stats.total.cost) || 0).toFixed(4)}</div>
            <div className="sub">recorded spend</div>
          </div>
        </section>

        <footer>
          <span>Views: {fmt((Number(share.viewCount) || 0) + 1)}</span>
          <span>This page shows totals only — no credentials, no model list.</span>
        </footer>
      </div>
      <Styles />
    </main>
  );
}

function Styles() {
  return (
    <style>{`
      :root { color-scheme: dark; }
      body, main { margin: 0; background: #0b0b0f; color: #eceaf5; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 64px; }
      header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
      .sub { color: #8d8aa3; margin: 0; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-top: 22px; }
      .card { border: 1px solid #23222e; background: #121219; border-radius: 12px; padding: 16px 18px; }
      .card.wide { grid-column: 1 / -1; }
      .label { color: #8d8aa3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
      .value { font-size: 26px; font-weight: 600; margin-top: 8px; font-variant-numeric: tabular-nums; }
      .tokens { color: #8d8aa3; font-size: 12px; margin-top: 2px; }
      footer { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 28px; color: #6f6c85; font-size: 12px; }
    `}</style>
  );
}
