import { describe, it } from "node:test";
import assert from "node:assert/strict";

function parseProxyLine(line) {
  let trimmed = line.trim();
  if (!trimmed) return null;

  // Handle user:pass@host:port without protocol scheme
  if (trimmed.includes("@") && !trimmed.includes("://")) {
    trimmed = `http://${trimmed}`;
  }

  if (trimmed.includes("://")) {
    const parsed = new URL(trimmed);
    const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return {
      proxyUrl: parsed.toString(),
      name: `Imported ${hostLabel}`,
    };
  }

  const parts = trimmed.split(":");
  // host:port (2 parts)
  if (parts.length === 2) {
    const [host, port] = parts;
    if (host && port && /^\d+$/.test(port)) {
      return {
        proxyUrl: `http://${host}:${port}`,
        name: `Imported ${host}:${port}`,
      };
    }
  }

  // 4 parts: host:port:user:pass OR user:pass:host:port
  if (parts.length === 4) {
    let host, port, username, password;
    if (/^\d+$/.test(parts[1])) {
      [host, port, username, password] = parts;
    } else if (/^\d+$/.test(parts[3])) {
      [username, password, host, port] = parts;
    } else {
      [host, port, username, password] = parts;
    }

    if (!host || !port || !username || !password) {
      throw new Error("Invalid host:port:user:pass format");
    }

    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    const parsed = new URL(proxyUrl);
    return {
      proxyUrl: parsed.toString(),
      name: `Imported ${host}:${port}`,
    };
  }

  if (parts.length === 3) {
    throw new Error("Missing port number (format: host:port:user:pass or user:pass@host:port)");
  }

  throw new Error("Unsupported format");
}

describe("parseProxyLine support for various proxy formats", () => {
  it("parses user:pass@host:port without protocol scheme (ProxyScrape export)", () => {
    const res = parseProxyLine("wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129");
    assert.ok(res);
    assert.equal(res.proxyUrl, "http://wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129/");
    assert.equal(res.name, "Imported 216.26.250.91:3129");
  });

  it("parses host:port:user:pass (colon separated)", () => {
    const res = parseProxyLine("216.26.250.91:3129:wvggulifqp8h:lathxcrza7xqdlz");
    assert.ok(res);
    assert.equal(res.proxyUrl, "http://wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129/");
    assert.equal(res.name, "Imported 216.26.250.91:3129");
  });

  it("parses user:pass:host:port (inverted colon separated)", () => {
    const res = parseProxyLine("wvggulifqp8h:lathxcrza7xqdlz:216.26.250.91:3129");
    assert.ok(res);
    assert.equal(res.proxyUrl, "http://wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129/");
    assert.equal(res.name, "Imported 216.26.250.91:3129");
  });

  it("parses host:port (unauthenticated IP-whitelist)", () => {
    const res = parseProxyLine("216.26.250.91:3129");
    assert.ok(res);
    assert.equal(res.proxyUrl, "http://216.26.250.91:3129");
    assert.equal(res.name, "Imported 216.26.250.91:3129");
  });

  it("parses full URL with protocol scheme", () => {
    const res = parseProxyLine("http://wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129");
    assert.ok(res);
    assert.equal(res.proxyUrl, "http://wvggulifqp8h:lathxcrza7xqdlz@216.26.250.91:3129/");
  });

  it("throws clear error when port is missing (3 parts)", () => {
    assert.throws(
      () => parseProxyLine("216.26.250.91:wvggulifqp8h:lathxcrza7xqdlz"),
      /Missing port number/
    );
  });
});
