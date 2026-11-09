import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

const VERCEL_API = "https://api.vercel.com";

// Relay function source code deployed to Vercel
// Forwards requests to target URL specified in x-relay-target header
const RELAY_FUNCTION_CODE = `
export const config = { runtime: "edge" };

export default async function handler(req) {
  const target = req.headers.get("x-relay-target");
  const relayPath = req.headers.get("x-relay-path") || "/";
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const targetUrl = target.replace(/\\/$/, "") + relayPath;

  const rawHeaders = {};
  for (const [k, v] of req.headers.entries()) rawHeaders[k] = v;
  delete rawHeaders["x-relay-target"];
  delete rawHeaders["x-relay-path"];
  delete rawHeaders["host"];

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: rawHeaders,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    duplex: "half",
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
`;

async function pollDeployment(deploymentId, token, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.readyState === "READY") return data;
    if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
      throw new Error(`Deployment failed: ${data.readyState}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Deployment timed out");
}

// POST /api/proxy-pools/vercel-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const vercelToken = body.vercelToken;
    const baseProjectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;
    const relayCount = Math.max(1, Math.min(Number(body.count) || 1, 23)); // Up to 23 multi-relays like OhMyRouter

    if (!vercelToken) {
      return NextResponse.json({ error: "Vercel API token is required" }, { status: 400 });
    }

    const deployedRelays = [];

    for (let i = 0; i < relayCount; i++) {
      const projectName = relayCount > 1 ? `${baseProjectName}-${i + 1}` : baseProjectName;

      // Deploy relay function to Vercel
      const deployRes = await fetch(`${VERCEL_API}/v13/deployments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: projectName,
          files: [
            {
              file: "api/relay.js",
              data: RELAY_FUNCTION_CODE,
            },
            {
              file: "package.json",
              data: JSON.stringify({ name: projectName, version: "1.0.0" }),
            },
            {
              file: "vercel.json",
              data: JSON.stringify({
                rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
              }),
            },
          ],
          projectSettings: {
            framework: null,
          },
          target: "production",
        }),
      });

      if (!deployRes.ok) {
        if (deployedRelays.length === 0) {
          const err = await deployRes.json().catch(() => ({}));
          return NextResponse.json(
            { error: err.error?.message || "Failed to create Vercel deployment" },
            { status: deployRes.status }
          );
        }
        break; // Stop deploying further if rate limited
      }

      const deployment = await deployRes.json();
      const deploymentId = deployment.id || deployment.uid;

      // Disable deployment protection (Vercel Authentication)
      const projectId = deployment.projectId || projectName;
      await fetch(`${VERCEL_API}/v9/projects/${projectId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ssoProtection: null }),
      });

      // Poll until deployment is ready
      const ready = await pollDeployment(deploymentId, vercelToken);
      const deployUrl = `https://${ready.url}`;

      // Create proxy pool entry with type vercel
      const proxyPool = await createProxyPool({
        name: `Vercel Relay ${relayCount > 1 ? `#${i + 1}` : projectName}`,
        type: "vercel",
        proxyUrl: deployUrl,
        provider: "all",
        isActive: true,
      });

      deployedRelays.push({ proxyPool, deployUrl });
    }

    return NextResponse.json({
      success: true,
      count: deployedRelays.length,
      relays: deployedRelays,
      deployUrl: deployedRelays[0]?.deployUrl,
      proxyPool: deployedRelays[0]?.proxyPool,
    }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Vercel relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
