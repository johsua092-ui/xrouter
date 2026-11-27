// Resolves the app's jsconfig path aliases for unit tests, so a test can import a real
// module instead of asserting on its source text.
const repoRoot = new URL("../../../", import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    return next(new URL(`src/${specifier.slice(2)}`, repoRoot).href, context);
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    return next(new URL(specifier, repoRoot).href, context);
  }
  return next(specifier, context);
}
