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

const externalPkgs = ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open", "wreq-js"];

// The tracing keys and `serverComponentsExternalPackages` have different homes
// depending on the installed framework major: Next 14 keeps them under
// `experimental`, Next 15/16 moved them to the top level and renamed the
// packages key. Declaring the wrong spelling makes the config validator warn
// and silently drops the tracing block.
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
const legacyConfig = detectNextMajor() > 0 && detectNextMajor() <= 14;

const tracingExcludes = {
  "*": [
    "./gitbook/**/*",
    "**/AppData/Local/**/*",
    "**/AppData/Roaming/**/*",
    "**/.config/**/*",
    "**/.codex/**/*",
    "**/Cookies/**/*",
    // Windows local builds: npm keeps its cache under the user profile, and the
    // legacy "Application Data" folder points at itself — the file tracer walks
    // that junction forever (EPERM scandir) and the heap climbs until the build
    // dies with "Ineffective mark-compacts near heap limit". Keep every profile
    // junction, the npm cache and any previous build dir out of the trace graph.
    "**/Application Data/**/*",
    "**/Local Settings/**/*",
    "**/My Documents/**/*",
    "**/NetHood/**/*",
    "**/PrintHood/**/*",
    "**/Recent/**/*",
    "**/SendTo/**/*",
    "**/Start Menu/**/*",
    "**/Templates/**/*",
    "**/Temporary Internet Files/**/*",
    "**/npm-cache/**/*",
    "**/node_modules/.cache/**/*",
    "**/.turbo/**/*",
  ],
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Security: don't advertise the framework (pentest info finding).
  compress: true,
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // Top-level keys for Next.js 15 / 16
  outputFileTracingRoot: tracingRoot,
  outputFileTracingExcludes: tracingExcludes,
  serverExternalPackages: externalPkgs,
  turbopack: {
    root: tracingRoot
  },
  images: {
    unoptimized: true
  },
  // Source maps are the second-largest memory consumer in a production webpack
  // pass, and the standalone output never ships them. Keeping them off keeps the
  // heap flatter on constrained runners.
  productionBrowserSourceMaps: false,
  env: stampBuild(),
  experimental: {
    // Next 14 spells this key `experimental.serverComponentsExternalPackages`;
    // Next 15 moved it to the top level as `serverExternalPackages` (declared
    // above), and Next 16 rejects the old spelling outright — even `undefined`
    // trips the validator, because the key itself must be absent from the object.
    // Declaring it on Next 16+ therefore makes the validator warn and silently
    // drops the whole tracing block from the resolved config, which is how the
    // file tracer ends up walking a Windows user profile into the legacy
    // "Application Data" junction loop (EPERM scandir) instead of staying inside
    // the repo. Only Next 14 gets the legacy key.
    ...(legacyConfig ? { serverComponentsExternalPackages: externalPkgs } : {}),
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
    // --- Build memory ceiling -------------------------------------------------
    // The build dies on "Ineffective mark-compacts near heap limit" on a
    // consumer Windows machine. Raising --max-old-space-size does not help: the
    // run already reached 8 GB and failed there, so the ceiling is not the
    // problem — the peak is. These two settings lower the peak instead.
    //
    // `webpackMemoryOptimizations` trades a little build time for a much
    // flatter memory curve by dropping the caches webpack keeps between
    // invalidation passes, which is exactly the retention that walks the heap
    // up. Set NEXT_DISABLE_MEMORY_OPTIMIZATIONS=1 to get the old behaviour back
    // when diagnosing an unrelated build failure.
    ...(process.env.NEXT_DISABLE_MEMORY_OPTIMIZATIONS === "1" ? {} : { webpackMemoryOptimizations: true }),
    // Run the compilation in a separate worker so the framework's own overhead
    // is not stacked on the same heap the bundler is saturating.
    webpackBuildWorker: true,
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
