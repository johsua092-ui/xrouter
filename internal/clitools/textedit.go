package clitools

// Line-based TOML/YAML surgery. These config files are hand-edited by the
// operator, so instead of re-serialising a parsed tree (which loses comments and
// ordering) every writer replaces only the managed block between markers.

import (
	"regexp"
	"strings"
)

const (
	blockStart = "# >>> xrouter managed — edits inside this block are overwritten"
	blockEnd   = "# <<< xrouter managed"
)

func mustRegexp(pattern string) *regexp.Regexp {
	return regexp.MustCompile(pattern)
}

// stripBlock removes a previously written managed block, if any.
func stripBlock(text string) string {
	start := strings.Index(text, blockStart)
	if start < 0 {
		return text
	}
	end := strings.Index(text[start:], blockEnd)
	if end < 0 {
		return text[:start]
	}
	end += start + len(blockEnd)
	// Swallow the newline that followed the closing marker.
	for end < len(text) && (text[end] == '\n' || text[end] == '\r') {
		end++
	}
	return text[:start] + text[end:]
}

// stripSection deletes a TOML table by header, e.g. "model_providers.xrouter".
func stripSection(text, header string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	skipping := false
	pattern := regexp.MustCompile(`^\s*\[\s*` + regexp.QuoteMeta(header) + `\s*\]\s*$`)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if pattern.MatchString(line) {
			skipping = true
			continue
		}
		if skipping {
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				skipping = false
			} else {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

// setTopLevelScalar replaces `key = ...` at the top of a TOML file (before the
// first table header), or inserts it there when missing.
func setTopLevelScalar(text, key, value string) string {
	lines := strings.Split(text, "\n")
	assignment := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	insertAt := 0
	for index, line := range lines {
		if assignment.MatchString(line) {
			lines[index] = key + " = " + value
			return strings.Join(lines, "\n")
		}
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		if strings.TrimSpace(line) != "" && !strings.HasPrefix(strings.TrimSpace(line), "#") {
			insertAt = index + 1
		}
	}
	lines = append(lines[:insertAt], append([]string{key + " = " + value}, lines[insertAt:]...)...)
	return strings.Join(lines, "\n")
}

// dropTopLevelScalar removes `key = ...` lines above the first table header.
func dropTopLevelScalar(text, key string) string {
	lines := strings.Split(text, "\n")
	assignment := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			out = append(out, lines[len(out):]...)
			break
		}
		if assignment.MatchString(line) {
			continue
		}
		out = append(out, line)
	}
	if len(out) < len(lines) {
		// Header section was appended verbatim above; nothing left to do.
		return strings.Join(out, "\n")
	}
	return strings.Join(out, "\n")
}

// tomlQuote renders a TOML basic string.
func tomlQuote(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `"` + escaped + `"`
}

// writeBlock appends (or replaces) the managed block.
func writeBlock(text string, body []string) string {
	clean := strings.TrimRight(stripBlock(text), "\n")
	if clean != "" {
		clean += "\n\n"
	}
	return clean + blockStart + "\n" + strings.Join(body, "\n") + "\n" + blockEnd + "\n"
}

// yamlIndentBlock writes a nested YAML mapping under a managed marker pair.
func yamlBlock(lines []string) []string {
	return lines
}

func containsLine(text, needle string) bool {
	return strings.Contains(text, needle)
}
