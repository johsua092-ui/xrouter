export function accountAttemptLimit(value) {
  const requested = Number(value);
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 10) : 3;
}

export function connectionHealth(connection, inferenceVerified = false, now = Date.now()) {
  const c = connection || {};
  const state = c.credentialHealth?.state;
  if (state === 'reauth_required') return { state, label: 'ต้องเชื่อมบัญชีใหม่', reason: 'refresh_token_rejected' };
  if (c.isActive === false) return { state: 'paused', label: 'พักการใช้งาน' };
  if (Number(c.errorCode) === 402) return { state: 'quota_exhausted', label: 'โควตาหมด' };
  if (c.authType === 'oauth' && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) <= now) return { state: 'expired', label: 'Token หมดอายุ' };
  if (c.testStatus === 'error' || c.testStatus === 'unavailable') return { state: 'error', label: 'ตรวจพบปัญหา' };
  if (inferenceVerified) return { state: 'ready', label: 'ส่งข้อความสำเร็จแล้ว' };
  if (c.testStatus === 'active' && c.authType !== 'oauth') return { state: 'credentials_valid', label: 'ผ่านตรวจสิทธิ์แล้ว' };
  return { state: 'unverified', label: 'รอทดสอบส่งข้อความ' };
}
