// Resolve hook so the catalog generator can import the app's modules outside
// Next.js. The app uses two bare-specifier aliases that only exist in the
// Next/jsconfig config (`open-sse/*` and `@/*`); Node has no idea what they
// mean, so this maps them onto the real files before resolution.
//
// Registered by scripts/gen-catalog.mjs via module.register().

import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

function mapSpecifier(specifier) {
  if (specifier.startsWith("open-sse/")) {
    return pathToFileURL(resolvePath(root, specifier)).href;
  }
  if (specifier.startsWith("@/")) {
    return pathToFileURL(resolvePath(root, "src", specifier.slice(2))).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const mapped = mapSpecifier(specifier);
  if (mapped) {
    return nextResolve(mapped, context);
  }
  return nextResolve(specifier, context);
}
