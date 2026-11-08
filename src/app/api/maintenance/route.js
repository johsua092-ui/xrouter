import { NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/auth/dashboardPermissions';
import { getProviderConnections, getProviderNodes, getCombos, createCombo, getComboByName, getSettings, updateSettings } from '@/lib/localDb';
import { getAdapter } from '@/lib/db/driver';
import { connectionHealth } from '@/lib/security/connectionHealth';
import { listLocalBackups, createLocalBackup, verifyLocalBackup } from '@/lib/security/localBackups';
import { PROFILE_PRESETS } from '@/lib/security/modelProfiles';
import { existsSync } from 'node:fs';
import { vaultKeyPath } from '@/lib/security/credentialVault';

export const dynamic = 'force-dynamic';
async function admin() { const context = await getSessionContext(); return context.session?.role === 'admin'; }

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  const [connections, nodes, combos, settings, db] = await Promise.all([getProviderConnections(), getProviderNodes(), getCombos(), getSettings(), getAdapter()]);
  const successes = new Set(db.all("SELECT DISTINCT connectionId FROM usageHistory WHERE status IN ('ok','200','200 OK')").map(r => r.connectionId));
  const counts = {};
  const providers = new Map();
  for (const connection of connections) {
    const health = connectionHealth(connection, successes.has(connection.id));
    counts[health.state] = (counts[health.state] || 0) + 1;
    if (!providers.has(connection.provider)) providers.set(connection.provider, { id: connection.provider, name: nodes.find(n => n.id === connection.provider)?.name || connection.provider, total: 0, ready: 0, expired: 0, paused: 0 });
    const provider = providers.get(connection.provider); provider.total++;
    if (health.state === 'ready') provider.ready++;
    if (['expired', 'reauth_required'].includes(health.state)) provider.expired++;
    if (health.state === 'paused') provider.paused++;
  }
  return NextResponse.json({ total: connections.length, counts, providers: [...providers.values()], backups: listLocalBackups().slice(0, 10), backupEnabled: settings.localBackupEnabled !== false, vault: { enabled: true, keyProtection: process.platform === 'win32' ? 'Windows DPAPI' : 'Environment key', initialized: existsSync(vaultKeyPath()) || !!process.env.CREDENTIAL_VAULT_KEY }, profiles: PROFILE_PRESETS.map(p => ({ ...p, installed: combos.some(c => c.name === p.name) })), runtime: { node: process.versions.node, next: '16', mode: 'production', baseUrl: process.env.BASE_URL || 'http://127.0.0.1:20128' } }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  if (!(await admin())) return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  try {
    const body = await request.json();
    if (body.action === 'backup') {
      const result = await createLocalBackup(); const verified = await verifyLocalBackup(result.id);
      return NextResponse.json({ success: true, backup: { id: result.id }, verification: verified });
    }
    if (body.action === 'verify') return NextResponse.json({ success: true, verification: await verifyLocalBackup(body.id) });
    if (body.action === 'backupEnabled' && typeof body.enabled === 'boolean') { await updateSettings({ localBackupEnabled: body.enabled }); return NextResponse.json({ success: true }); }
    if (body.action === 'profiles') {
      const [connections, nodes, settings] = await Promise.all([getProviderConnections(), getProviderNodes(), getSettings()]);
      const grok = connections.some(c => c.provider === 'grok-cli' && c.isActive && Date.parse(c.expiresAt) > Date.now());
      const crow = nodes.find(n => n.prefix === 'crowllm');
      const crowEnabled = crow && connections.some(c => c.provider === crow.id && c.isActive && c.testStatus === 'active');
      const installed = []; const skipped = []; const budgets = { ...(settings.profileBudgets || {}) };
      for (const preset of PROFILE_PRESETS) {
        if (await getComboByName(preset.name)) { skipped.push(preset.name); continue; }
        const models = preset.targets.filter(m => m.startsWith('gcli/') ? grok : crowEnabled);
        if (!models.length) { skipped.push(preset.name); continue; }
        await createCombo({ name: preset.name, kind: 'llm', models });
        budgets[preset.name] = { maxOutputTokens: preset.maxOutputTokens };
        installed.push(preset.name);
      }
      await updateSettings({ profileBudgets: budgets });
      return NextResponse.json({ success: true, installed, skipped });
    }
    return NextResponse.json({ error: 'Invalid maintenance action' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'ดำเนินการไม่สำเร็จ กรุณาตรวจการสำรองและกุญแจเข้ารหัสในเครื่อง' }, { status: 400 });
  }
}
