# Makefile — Go migration branch
#
# Go targets only. The Node/Next.js build keeps its own npm scripts; nothing here
# touches the running service or port 20128.

GO          ?= go
GOBIN       ?= bin
BINARY      ?= $(GOBIN)/xrouter
GOFLAGS     ?= -trimpath
LDFLAGS     ?= -s -w
GO_PORT     ?= 28080

# ./internal/... catches the Go *toolchain's own* internal packages (the SDK ships
# its source tree under GOROOT and the pattern fans out into it). Scope the test
# target to this module's packages only, or `go test` walks the toolchain and
# spends half a minute on internal/trace.
#
# ./... also sweeps up Dockerfile.go (it sits at the repo root), which is a shell
# heredoc, not Go source. Hence the explicit package list.
GO_PKGS     := ./cmd/... ./internal/...

.PHONY: help go-build go-size go-vet go-test go-verify go-run go-cross go-clean

help:
	@echo "go-build   build the Go binary"
	@echo "go-size    build, then print the binary size in MB"
	@echo "go-vet     run go vet over the Go packages"
	@echo "go-test    run go test over the Go packages"
	@echo "go-verify  build + vet + test + size (use this before any commit)"
	@echo "go-run     run the Go binary on port $(GO_PORT) (leaves 20128 alone)"
	@echo "go-cross   compile linux/darwin/windows x64+arm64 into $(GOBIN)/"
	@echo "go-clean   remove $(GOBIN)/"

go-build:
	@mkdir -p $(GOBIN)
	$(GO) build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(BINARY) ./cmd/xrouter

go-size: go-build
	@ls -l $(BINARY) | awk '{ printf "  binary: %s  size: %.2f MB (%d bytes)\n", $$9, $$5/1048576, $$5 }'

go-vet:
	$(GO) vet $(GO_PKGS)

go-test:
	$(GO) test $(GO_PKGS) 2>&1 | tail -25

go-verify: go-build go-vet go-test go-size
	@echo "  go-verify complete"

go-run: go-build
	@echo "  starting $(BINARY) on :$(GO_PORT) (Node dashboard on 20128 is untouched)"
	PORT=$(GO_PORT) $(BINARY)

go-cross:
	@mkdir -p $(GOBIN)
	@for os in linux darwin windows; do \
		for arch in amd64 arm64; do \
			ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
			out="$(GOBIN)/xrouter-$$os-$$arch$$ext"; \
			echo "  building $$out"; \
			GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 \
				$(GO) build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $$out ./cmd/xrouter || exit 1; \
		done; \
	done
	@ls -l $(GOBIN)/ | awk 'NR>1 { printf "  %-34s %.2f MB\n", $$9, $$5/1048576 }'

go-clean:
	@rm -rf $(GOBIN)
	@echo "  cleaned $(GOBIN)/"
