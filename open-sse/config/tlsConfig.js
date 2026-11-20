// TLS ECDH curve list shared by every outbound dispatcher.
// X25519 first keeps the DPI workaround for api.anthropic.com; P-256/P-384
// are appended because AWS OIDC (Kiro IdC / Builder ID sign-in and token
// refresh) resets an X25519-only handshake (#5613). NINEROUTER_TLS_ECDH_CURVE
// overrides the whole list.
export const TLS_ECDH_CURVE = process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519:prime256v1:secp384r1";
