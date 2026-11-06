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
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_CONFIG.loadCodeAssistUserAgent,
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
    let tierId = "free-tier";
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

    // Auto-Onboard: if account is new or has no project, trigger onboardUser polling
    // to provision cloudaicompanionProject from Google automatically (Haizhu flow)
    if (!projectId) {
      try {
        const onboardPayload = {
          tierId: tierId || "free-tier",
          metadata: {
            ideType: "ANTIGRAVITY",
            ideName: "antigravity",
            ideVersion: "1.107.0",
            ...metadata,
          },
        };
        for (let i = 0; i < 8; i++) {
          const onboardRes = await fetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
            method: "POST",
            headers: loadHeaders,
            body: JSON.stringify(onboardPayload),
          });
          if (onboardRes.ok) {
            const result = await onboardRes.json();
            if (result.done === true) {
              const respProject = result.response?.cloudaicompanionProject;
              if (typeof respProject === "string") {
                projectId = respProject.trim();
              } else if (respProject?.id) {
                projectId = respProject.id.trim();
              }
              if (projectId) break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      } catch (err) {
        console.warn("Auto-onboarding new Antigravity account failed:", err?.message || err);
      }
      if (!projectId) {
        projectId = `cloudaicompanion-proj-${crypto.randomBytes(8).toString("hex")}`;
      }
    } else {
      // Background ping if already has project ID to keep onboarding healthy
      const doOnboard = async () => {
        for (let i = 0; i < 3; i++) {
          try {
            const onboardRes = await fetch(ANTIGRAVITY_CONFIG.onboardUserEndpoint, {
              method: "POST",
              headers: loadHeaders,
              body: JSON.stringify({ tierId, metadata }),
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

    return { userInfo, projectId };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
  }),
};

export default antigravity;
