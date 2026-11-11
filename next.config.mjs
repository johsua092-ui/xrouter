import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// Stamp the build with the revision and the release it was made from. A deploy
// that ships without .git history still knows what it is, so the update banner can
// compare it against the repository instead of staying silent forever.
function stampBuild() {
  const stamp = {};
  try {
    stamp.APP_REVISION = process.env.APP_REVISION
      || execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // Built outside a checkout: the release heading is the only anchor left.
  }
  try {
    const changelog = readFileSync(join(projectRoot, "CHANGELOG.md"), "utf8");
    const heading = changelog.match(/^#\s+(v[0-9][^\s(]*)/m);
    if (heading) stamp.APP_RELEASE = process.env.APP_RELEASE || heading[1].trim();
  } catch {
    stamp.APP_RELEASE = process.env.APP_RELEASE || "v0.0.1";
  }
  return stamp;
}
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;
const proxyClientMaxBodySize = process.env.NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE || "128mb";

// Next 14 keeps the tracing keys under `experimental`; Next 15 moved them to the top level and
// renamed `serverComponentsExternalPackages` to `serverExternalPackages`. Declaring both sets at
// once makes the older framework warn and — the part that actually hurts — silently ignore the
// tracing keys, which is how the file tracer ends up walking a Windows user profile into the
// legacy "Application Data" junction loop (EPERM scandir) instead of staying inside the repo.
function detectNextMajor() {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "node_modules", "next", "package.json"), "utf8"));
    const major = Number(String(pkg.version).split(".")[0]);
    return Number.isFinite(major) ? major : 0;
  } catch {
    // Next not installed yet (fresh checkout before `npm install`): assume the modern layout.
    return 0;
  }
}
const nextMajor = detectNextMajor();
const legacyConfig = nextMajor > 0 && nextMajor <= 14;

const externalPkgs = ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open", "wreq-js"];
const tracingExcludes = {
  "*": [
    "./gitbook/**/*",
    "**/AppData/Local/**/*",
    "**/AppData/Roaming/**/*",
    "**/.config/**/*",
    "**/.codex/**/*",
    "**/Cookies/**/*",
  ],
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Security: don't advertise the framework (pentest info finding).
  compress: true,
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // Tracing, externals and the bundler root, written in the dialect of the framework that is
  // actually installed: top level on Next 15+, under `experimental` on Next 14 (where the
  // top-level names do not exist at all).
  ...(legacyConfig
    ? {}
    : {
        outputFileTracingRoot: tracingRoot,
        outputFileTracingExcludes: tracingExcludes,
        serverExternalPackages: externalPkgs,
        turbopack: {
          root: tracingRoot
        },
      }),
  images: {
    unoptimized: true
  },
  env: stampBuild(),
  experimental: {
    ...(legacyConfig
      ? {
          outputFileTracingRoot: tracingRoot,
          outputFileTracingExcludes: tracingExcludes,
          serverComponentsExternalPackages: externalPkgs,
        }
      : {
          // Next 15+ knows these under their new names only; the old `experimental.`
          // spellings moved out and are rejected by the config validator.
          // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
          proxyClientMaxBodySize,
          // Cache fetch responses across HMR refreshes for faster dev reloads.
          serverComponentsHmrCache: true,
        }),
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
  },
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    // Defense in depth: bun:sqlite is never used on Node 22 runners, and the
    // runtime import is already guarded + dynamic — keep it out of the bundle.
    if (isServer) {
      config.externals = config.externals || [];
      if (!config.externals.includes("bun:sqlite")) config.externals.push("bun:sqlite");
      if (!config.externals.includes("wreq-js")) config.externals.push("wreq-js");
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, private" }],
      },
      {
        source: "/dashboard/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" }],
      },
      {
        source: "/dashboard",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" }],
      },
      {
        source: "/login",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" }],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/v1/models/:path*",
        destination: "/api/v1/models/:path*"
      },
      {
        source: "/v1/models",
        destination: "/api/v1/models"
      },
      {
        source: "/models/:path*",
        destination: "/api/v1/models/:path*"
      },
      {
        source: "/models",
        destination: "/api/v1/models"
      },
      {
        source: "/model/:path*",
        destination: "/api/v1/models/:path*"
      },
      {
        source: "/model",
        destination: "/api/v1/models"
      },
      {
        source: "/v1/model/:path*",
        destination: "/api/v1/models/:path*"
      },
      {
        source: "/v1/model",
        destination: "/api/v1/models"
      },
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/systemone",
        destination: "/api/v1/systemone"
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*"
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
