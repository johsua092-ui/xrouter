import { getProviderConnectionById } from "@/lib/db/index.js";

function sanitizeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET(request, { params }) {
  const { connectionId } = params;
  const connection = await getProviderConnectionById(connectionId);

  if (!connection) {
    return new Response(
      `<!DOCTYPE html><html><body style="background:#0b0f17;color:#fff;font-family:sans-serif;padding:40px;text-align:center;"><h2>Connection Not Found</h2><p>GLM connection ID is invalid or was removed.</p></body></html>`,
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const email = sanitizeHtml(connection.email || connection.name || "GLM Account");
  const zcodeJwtToken =
    connection.providerSpecificData?.zcodeJwtToken ||
    connection.providerSpecificData?.zaiBusinessToken ||
    "";
  const accessToken =
    connection.accessToken ||
    connection.apiKey ||
    connection.providerSpecificData?.zaiBusinessToken ||
    "";

  if (!zcodeJwtToken) {
    return new Response(
      `<!DOCTYPE html><html><body style="background:#0b0f17;color:#fff;font-family:sans-serif;padding:40px;text-align:center;"><h2>ZCode Token Missing</h2><p>Connection has no stored ZCode session token. Please re-authenticate via OAuth or add ZCode token.</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const jsSnippet = `javascript:(function(){localStorage.setItem('zcodejwttoken','${zcodeJwtToken}');localStorage.setItem('oauth:zai:access_token','${accessToken}');localStorage.setItem('oauth:active_provider','zai');location.href='https://zcode.z.ai/en/rewards?embedded=app&theme=zai-dark';})();`;

  const consoleSnippet = `localStorage.setItem('zcodejwttoken', '${zcodeJwtToken}');\nlocalStorage.setItem('oauth:zai:access_token', '${accessToken}');\nlocalStorage.setItem('oauth:active_provider', 'zai');\nlocation.reload();`;

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ZCode Web Claim Launcher - ${email}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0B0F17;
      color: #E2E8F0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .card {
      width: 100%;
      max-width: 520px;
      background: #151D2C;
      border: 1px solid #233045;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 3px 8px;
      background: rgba(59, 130, 246, 0.15);
      color: #60A5FA;
      border-radius: 6px;
      margin-bottom: 6px;
    }
    h1 {
      font-size: 18px;
      font-weight: 700;
      color: #F8FAFC;
    }
    .account {
      font-size: 13px;
      color: #94A3B8;
      margin-top: 2px;
      font-family: monospace;
    }
    .desc {
      font-size: 13px;
      color: #94A3B8;
      line-height: 1.5;
      margin-bottom: 20px;
      background: rgba(0,0,0,0.2);
      border-left: 3px solid #3B82F6;
      padding: 10px 12px;
      border-radius: 4px;
    }
    .step-box {
      background: #0F1622;
      border: 1px solid #233045;
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 14px;
    }
    .step-title {
      font-size: 13px;
      font-weight: 600;
      color: #CBD5E1;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .step-num {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #3B82F6;
      color: #FFF;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s ease;
      border: none;
    }
    .btn-primary {
      background: #2563EB;
      color: #FFF;
    }
    .btn-primary:hover {
      background: #1D4ED8;
    }
    .btn-secondary {
      background: #1E293B;
      color: #E2E8F0;
      border: 1px solid #334155;
      margin-top: 8px;
    }
    .btn-secondary:hover {
      background: #334155;
    }
    .code-preview {
      background: #070A0F;
      border: 1px solid #1E293B;
      border-radius: 6px;
      padding: 8px 10px;
      font-family: monospace;
      font-size: 11px;
      color: #94A3B8;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 8px 0;
      max-height: 70px;
    }
    .toast {
      font-size: 11px;
      color: #10B981;
      text-align: center;
      margin-top: 6px;
      height: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <span class="badge">ZCode Web Launcher</span>
        <h1>Klaim Voucher ZCode Langsung di Web</h1>
        <div class="account">${email}</div>
      </div>
    </div>

    <div class="desc">
      Aplikasi desktop ZCode dibangun di atas web Next.js. Kamu bisa membuka halaman reward dan klaim voucher 500M langsung di browser tanpa perlu install aplikasi Electron.
    </div>

    <!-- Step 1 -->
    <div class="step-box">
      <div class="step-title">
        <span class="step-num">1</span>
        <span>Buka Halaman Rewards ZCode</span>
      </div>
      <p style="font-size:12px;color:#94A3B8;margin-bottom:10px;">
        Klik tombol di bawah untuk membuka tab resmi ZCode Rewards:
      </p>
      <a href="https://zcode.z.ai/en/rewards?embedded=app&theme=zai-dark" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
        Buka ZCode Rewards Web
      </a>
    </div>

    <!-- Step 2 -->
    <div class="step-box">
      <div class="step-title">
        <span class="step-num">2</span>
        <span>Auto-Login Session Akun Kamu</span>
      </div>
      <p style="font-size:12px;color:#94A3B8;margin-bottom:8px;">
        Saat halaman ZCode di atas sudah terbuka di browser kamu, jalankan script auto-login ini sekali agar akun kamu langsung terotentikasi:
      </p>
      <button type="button" class="btn btn-secondary" onclick="copyJsSnippet()">
        Salin Script Auto-Login (Bookmarklet)
      </button>
      <button type="button" class="btn btn-secondary" onclick="copyConsoleSnippet()">
        Salin Script Console (F12)
      </button>
      <div class="code-preview" id="snippetPreview">${sanitizeHtml(consoleSnippet)}</div>
      <div class="toast" id="toastMsg"></div>
    </div>

    <div style="font-size:11px;color:#64748B;text-align:center;line-height:1.4;">
      Setelah login di tab ZCode, seluruh voucher & reward 500M akan langsung tampil dan bisa diklik Got It / Claim. Saldo otomatis masuk ke akun kamu.
    </div>
  </div>

  <script>
    const jsSnippet = ${JSON.stringify(jsSnippet)};
    const consoleSnippet = ${JSON.stringify(consoleSnippet)};

    function copyJsSnippet() {
      navigator.clipboard.writeText(jsSnippet).then(() => {
        showToast("Script Bookmarklet disalin! Paste di address bar tab ZCode.");
      }).catch(() => {
        fallbackCopy(jsSnippet);
      });
    }

    function copyConsoleSnippet() {
      navigator.clipboard.writeText(consoleSnippet).then(() => {
        showToast("Script Console disalin! Buka tab ZCode, tekan F12 -> Console -> Paste & Enter.");
      }).catch(() => {
        fallbackCopy(consoleSnippet);
      });
    }

    function showToast(msg) {
      const el = document.getElementById("toastMsg");
      el.textContent = msg;
      setTimeout(() => { el.textContent = ""; }, 4000);
    }

    function fallbackCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Berhasil disalin ke clipboard!");
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
