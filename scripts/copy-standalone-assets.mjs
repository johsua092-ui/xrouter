import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/* distDir resolution order: explicit arg → NEXT_DIST_DIR env → NEXT_DIST_DIR
   parsed from the project's .env (npm scripts do not load .env, so the
   postbuild hook would otherwise miss a dist dir pinned there) → ".next". */
function resolveDistDir({ projectRoot, distDir } = {}) {
  if (distDir) return distDir;
  if (process.env.NEXT_DIST_DIR) return process.env.NEXT_DIST_DIR;
  try {
    for (const line of readFileSync(resolve(projectRoot, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*NEXT_DIST_DIR\s*=\s*(.+?)\s*$/);
      if (match) {
        const value = match[1].replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  } catch {}
  return ".next";
}

export function copyStandaloneAssets(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const distDir = resolveDistDir({ projectRoot, distDir: options.distDir });
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  // Next 16 loads additional server modules dynamically (including the console
  // file logger); NFT tracing can omit them on Windows. Ship the package's
  // server runtime rather than producing a build that cannot start.
  const nextPackage = resolve(projectRoot, 'node_modules', 'next');
  if (existsSync(nextPackage)) {
    cpSync(nextPackage, resolve(standaloneDir, 'node_modules', 'next'), { recursive: true, force: true });
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  // Next.js standalone requires the entire server artifact directory (including app & pages)
  const serverSource = resolve(buildDir, "server");
  const serverDestination = resolve(standaloneDir, distDir, "server");
  if (existsSync(serverSource)) {
    cpSync(serverSource, serverDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied server build artifacts to ${serverDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // Ensure server.js in standalone exposes native require to global scope even if launched directly
  const standaloneServer = resolve(standaloneDir, "server.js");
  if (existsSync(standaloneServer)) {
    try {
      let serverCode = readFileSync(standaloneServer, "utf8");
      // Strip any previous hook cleanly
      serverCode = serverCode.replace(/^if \(typeof globalThis !== "undefined"\) \{[\s\S]*?\}\n\}\n/, "");
      serverCode = serverCode.replace(/^if \(typeof globalThis !== "undefined"\) \{[\s\S]*?\}\n/, "");
      const hook = `if (typeof globalThis !== "undefined") {\n  globalThis.__xrouter_native_require__ = require;\n  globalThis.__non_webpack_require__ = require;\n  try { globalThis.__xrouter_wreq__ = require("wreq-js"); } catch {}\n}\n`;
      writeFileSync(standaloneServer, hook + serverCode, "utf8");
      console.log(`[standalone-assets] Injected native require hook into ${standaloneServer}`);
    } catch {}
  }

  // Copy src/lib/mimoReverseProxy.js and src/lib/mimoLoginSession.js so Xiaomi MiMo login reverse proxy works in standalone
  const proxySrc = resolve(projectRoot, "src", "lib", "mimoReverseProxy.js");
  const proxyDest = resolve(standaloneDir, "src", "lib", "mimoReverseProxy.js");
  if (existsSync(proxySrc)) {
    cpSync(proxySrc, proxyDest, { force: true });
  }
  const mimoSrc = resolve(projectRoot, "src", "lib", "mimoLoginSession.js");
  const mimoDest = resolve(standaloneDir, "src", "lib", "mimoLoginSession.js");
  if (existsSync(mimoSrc)) {
    cpSync(mimoSrc, mimoDest, { force: true });
  }

  const guardSrc = resolve(projectRoot, "src", "dashboardGuard.js");
  const guardDest = resolve(standaloneDir, "src", "dashboardGuard.js");
  if (existsSync(guardSrc)) {
    cpSync(guardSrc, guardDest, { force: true });
  }

  // Copy wreq-js and @wreq-js native bindings so TLS fingerprint impersonation works in standalone mode
  const standaloneDirs = [standaloneDir];
  try {
    const pkgJson = resolve(projectRoot, "package.json");
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (pkg.name) {
        const nested = resolve(standaloneDir, pkg.name);
        if (existsSync(nested) && !standaloneDirs.includes(nested)) {
          standaloneDirs.push(nested);
        }
      }
    }
  } catch {}

  const wreqSrc = resolve(projectRoot, "node_modules", "wreq-js");
  const wreqBindingSrc = resolve(projectRoot, "node_modules", "@wreq-js");

  for (const targetDir of standaloneDirs) {
    const wreqDest = resolve(targetDir, "node_modules", "wreq-js");
    if (existsSync(wreqSrc)) {
      cpSync(wreqSrc, wreqDest, { recursive: true, force: true });
      console.log(`[standalone-assets] Copied wreq-js to ${wreqDest}`);
    }
    const wreqBindingDest = resolve(targetDir, "node_modules", "@wreq-js");
    if (existsSync(wreqBindingSrc)) {
      cpSync(wreqBindingSrc, wreqBindingDest, { recursive: true, force: true });
      console.log(`[standalone-assets] Copied @wreq-js to ${wreqBindingDest}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
