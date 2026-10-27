import { AntigravityExecutor } from "./antigravity.js";
import { AzureExecutor } from "./azure.js";
import { GeminiCLIExecutor } from "./gemini-cli.js";
import { GithubExecutor } from "./github.js";
import { IFlowExecutor } from "./iflow.js";
import { QoderExecutor } from "./qoder.js";
import { KiroExecutor } from "./kiro.js";
import { KimchiExecutor } from "./kimchi.js";
import { CodexExecutor } from "./codex.js";
import { CursorExecutor } from "./cursor.js";
import { VertexExecutor } from "./vertex.js";
import { OpenCodeExecutor } from "./opencode.js";
import { OpenCodeGoExecutor } from "./opencode-go.js";
import { OpenCodeZenExecutor } from "./opencode-zen.js";
import { GrokCliExecutor } from "./grok-cli.js";
import { DeepSeekWebExecutor } from "./deepseek-web.js";
import { ArenaAIExecutor } from "./arena-ai.js";
import { GeminiWebExecutor } from "./gemini-web.js";
import { KimiWebExecutor } from "./kimi-web.js";
import { OllamaLocalExecutor } from "./ollama-local.js";
import { CommandCodeExecutor } from "./commandcode.js";
import { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.js";
import { XiaomiMimoExecutor } from "./xiaomi-mimo.js";
import { CodeBuddyExecutor } from "./codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
import TraeExecutor from "./trae.js";
import ZedExecutor from "./zed.js";
import WindsurfExecutor from "./windsurf.js";
import { DefaultExecutor } from "./default.js";
import { DevinCliExecutor } from "./devin-cli.js";
import { MinimaxCodeExecutor } from "./minimax-code.js";
import { KiloGatewayExecutor } from "./kilo-gateway.js";
import { OpenSatanExecutor } from "./opensatan.js";
import { AdcodeExecutor } from "./adcode.js";
import { PteroExecutor } from "./ptero.js";

const executors = {
  antigravity: new AntigravityExecutor(),
  azure: new AzureExecutor(),
  "gemini-cli": new GeminiCLIExecutor(),
  github: new GithubExecutor(),
  iflow: new IFlowExecutor(),
  qoder: new QoderExecutor(),
  "qoder-cn": new QoderExecutor("qoder-cn"),
  "minimax-code": new MinimaxCodeExecutor("minimax-code"),
  "minimax-code-global": new MinimaxCodeExecutor("minimax-code-global"),
  kiro: new KiroExecutor(),
  kimchi: new KimchiExecutor(),
  codex: new CodexExecutor(),
  cursor: new CursorExecutor(),
  cu: new CursorExecutor(), // Alias for cursor
  vertex: new VertexExecutor("vertex"),
  "vertex-partner": new VertexExecutor("vertex-partner"),
  opencode: new OpenCodeExecutor(),
  "opencode-go": new OpenCodeGoExecutor(),
  "opencode-zen": new OpenCodeZenExecutor(),
  "grok-cli": new GrokCliExecutor(),
  gcli: new GrokCliExecutor(), // Alias
  gb: new GrokCliExecutor(), // Alias (Grok Build)
  "deepseek-web": new DeepSeekWebExecutor(),
  dsw: new DeepSeekWebExecutor(),
  "deepseek-cookie": new DeepSeekWebExecutor(),
  "kilo-gateway": new KiloGatewayExecutor(),
  kilogateway: new KiloGatewayExecutor(),
  kgw: new KiloGatewayExecutor(),
  "arena-ai": new ArenaAIExecutor(),
  arena: new ArenaAIExecutor(),
  lmsys: new ArenaAIExecutor(),
  "arena-web": new ArenaAIExecutor(),
  "gemini-web": new GeminiWebExecutor(),
  gweb: new GeminiWebExecutor(),
  "gemini-cookie": new GeminiWebExecutor(),
  "kimi-web": new KimiWebExecutor(),
  kweb: new KimiWebExecutor(),
  "kimi-cookie": new KimiWebExecutor(),
  "ollama-local": new OllamaLocalExecutor(),
  commandcode: new CommandCodeExecutor(),
  "xiaomi-tokenplan": new XiaomiTokenplanExecutor(),
  "xiaomi-mimo": new XiaomiMimoExecutor(),
  "codebuddy-cn": new CodeBuddyExecutor(),
  "codebuddy-intl": new CodeBuddyIntlExecutor(),
  trae: new TraeExecutor(),
  zed: new ZedExecutor(),
  windsurf: new WindsurfExecutor(),
  "devin-cli": new DevinCliExecutor(),
  opensatan: new OpenSatanExecutor(),
  satan: new OpenSatanExecutor(),
  adcode: new AdcodeExecutor(),
  adc: new AdcodeExecutor(),
  ptero: new PteroExecutor(),
};

const defaultCache = new Map();

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}

export { BaseExecutor } from "./base.js";
export { AntigravityExecutor } from "./antigravity.js";
export { AzureExecutor } from "./azure.js";
export { GeminiCLIExecutor } from "./gemini-cli.js";
export { GithubExecutor } from "./github.js";
export { IFlowExecutor } from "./iflow.js";
export { QoderExecutor } from "./qoder.js";
export { KiroExecutor } from "./kiro.js";
export { KimchiExecutor } from "./kimchi.js";
export { CodexExecutor } from "./codex.js";
export { CursorExecutor } from "./cursor.js";
export { VertexExecutor } from "./vertex.js";
export { DefaultExecutor } from "./default.js";
export { ArenaAIExecutor } from "./arena-ai.js";
export { OpenCodeExecutor } from "./opencode.js";
export { OpenCodeGoExecutor } from "./opencode-go.js";
export { OpenCodeZenExecutor } from "./opencode-zen.js";
export { GrokCliExecutor } from "./grok-cli.js";
export { OllamaLocalExecutor } from "./ollama-local.js";
export { CommandCodeExecutor } from "./commandcode.js";
export { XiaomiTokenplanExecutor } from "./xiaomi-tokenplan.js";
export { XiaomiMimoExecutor } from "./xiaomi-mimo.js";
export { CodeBuddyExecutor } from "./codebuddy-cn.js";
export { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
export { default as TraeExecutor } from "./trae.js";
export { default as ZedExecutor } from "./zed.js";
export { default as WindsurfExecutor } from "./windsurf.js";
export { DevinCliExecutor } from "./devin-cli.js";
export { OpenSatanExecutor } from "./opensatan.js";
export { AdcodeExecutor } from "./adcode.js";
export { PteroExecutor } from "./ptero.js";
