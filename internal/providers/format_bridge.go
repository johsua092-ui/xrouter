package providers

import "github.com/johsua092-ui/xrouter/internal/translate"

// Wire dialects an adapter can speak. Declared here rather than inferred from the
// adapter's type because a provider's dialect is a property of its upstream API,
// not of which Go struct happens to implement it — and the gateway needs to ask
// before it knows the concrete type.
const (
	// FormatOpenAI is the chat-completions dialect. Most providers speak it.
	FormatOpenAI = "openai"
	// FormatClaude is the Anthropic Messages dialect.
	FormatClaude = "claude"
	// FormatGemini is the generateContent dialect.
	FormatGemini = "gemini"
	// FormatKiro is the Amazon Q EventStream dialect. It does not round-trip
	// through OpenAI, so the gateway must never pivot a request through the
	// OpenAI leg on the way to it.
	FormatKiro = "kiro"
	// FormatResponses is the OpenAI Responses API dialect.
	FormatResponses = "openai-responses"
)

// Dialect is implemented by adapters whose upstream is not OpenAI-compatible.
//
// It is a separate interface rather than a fourth Adapter method so that the ~30
// wire-compatible adapters do not each need a stub returning the default. Absence
// means OpenAI, which is the correct answer for all of them.
type Dialect interface {
	WireFormat() string
}

// RegistryFormat reports the dialect an adapter speaks.
//
// Adapters that do not implement Dialect are OpenAI-compatible by construction —
// they are built from the descriptor table, which only describes OpenAI-shaped
// upstreams. The specials (grok-cli, antigravity, qoder) declare their own.
func RegistryFormat(a Adapter) translate.Format {
	if a == nil {
		return translate.FormatOpenAI
	}

	wire := FormatOpenAI
	if d, ok := a.(Dialect); ok {
		if declared := d.WireFormat(); declared != "" {
			wire = declared
		}
	}

	switch wire {
	case FormatClaude:
		return translate.FormatClaude
	case FormatGemini:
		return translate.FormatGemini
	case FormatKiro:
		return translate.FormatKiro
	case FormatResponses:
		return translate.FormatOpenAIResponses
	default:
		return translate.FormatOpenAI
	}
}
