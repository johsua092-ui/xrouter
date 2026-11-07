'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

const statusLabels = { ready: 'ส่งข้อความสำเร็จแล้ว', credentials_valid: 'ผ่านตรวจสิทธิ์', expired: 'Token หมดอายุ', reauth_required: 'ต้องเชื่อมใหม่', quota_exhausted: 'โควตาหมด', paused: 'พักไว้', error: 'ตรวจพบปัญหา', unverified: 'รอทดสอบ' };

export default function OperationsDashboard() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { const response = await fetch('/api/maintenance', { cache: 'no-store' }); if (!response.ok) throw new Error(); setData(await response.json()); setError(''); }
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
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 p-5 md:p-8" lang="th">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div><h1 className="text-3xl font-semibold tracking-tight text-text-main">ศูนย์ควบคุม X Router</h1><p className="mt-2 max-w-2xl text-sm leading-7 text-text-muted">ดูบัญชีที่ใช้งานได้จริง เลือกโปรไฟล์โมเดล และดูแลข้อมูลในเครื่องจากหน้านี้</p></div>
        <button className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary" onClick={refresh}>อัปเดตสถานะ</button>
      </header>
      {error && <p role="alert" className="rounded-lg border border-danger/30 p-4 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-success/30 p-4 text-sm text-success">{notice}</p>}
      {!data ? <p aria-live="polite" className="text-text-muted">กำลังตรวจสถานะระบบ…</p> : <>
        <section aria-labelledby="accounts-title" className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <div>
            <div className="mb-4 flex items-baseline justify-between gap-3"><h2 id="accounts-title" className="text-xl font-semibold">สถานะบัญชี</h2><span className="text-sm text-text-muted">ทั้งหมด {data.total.toLocaleString('th-TH')} รายการ</span></div>
            <div className="overflow-x-auto rounded-xl border border-border"><table className="w-full min-w-[480px] text-left text-sm"><thead className="bg-surface-2 text-text-muted"><tr><th className="p-4 font-medium">ผู้ให้บริการ</th><th className="p-4 font-medium">ทั้งหมด</th><th className="p-4 font-medium">ส่งข้อความแล้ว</th><th className="p-4 font-medium">หมดอายุ / เชื่อมใหม่</th></tr></thead><tbody>{data.providers.map(p => <tr key={p.id} className="border-t border-border"><th className="p-4 font-medium"><Link className="text-primary hover:underline" href={`/dashboard/providers/${p.id}`}>{p.name}</Link></th><td className="p-4 tabular-nums">{p.total.toLocaleString('th-TH')}</td><td className="p-4 tabular-nums text-success">{p.ready}</td><td className="p-4 tabular-nums">{p.expired}</td></tr>)}</tbody></table></div>
            <p className="mt-3 text-xs leading-6 text-text-muted">“ส่งข้อความแล้ว” มีหลักฐานคำตอบสำเร็จและ token ยังไม่หมดอายุ การนำเข้าหรือผ่านตรวจสิทธิ์เพียงอย่างเดียวยังไม่ถือว่าพร้อมส่งข้อความ</p>
          </div>
          <aside className="rounded-xl bg-surface-2 p-5"><h2 className="text-lg font-semibold">รายการที่ต้องดูแล</h2><dl className="mt-4 space-y-3">{Object.entries(data.counts).map(([name, count]) => <div key={name} className="flex justify-between gap-4 border-b border-border pb-2 text-sm"><dt className="text-text-muted">{statusLabels[name] || name}</dt><dd className="font-medium tabular-nums">{count.toLocaleString('th-TH')}</dd></div>)}</dl><Link href="/dashboard/providers" className="mt-5 inline-block text-sm text-primary hover:underline">จัดการบัญชีและเชื่อมใหม่</Link></aside>
        </section>
        <section aria-labelledby="profiles-title" className="border-t border-border pt-7">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="profiles-title" className="text-xl font-semibold">โปรไฟล์โมเดล</h2><p className="mt-2 text-sm text-text-muted">ใช้ชื่อเดียวในโปรแกรมของคุณ และกำหนดเพดานคำตอบให้เหมาะกับงาน</p></div><button disabled={!!busy} onClick={() => action('profiles')} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'profiles' ? 'กำลังเพิ่ม…' : 'เพิ่มโปรไฟล์ที่แนะนำ'}</button></div>
          <div className="mt-5 divide-y divide-border rounded-xl border border-border">{data.profiles.map(p => <article key={p.name} className="grid gap-2 p-4 md:grid-cols-[160px_1fr_auto]"><div><h3 className="font-medium">{p.label}</h3><code className="text-xs text-primary">{p.name}</code></div><div className="text-xs leading-6 text-text-muted">{p.targets.map((t, i) => <span key={t} className="block">{i === 0 ? 'หลัก: ' : 'สำรอง: '}{t}</span>)}</div><p className="text-xs leading-6 text-text-muted">คำตอบสูงสุด {p.maxOutputTokens.toLocaleString('th-TH')} โทเคน<br />{p.installed ? 'เพิ่มแล้ว' : 'ยังไม่ได้เพิ่ม'}</p></article>)}</div>
          <p className="mt-3 text-xs leading-6 text-text-muted">โปรไฟล์เขียนโค้ดและถามทั่วไปอนุญาตให้ส่งคำขอไป CrowLLM เมื่อ Grok ใช้ไม่ได้ แก้ลำดับบริการได้ที่ <Link className="text-primary hover:underline" href="/dashboard/combos">หน้าโปรไฟล์และการสำรองโมเดล</Link></p>
        </section>
        <section aria-labelledby="backup-title" className="grid gap-8 border-t border-border pt-7 lg:grid-cols-[1.6fr_1fr]">
          <div><div className="flex flex-wrap items-center justify-between gap-4"><h2 id="backup-title" className="text-xl font-semibold">สำรองและตรวจการกู้คืน</h2><button disabled={!!busy} onClick={() => action('backup')} className="rounded-lg border border-primary px-4 py-2 text-sm text-primary disabled:opacity-50">{busy === 'backup' ? 'กำลังสำรอง…' : 'สำรองตอนนี้และตรวจสำเนา'}</button></div><label className="mt-4 flex items-center gap-3 text-sm"><input type="checkbox" checked={data.backupEnabled} disabled={!!busy} onChange={e => action('backupEnabled', { enabled: e.target.checked })} />สำรองในเครื่องทุก 24 ชั่วโมงขณะที่แอปทำงาน</label><ul className="mt-5 divide-y divide-border">{data.backups.length ? data.backups.map(b => <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm">{new Date(b.createdAt).toLocaleString('th-TH')}</p><p className="mt-1 text-xs text-text-muted">เข้ารหัส · {(b.bytes / 1048576).toFixed(1)} MB</p></div><button disabled={!!busy} onClick={() => action('verify', { id: b.id })} className="rounded-md border border-border px-3 py-2 text-xs disabled:opacity-50">ตรวจสำเนากู้คืน</button></li>) : <li className="py-4 text-sm text-text-muted">ยังไม่มีสำเนาแบบเข้ารหัส</li>}</ul><p className="mt-3 text-xs leading-6 text-text-muted">การตรวจสำเนาถอดรหัสและเปิดฐานข้อมูลในพื้นที่ทดสอบ ไม่เขียนทับข้อมูลที่กำลังใช้ ไม่มีการลบสำเนาเก่าอัตโนมัติ</p></div>
          <aside className="rounded-xl bg-surface-2 p-5"><h2 className="text-lg font-semibold">การปกป้องข้อมูล</h2><p className="mt-3 text-sm leading-7 text-text-muted">Token ของผู้ให้บริการถูกเข้ารหัสด้วย AES-256-GCM กุญแจบน Windows ปกป้องด้วย {data.vault.keyProtection} และผูกกับบัญชี Windows นี้</p><p className="mt-3 text-xs leading-6 text-text-muted">การย้ายไปบัญชี Windows อื่นต้องเตรียมการย้าย credentials เพิ่มเติม ไฟล์นำเข้าและสำเนาเก่าที่สร้างก่อนอัปเกรดไม่ได้ถูกย้ายหรือลบ</p><div className="mt-5 border-t border-border pt-4 text-xs text-text-muted">Node.js {data.runtime.node}<br />Next.js {data.runtime.next}<br /><code>{data.runtime.baseUrl}/v1</code></div></aside>
        </section>
      </>}
    </main>
  );
}
