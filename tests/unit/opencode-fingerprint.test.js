import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));

describe("opencodeFingerprint — request side", () => {
  it("renames capitalised quartet members to lowercase", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    const names = body.tools.map((tool) => tool.name);

    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(names).toContain("Edit");
    expect(map.get("bash")).toBe("Bash");
  });

  it("removes quartet case duplicates without dropping unrelated case variants", () => {
    const body = { tools: flat(["Bash", "bash", "Glob", "grep", "Read", "Foo", "foo"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "bash")).toHaveLength(1);
    expect(names).toContain("Foo");
    expect(names).toContain("foo");
  });

  it("preserves tool count when a complete quartet is only renamed", () => {
    const body = { tools: flat(CC_TOOLS) };
    applyFingerprintTools(body, true);
    expect(body.tools).toHaveLength(CC_TOOLS.length);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(CC_TOOLS) };
    applyFingerprintTools(body, false);

    const names = body.tools.map((tool) => tool.function.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(body.tools[1].function.name).toBe("bash");
  });

  it("injects all four fingerprint tools when the body carries no tools", () => {
    const body = { tools: [] };
    applyFingerprintTools(body, true);

    expect(body.tools.map((tool) => tool.name).sort()).toEqual([...OPENCODE_FINGERPRINT_TOOLS].sort());
    expect(body.tool_choice).toBe("auto");
  });

  it("preserves the chat no-tool default tool_choice=none", () => {
    const body = {};
    applyFingerprintTools(body, false);

    expect(body.tools.map((tool) => tool.function.name).sort()).toEqual([...OPENCODE_FINGERPRINT_TOOLS].sort());
    expect(body.tool_choice).toBe("none");
  });

  it("does not invent a chat tool_choice when the caller already supplied tools", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);
    expect(body.tool_choice).toBeUndefined();
  });

  it("appends only genuinely missing quartet members", () => {
    const body = { tools: flat(["Bash", "Read", "terminal"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("terminal");
    expect(body.tools).toHaveLength(5);
  });

  it("aliases ReportFindings, the common member of the upstream pair gates (#5690)", () => {
    // Upstream 429s the pairs ReportFindings+ScheduleWakeup and
    // ReportFindings+DeferredToolPlaceholder; single members pass. Concealing
    // ReportFindings on every request clears both pairs for Claude Code,
    // which ships all three names at once.
    const body = { tools: chat(["ReportFindings", "ScheduleWakeup", "DeferredToolPlaceholder"]) };
    const map = applyFingerprintTools(body, false);
    const sent = body.tools.map((t) => t.function.name);
    expect(sent.some((name) => /reportfindings/i.test(name))).toBe(false);
    expect(map.get("run_command")).toBe("ReportFindings");
    expect(sent).toContain("ScheduleWakeup");
    expect(sent).toContain("DeferredToolPlaceholder");
  });

  it("aliases exec_command, the common member of the Codex pair gate", () => {
    // Upstream 429s the pair exec_command+write_stdin in <400 ms; single
    // members pass. Codex CLI ships both on every request, so concealing
    // exec_command clears the pair while write_stdin stays visible.
    const body = { tools: chat(["exec_command", "write_stdin"]) };
    const map = applyFingerprintTools(body, false);
    const sent = body.tools.map((t) => t.function.name);
    expect(sent.some((name) => /exec_command/i.test(name))).toBe(false);
    expect(map.get("run_command")).toBe("exec_command");
    expect(sent).toContain("write_stdin");
  });

  it("retargets flat tool_choice that points at a renamed tool", () => {
    const body = { tools: flat(CC_TOOLS), tool_choice: { type: "function", name: "Bash" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("bash");
  });

  it("retargets nested tool_choice that points at a renamed tool", () => {
    const body = {
      tools: chat(CC_TOOLS),
      tool_choice: { type: "function", function: { name: "Read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("aliases Claude Code name+schema fingerprints (fourth gate)", () => {
    const edit = { type: "function", function: { name: "Edit", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } } };
    const read = { type: "function", function: { name: "Read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" } } } } };
    const body = { tools: [edit, read] };
    const map = applyFingerprintTools(body, false);

    const sent = body.tools.map((t) => t.function.name);
    expect(sent).toContain("file_edit");
    expect(sent).toContain("file_read");
    expect(map.get("file_edit")).toBe("Edit");
    expect(map.get("file_read")).toBe("Read");
    const sentEdit = body.tools.find((t) => t.function?.name === "file_edit");
    expect(sentEdit.function.parameters.properties).toEqual(edit.function.parameters.properties);
  });

  it("does not gate near-miss name+schema combinations", () => {
    const body = {
      tools: [
        { type: "function", name: "read", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
        { type: "function", name: "Edit", description: "x", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
        { type: "function", name: "Read", description: "x", parameters: { type: "object", properties: { offset: { type: "integer" } }, required: [] } },
      ],
    };
    const map = applyFingerprintTools(body, true);
    const names = body.tools.map((t) => t.name);
    // The caller's read is fingerprint-mismatched (file_path vs OpenCode's
    // path/offset/limit), so it travels under an alias; the quartet members
    // that are still missing get appended after it.
    expect(names[0]).toBe("read_client");
    expect(map.get("read_client")).toBe("read");
    // Near-miss name+schema tools must NOT be concealed by the fourth gate:
    // lowercase "read" with file_path matches no GATED_NAME_SCHEMA_RULES alias
    // (the /Read$/ rule is case-sensitive and the /edit/i rule requires
    // old_string/new_string), and "Read" with offset-only is a near-miss.
    for (const n of names) {
      expect(n).not.toBe("file_edit");
      expect(n).not.toBe("file_read");
    }
    expect(names).toContain("Edit");
    expect(names).toContain("Read");
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("maps quartet case/whitespace variants and rejects other tools", () => {
    expect(fingerprintToolKey("Bash")).toBe("bash");
    expect(fingerprintToolKey(" bash ")).toBe("bash");
    expect(fingerprintToolKey("GLOB")).toBe("glob");
    expect(fingerprintToolKey("Read")).toBe("read");
    expect(fingerprintToolKey("Edit")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
