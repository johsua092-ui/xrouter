import { Bot, InlineKeyboard } from "grammy";
import { run } from "@grammyjs/runner";
import { getConnectionConfig, setConnectionConfig } from "../../lib/db/repos/connectionRepo.js";
import { getProviderConnections, getProxyPools, getSettings, deleteProxyPools } from "../../lib/db/index.js";
import { APP_CONFIG } from "../constants/config.js";

const g = (global.__telegramBotRunner ??= {
  bot: null,
  runner: null,
  running: false,
  botInfo: null,
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function getMainMenuKeyboard() {
  const keyboard = new InlineKeyboard()
    .text("📊 Status & Metrics", "menu_status")
    .text("🔌 Provider AI", "menu_providers")
    .row()
    .text("🌐 Proxy Pools", "menu_pools")
    .text("🧹 Prune Dead", "menu_prune")
    .row()
    .text("🏓 Ping Gateway", "menu_ping")
    .text("🔄 Refresh Menu", "menu_refresh");
  return keyboard;
}

export async function getMainCaption(user) {
  const [connections, pools] = await Promise.all([
    getProviderConnections().catch(() => []),
    getProxyPools().catch(() => []),
  ]);
  const activeConns = connections.filter((c) => c.isActive !== false);
  const livePools = pools.filter((p) => p.isActive !== false && p.testStatus !== "error");
  const deadPools = pools.filter((p) => p.testStatus === "error");

  const username = user?.username ? `@${user.username}` : (user?.first_name || "Admin");
  const uptime = formatUptime(process.uptime());
  const memoryMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

  return (
    `<blockquote>⚡ <b>X ROUTER CONTROLLER</b>\n` +
    `v${APP_CONFIG.version || "0.0.1"} · Telegram Control Panel</blockquote>\n\n` +
    `╭──〔 TELEMETRI SISTEM 〕─\n` +
    `• <b>User:</b> ${username} (<code>${user?.id || "-"}</code>)\n` +
    `• <b>Role:</b> Superadmin\n` +
    `• <b>Status:</b> 🟢 Online\n` +
    `• <b>Uptime:</b> ${uptime}\n` +
    `• <b>Memory:</b> ${memoryMb} MB RSS\n` +
    `• <b>Active Conns:</b> ${activeConns.length} / ${connections.length}\n` +
    `• <b>Proxy Pools:</b> ${livePools.length} Live (${deadPools.length} Dead)\n` +
    `╰────────────────────────╯\n\n` +
    `<blockquote>Silakan pilih menu kontrol di bawah ini:</blockquote>`
  );
}

export function getBackKeyboard() {
  return new InlineKeyboard().text("« Kembali ke Menu Utama", "menu_main");
}

async function renderStatusView() {
  const [connections, pools, settings] = await Promise.all([
    getProviderConnections().catch(() => []),
    getProxyPools().catch(() => []),
    getSettings().catch(() => ({})),
  ]);

  const activeConns = connections.filter((c) => c.isActive !== false);
  const livePools = pools.filter((p) => p.isActive !== false && p.testStatus !== "error");
  const deadPools = pools.filter((p) => p.testStatus === "error");
  const memoryMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

  return (
    `📊 <b>X Router System Telemetry</b>\n\n` +
    `• <b>Version:</b> <code>v${APP_CONFIG.version || "0.0.1"}</code>\n` +
    `• <b>Uptime:</b> ${formatUptime(process.uptime())}\n` +
    `• <b>Memory RSS:</b> ${memoryMb} MB\n` +
    `• <b>Active Connections:</b> ${activeConns.length} / ${connections.length}\n` +
    `• <b>Proxy Pools:</b> ${livePools.length} Live (${deadPools.length} Dead)\n` +
    `• <b>Cache Affinity:</b> ${settings.cacheAffinityEnabled !== false ? "🟢 ON" : "⚪ OFF"}\n` +
    `• <b>Model Bypass:</b> ${settings.kernelEnabled ? "🟢 ON" : "⚪ OFF"}`
  );
}

async function renderProvidersView() {
  const connections = await getProviderConnections().catch(() => []);
  if (connections.length === 0) {
    return "ℹ️ <i>Tidak ada provider connection yang terdaftar di X Router.</i>";
  }

  const byProvider = {};
  for (const c of connections) {
    byProvider[c.provider] = byProvider[c.provider] || { active: 0, total: 0 };
    byProvider[c.provider].total++;
    if (c.isActive !== false) byProvider[c.provider].active++;
  }

  const lines = Object.entries(byProvider).map(
    ([p, counts]) => `• <b>${p}:</b> <code>${counts.active}/${counts.total}</code> active`
  );

  return `🔌 <b>Active Provider Matrix</b>\n\n${lines.join("\n")}`;
}

async function renderPoolsView() {
  const pools = await getProxyPools().catch(() => []);
  const live = pools.filter((p) => p.isActive !== false && p.testStatus !== "error");
  const dead = pools.filter((p) => p.testStatus === "error");

  return (
    `🌐 <b>Proxy Pool Status</b>\n\n` +
    `• <b>Total Proxies:</b> ${pools.length}\n` +
    `• <b>Live Proxies:</b> ${live.length}\n` +
    `• <b>Dead / Failed:</b> ${dead.length}\n\n` +
    `<i>Gunakan tombol Prune di bawah untuk membersihkan proxy mati.</i>`
  );
}

async function executePrune() {
  const [pools, connections] = await Promise.all([
    getProxyPools(),
    getProviderConnections(),
  ]);

  const boundIds = new Set(
    connections.map((c) => c?.providerSpecificData?.proxyPoolId).filter(Boolean)
  );

  const deadPools = pools.filter(
    (p) => !boundIds.has(p.id) && (p.testStatus === "error" || p.isActive === false)
  );

  if (deadPools.length === 0) {
    return "✅ <b>Pool Bersih!</b>\nTidak ada proxy mati yang perlu di-prune.";
  }

  const deadIds = deadPools.map((p) => p.id);
  const removed = await deleteProxyPools(deadIds);

  return `🧹 <b>Pruning Selesai!</b>\nBerhasil menghapus <b>${removed.length}</b> proxy mati dari pool.`;
}

export function stopTelegramBot() {
  if (g.runner && g.runner.isRunning()) {
    try {
      g.runner.stop();
    } catch {}
  }
  g.bot = null;
  g.runner = null;
  g.running = false;
  g.botInfo = null;
  console.log("[TelegramBot] Service stopped.");
}

export async function configureTelegramBot() {
  try {
    const config = await getConnectionConfig();
    const tg = config?.telegram || {};

    if (!tg.enabled || !tg.botToken) {
      if (g.running) {
        stopTelegramBot();
      }
      return { success: true, running: false, status: "disabled" };
    }

    // Stop current instance if token changed or already running
    if (g.running) {
      stopTelegramBot();
    }

    const bot = new Bot(tg.botToken);

    // Verify token
    const me = await bot.api.getMe();
    g.botInfo = me;

    // Security check middleware
    bot.use(async (ctx, next) => {
      const fromId = ctx.from?.id;
      const configuredId = String(tg.userId || "").trim();

      if (configuredId && String(fromId) !== configuredId) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: "⛔ Akses Ditolak: User ID tidak terotorisasi!",
            show_alert: true,
          }).catch(() => {});
        } else {
          await ctx.reply(
            "⛔ <b>Akses Ditolak</b>\nAnda tidak memiliki otorisasi untuk mengontrol X Router ini.",
            { parse_mode: "HTML" }
          ).catch(() => {});
        }
        return;
      }

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery().catch(() => {});
      }

      return next();
    });

    // /start command
    bot.command(["start", "menu"], async (ctx) => {
      const caption = await getMainCaption(ctx.from);
      const keyboard = getMainMenuKeyboard();
      await ctx.reply(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    });

    // Callback queries (In-place edit)
    bot.callbackQuery("menu_main", async (ctx) => {
      const caption = await getMainCaption(ctx.from);
      const keyboard = getMainMenuKeyboard();
      await ctx.editMessageText(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() => {});
    });

    bot.callbackQuery("menu_refresh", async (ctx) => {
      const caption = await getMainCaption(ctx.from);
      const keyboard = getMainMenuKeyboard();
      await ctx.editMessageText(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() => {});
    });

    bot.callbackQuery("menu_status", async (ctx) => {
      const text = await renderStatusView();
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      }).catch(() => {});
    });

    bot.callbackQuery("menu_providers", async (ctx) => {
      const text = await renderProvidersView();
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      }).catch(() => {});
    });

    bot.callbackQuery("menu_pools", async (ctx) => {
      const text = await renderPoolsView();
      const keyboard = new InlineKeyboard()
        .text("🧹 Prune Dead Now", "menu_prune")
        .row()
        .text("« Kembali ke Menu Utama", "menu_main");
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() => {});
    });

    bot.callbackQuery("menu_prune", async (ctx) => {
      const text = await executePrune();
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      }).catch(() => {});
    });

    bot.callbackQuery("menu_ping", async (ctx) => {
      const text = `🏓 <b>Pong!</b>\nGateway responsif (Uptime: <code>${formatUptime(process.uptime())}</code>)`;
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: getBackKeyboard(),
      }).catch(() => {});
    });

    // Register /start command menu in Telegram client
    bot.api.setMyCommands([{ command: "start", description: "Buka Menu Utama" }]).catch(() => {});

    // Delete webhook if set previously, so getUpdates polling works cleanly
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

    const runner = run(bot);
    g.bot = bot;
    g.runner = runner;
    g.running = true;

    console.log(`[TelegramBot] Bot @${me.username} running in Long Polling mode!`);

    await setConnectionConfig({
      telegram: {
        botInfo: { id: me.id, username: me.username, first_name: me.first_name },
        status: "connected",
        lastTestedAt: new Date().toISOString(),
        lastError: null,
      },
    }).catch(() => {});

    return {
      success: true,
      running: true,
      botInfo: me,
    };
  } catch (err) {
    console.error("[TelegramBot] Error configuring bot:", err);
    await setConnectionConfig({
      telegram: {
        status: "error",
        lastError: err.message,
      },
    }).catch(() => {});
    return { success: false, error: err.message };
  }
}

export function getTelegramBotState() {
  return {
    running: g.running,
    botInfo: g.botInfo,
  };
}
