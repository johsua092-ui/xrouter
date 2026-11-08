'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

const statusLabels = { ready: 'ส่งข้อความสำเร็จแล้ว', credentials_valid: 'ผ่านตรวจสิทธิ์', expired: 'Token หมดอายุ', reauth_required: 'ต้องเชื่อมใหม่', quota_exhausted: 'โควตาหมด', paused: 'พักไว้', error: 'ตรวจพบปัญหา', unverified: 'รอทดสอบ' };

/* Status → semantic token triplet (bg/fg/border already tuned in globals.css
   so chips stay legible on solid panels in both light and Ember dark). */
const statusTone = {
  ready: 'success',
  credentials_valid: 'info',
  expired: 'warning',
  quota_exhausted: 'warning',
  reauth_required: 'danger',
  error: 'danger',
  paused: 'neutral',
  unverified: 'neutral',
};

const toneClasses = {
  success: 'bg-success-bg text-success-fg border-success-border',
  info: 'bg-info-bg text-info-fg border-info-border',
  warning: 'bg-warning-bg text-warning-fg border-warning-border',
  danger: 'bg-danger-bg text-danger-fg border-danger-border',
  neutral: 'bg-surface-3 text-text-muted border-border',
};

/* Severity order for the "needs attention" list — worst first, unknown keys appended. */
const severityOrder = ['reauth_required', 'error', 'expired', 'quota_exhausted', 'ready', 'credentials_valid', 'paused', 'unverified'];

function Chip({ tone = 'neutral', children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-5 ${toneClasses[tone] || toneClasses.neutral}`}>
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {children}
    </span>
  );
}

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-surface-3 ${className}`} aria-hidden="true" />;
}

