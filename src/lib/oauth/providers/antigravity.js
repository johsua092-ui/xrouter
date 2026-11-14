import crypto from "crypto";
import { ANTIGRAVITY_CONFIG, getOAuthClientMetadata } from "../constants/oauth.js";

const antigravity = {
  config: ANTIGRAVITY_CONFIG,
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    const loadHeaders = {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": ANTIGRAVITY_CONFIG.loadCodeAssistUserAgent,
      "Client-Metadata": JSON.stringify({
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      }),
      "x-request-source": "local",
    };
    const metadata = getOAuthClientMetadata();

    // Fetch user info
    const userInfoRes = await fetch(`${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "x-request-source": "local",
      },
    });
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

    // Load Code Assist to get project ID and tier
    let projectId = "";
    let tierId = "";
    try {
      const loadRes = await fetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify({ metadata }),
      });
      if (loadRes.ok) {
        const data = await loadRes.json();
        projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        if (Array.isArray(data.allowedTiers)) {
          for (const tier of data.allowedTiers) {
            if (tier.isDefault && tier.id) {
              tierId = tier.id.trim();
              break;
            }
          }
        }
      }
    } catch (e) {
      console.log("Failed to load code assist:", e);
    }

    // The provisioned tier must survive the exchange: downstream chat requests
    // and the Claude 5.5 entitlement probe read it from the stored connection,
    // and a paid account onboarded here must not be re-onboarded as free-tier.
    const resolvedTierId = tierId || "free-tier";

    // Auto-Onboard: if account is new or has no project, trigger onboardUser polling
    // to provision cloudaicompanionProject from Google automatically (Haizhu flow)
    if (!projectId) {
      try {
        const onboardPayload = {
          tierId: resolvedTierId,
          metadata: {
            ideType: "ANTIGRAVITY",
            ideName: "antigravity",
            ideVersion: ANTIGRAVITY_CONFIG.ideVersion || "2.32.1",
            ...metadata,
          },
        };
        for (let i = 0; i < 6; i++) {
          const onboardRes = await fetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
            method: "POST",
            headers: loadHeaders,
            body: JSON.stringify(onboardPayload),
          });
          if (onboardRes.ok) {
            const result = await onboardRes.json();
            const foundPid = result.cloudaicompanionProject?.id || result.cloudaicompanionProject || result.response?.cloudaicompanionProject?.id || result.response?.cloudaicompanionProject;
            if (foundPid) {
              projectId = typeof foundPid === "string" ? foundPid.trim() : foundPid.id?.trim();
              if (projectId) break;
            }
            if (result.done === true) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Re-check loadCodeAssist now that Google server has processed onboarding
        if (!projectId) {
          const reloadRes = await fetch(ANTIGRAVITY_CONFIG.loadCodeAssistEndpoint, {
            method: "POST",
            headers: loadHeaders,
            body: JSON.stringify({ metadata }),
          });
          if (reloadRes.ok) {
            const reloadData = await reloadRes.json();
            projectId = reloadData.cloudaicompanionProject?.id || reloadData.cloudaicompanionProject || "";
          }
        }
      } catch (err) {
        console.warn("Auto-onboarding new Antigravity account failed on Google server:", err?.message || err);
      }
    } else {
      // Account already has a project: still post the onboard call once so Google
      // records the same tier we resolved above (it also keeps onboarding healthy).
      const doOnboard = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            const onboardRes = await fetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
              method: "POST",
              headers: loadHeaders,
              body: JSON.stringify({ tierId: resolvedTierId, metadata }),
            });
            if (onboardRes.ok) {
              const result = await onboardRes.json();
              if (result.done === true) break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      };
      doOnboard().catch(() => {});
    }

    return { userInfo, projectId, tierId: resolvedTierId };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
    // Both objects the desktop client keeps per account. Persisting the tier lets
    // a fresh account work straight from the dashboard — no desktop sign-in, no
    // re-onboarding as free-tier on the first chat request.
    providerSpecificData: {
      projectId: extra?.projectId || undefined,
      tierId: extra?.tierId || "free-tier",
    },
  }),
};

export default antigravity;