function SectionCard({ id, title, icon, action, children, className = '' }) {
  return (
    <div className={`card-soft border border-border transition-shadow duration-200 hover:shadow-[var(--shadow-elevated)] ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[18px] leading-none text-primary">{icon}</span>
          <h2 id={id} className="text-base font-semibold tracking-tight text-text-main">{title}</h2>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function OperationsDashboard() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const refresh = useCallback(async () => {
    try { const response = await fetch('/api/maintenance', { cache: 'no-store' }); if (!response.ok) throw new Error(); setData(await response.json()); setLastUpdated(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })); setError(''); }
    catch { setError('โหลดสถานะไม่ได้ กรุณาเข้าสู่ระบบด้วยบัญชีผู้ดูแลแล้วลองอีกครั้ง'); }
  }, []);
  useEffect(() => { const initial = setTimeout(refresh, 0); const timer = setInterval(refresh, 30000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [refresh]);
  const action = async (name, extra = {}) => {
    setBusy(name); setNotice('');
    try {
      const response = await fetch('/api/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, ...extra }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setNotice(name === 'profiles' ? `เพิ่มโปรไฟล์แล้ว ${result.installed.length} รายการ · ข้ามรายการที่มีอยู่แล้วหรือยังเชื่อมบริการไม่ครบ ${result.skipped.length} รายการ` : name === 'backupEnabled' ? 'บันทึกการสำรองอัตโนมัติแล้ว' : `ตรวจสำเนากู้คืนสำเร็จ · ฐานข้อมูลสมบูรณ์ · ${result.verification.connections.toLocaleString('th-TH')} บัญชี`);
      await refresh();
    } catch (e) { setError(e.message || 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(''); }
  };
  const rank = (name) => { const i = severityOrder.indexOf(name); return i === -1 ? severityOrder.length : i; };
  const orderedCounts = data ? [...Object.entries(data.counts)].sort((a, b) => rank(a[0]) - rank(b[0])) : [];
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 p-5 md:p-8" lang="th">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="micro-label flex items-center gap-2"><span className="material-symbols-outlined text-[13px] leading-none text-primary">space_dashboard</span>X Router Control Center</p>
          <h1 className="text-3xl font-semibold tracking-tight text-text-main">ศูนย์ควบคุม X Router</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-text-muted">ดูบัญชีที่ใช้งานได้จริง เลือกโปรไฟล์โมเดล และดูแลข้อมูลในเครื่องจากหน้านี้</p></div>
        <button className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary" onClick={refresh}>อัปเดตสถานะ</button>
        {lastUpdated && (
          <p className="flex items-center gap-1.5 text-xs text-text-subtle">
            <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
            อัปเดตล่าสุด {lastUpdated}
          </p>
        )}
      </header>
      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg fade-in">
          <span className="material-symbols-outlined text-[18px] leading-none">error</span>
          <p className="flex-1">{error}</p>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-success-border bg-success-bg p-4 text-sm text-success-fg fade-in">
          <span className="material-symbols-outlined text-[18px] leading-none">check_circle</span>
          <p className="flex-1">{notice}</p>
        </div>
      )}
      {!data && !error && (
        <section className="space-y-6" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </section>
      )}
      {data && (
        <div className="fade-in space-y-8">
        <section aria-labelledby="accounts-title" className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <div>
            <div className="mb-4 flex items-baseline justify-between gap-3"><h2 id="accounts-title" className="text-xl font-semibold">สถานะบัญชี</h2><span className="text-sm text-text-muted">ทั้งหมด {data.total.toLocaleString('th-TH')} รายการ</span></div>
            <div className="overflow-x-auto rounded-lg border border-border-subtle">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="bg-surface-2">
                  <tr>
                    <th scope="col" className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">ผู้ให้บริการ</th>
                    <th scope="col" className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">ทั้งหมด</th>
                    <th scope="col" className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">ส่งข้อความแล้ว</th>
                    <th scope="col" className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">หมดอายุ / เชื่อมใหม่</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map(p => (
                    <tr key={p.id} className="border-t border-border-subtle transition-colors hover:bg-surface-2/60">
                      <th scope="row" className="p-4 font-medium">
                        <Link className="group flex items-center gap-2.5 text-primary hover:underline" href={`/dashboard/providers/${p.id}`}>
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-500/12 text-xs font-bold text-primary" aria-hidden="true">{p.name.charAt(0).toUpperCase()}</span>
                          {p.name}
                        </Link>
                      </th>
                      <td className="p-4 tabular-nums text-text-main">{p.total.toLocaleString('th-TH')}</td>
                      <td className="p-4"><Chip tone="success">{p.ready.toLocaleString('th-TH')}</Chip></td>
                      <td className="p-4">{p.expired ? <Chip tone="warning">{p.expired.toLocaleString('th-TH')}</Chip> : <span className="text-text-subtle">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-6 text-text-muted">“ส่งข้อความแล้ว” มีหลักฐานคำตอบสำเร็จและ token ยังไม่หมดอายุ การนำเข้าหรือผ่านตรวจสิทธิ์เพียงอย่างเดียวยังไม่ถือว่าพร้อมส่งข้อความ</p>
          </div>
          <aside className="card-soft border border-border p-5 self-start">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[18px] leading-none text-primary">shield</span>
              <h2 className="text-base font-semibold tracking-tight text-text-main">รายการที่ต้องดูแล</h2>
            </div>
            <dl className="mt-4 space-y-3">
              {orderedCounts.map(([name, count]) => (
                <div key={name} className={`flex items-center justify-between gap-4 border-b border-border-subtle pb-2.5 text-sm ${count === 0 ? 'opacity-45' : ''}`}>
                  <dt className="min-w-0">
                    <Chip tone={statusTone[name] || 'neutral'}>{statusLabels[name] || name}</Chip>
                  </dt>
                  <dd className="font-medium tabular-nums text-text-main">{count.toLocaleString('th-TH')}</dd>
                </div>
              ))}
            </dl>
            <Link href="/dashboard/providers" className="mt-5 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">จัดการบัญชีและเชื่อมใหม่ <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden="true">arrow_forward</span></Link>
          </aside>
        </section>
        <section aria-labelledby="profiles-title" className="border-t border-border pt-7">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="profiles-title" className="text-xl font-semibold">โปรไฟล์โมเดล</h2><p className="mt-2 text-sm text-text-muted">ใช้ชื่อเดียวในโปรแกรมของคุณ และกำหนดเพดานคำตอบให้เหมาะกับงาน</p></div><button disabled={!!busy} onClick={() => action('profiles')} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'profiles' ? 'กำลังเพิ่ม…' : 'เพิ่มโปรไฟล์ที่แนะนำ'}</button></div>
          <div className="mt-5 grid gap-4 md:grid-cols-3">{data.profiles.map(p => <article key={p.name} className="card-soft flex flex-col border border-border p-4 transition-shadow duration-200 hover:shadow-[var(--shadow-elevated)]"><div><h3 className="font-medium">{p.label}</h3><code className="text-xs text-primary">{p.name}</code></div><div className="text-xs leading-6 text-text-muted">{p.targets.map((t, i) => <span key={t} className="block">{i === 0 ? 'หลัก: ' : 'สำรอง: '}{t}</span>)}</div><p className="text-xs leading-6 text-text-muted">คำตอบสูงสุด {p.maxOutputTokens.toLocaleString('th-TH')} โทเคน<br />{p.installed ? <Chip tone="success">เพิ่มแล้ว</Chip> : <Chip>ยังไม่ได้เพิ่ม</Chip>}</p></article>)}</div>
          <p className="mt-3 text-xs leading-6 text-text-muted">โปรไฟล์เขียนโค้ดและถามทั่วไปอนุญาตให้ส่งคำขอไป CrowLLM เมื่อ Grok ใช้ไม่ได้ แก้ลำดับบริการได้ที่ <Link className="text-primary hover:underline" href="/dashboard/combos">หน้าโปรไฟล์และการสำรองโมเดล</Link></p>
        </section>
        <section aria-labelledby="backup-title" className="grid gap-8 border-t border-border pt-7 lg:grid-cols-[1.6fr_1fr]">
          <div><div className="flex flex-wrap items-center justify-between gap-4"><h2 id="backup-title" className="text-xl font-semibold">สำรองและตรวจการกู้คืน</h2><button disabled={!!busy} onClick={() => action('backup')} className="rounded-lg border border-primary px-4 py-2 text-sm text-primary disabled:opacity-50">{busy === 'backup' ? 'กำลังสำรอง…' : 'สำรองตอนนี้และตรวจสำเนา'}</button></div><label className="mt-4 flex items-center gap-3 text-sm"><input type="checkbox" checked={data.backupEnabled} disabled={!!busy} onChange={e => action('backupEnabled', { enabled: e.target.checked })} />สำรองในเครื่องทุก 24 ชั่วโมงขณะที่แอปทำงาน</label><ul className="mt-5 divide-y divide-border">{data.backups.length ? data.backups.map(b => <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm">{new Date(b.createdAt).toLocaleString('th-TH')}</p><p className="mt-1 text-xs text-text-muted">เข้ารหัส · {(b.bytes / 1048576).toFixed(1)} MB</p></div><button disabled={!!busy} onClick={() => action('verify', { id: b.id })} className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">ตรวจสำเนากู้คืน</button></li>) : <li className="py-4 text-sm text-text-muted">ยังไม่มีสำเนาแบบเข้ารหัส</li>}</ul><p className="mt-3 text-xs leading-6 text-text-muted">การตรวจสำเนาถอดรหัสและเปิดฐานข้อมูลในพื้นที่ทดสอบ ไม่เขียนทับข้อมูลที่กำลังใช้ ไม่มีการลบสำเนาเก่าอัตโนมัติ</p></div>
          <aside className="card-soft border border-border p-5 self-start"><h2 className="text-lg font-semibold">การปกป้องข้อมูล</h2><p className="mt-3 text-sm leading-7 text-text-muted">Token ของผู้ให้บริการถูกเข้ารหัสด้วย AES-256-GCM กุญแจบน Windows ปกป้องด้วย {data.vault.keyProtection} และผูกกับบัญชี Windows นี้</p><p className="mt-3 text-xs leading-6 text-text-muted">การย้ายไปบัญชี Windows อื่นต้องเตรียมการย้าย credentials เพิ่มเติม ไฟล์นำเข้าและสำเนาเก่าที่สร้างก่อนอัปเกรดไม่ได้ถูกย้ายหรือลบ</p><div className="mt-5 border-t border-border pt-4 text-xs text-text-muted">Node.js {data.runtime.node}<br />Next.js {data.runtime.next}<br /><code>{data.runtime.baseUrl}/v1</code></div></aside>
        </section>
        </div>
      )}
    </main>
  );
}
