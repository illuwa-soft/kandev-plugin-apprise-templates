.DEFAULT_GOAL := build

.PHONY: build run test test-backend test-recipes test-ui test-package-verifier \
	test-release-version typecheck-recipes audit-recipes check-format fmt vet \
	sdk-check package package-host package-file verify-package verify-package-host clean \
	test-native-snapshot typecheck-formatter development-sdk dev-test dev-package-host

# When you rename the plugin, update BIN and VERSION to match manifest.yaml's
# id and version (PKG_OUT is derived from them).
BIN := bin/kandev-plugin-apprise-templates
VERSION := 0.1.0
STAGE := .build/stage
PKG_OUT := $(notdir $(BIN))-$(VERSION).tar.gz

# Packaging-only input: a Kandev source checkout at .kandev-tooling-ref,
# with apps/backend AND pluginsdk present. SDK builds/tests use public modules.
# Override with an absolute backend path: make package KANDEV_TOOLING=/path/apps/backend
KANDEV_TOOLING ?= $(CURDIR)/.build/kandev-tooling/apps/backend

# Run after npm ci so both installed SDK records and the lockfile are checked.
sdk-check:
	go run github.com/kdlbs/kandev/pluginsdk/cmd/kandev-sdk-check@v0.1.0 --manifest manifest.yaml --frontend-sdk node_modules/@kdlbs/plugin-sdk
	$(MAKE) typecheck-formatter

typecheck-formatter:
	npm run typecheck:formatter

## Build the plugin binary for the host platform (development use). kandev
## itself always installs from `make package`/`package-host` output, not this.
build: sdk-check
	mkdir -p bin
	go build -o $(BIN) ./server/...

## Build + run. Mainly for -race / manual smoke checks: kandev normally spawns
## this binary itself via the go-plugin handshake, so a manually-started
## process has nothing to talk to on the other end.
run: build
	./$(BIN)

test: test-backend typecheck-recipes test-recipes test-ui test-package-verifier test-release-version test-native-snapshot

test-native-snapshot:
	node --test tests/native-snapshot.test.mjs tests/backup-set.test.mjs tests/capture-backup-set.test.mjs

test-backend:
	go test -trimpath ./server/... ./cmd/... ./recipes/source-control/server/...

test-recipes:
	npm run test:recipes

test-ui:
	npm run test:ui

test-package-verifier:
	sh scripts/test-verify-package.sh

test-release-version:
	sh scripts/test-verify-release-version.sh

typecheck-recipes:
	npm run typecheck:recipes

audit-recipes:
	npm audit --audit-level=high

fmt:
	gofmt -l server cmd recipes

check-format:
	@test -z "$$(gofmt -l server cmd recipes)" || { echo "gofmt needed:"; gofmt -l server cmd recipes; exit 1; }

vet:
	go vet ./server/... ./cmd/... ./recipes/source-control/server/...

## Cross-compile server/plugin-<goos>-<goarch>[.exe] for every platform in
## manifest.yaml's runtime.executables, stage manifest.yaml + ui/ alongside
## them, and pack the tree into $(PKG_OUT) with
## backend-owned cmd/plugin-pack from the pinned tooling checkout. Install the tarball via Settings > Plugins or curl -F package=@...
package: sdk-check
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o $(STAGE)/server/plugin-linux-amd64       ./server
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -o $(STAGE)/server/plugin-linux-arm64       ./server
	CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -o $(STAGE)/server/plugin-darwin-amd64      ./server
	CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -o $(STAGE)/server/plugin-darwin-arm64      ./server
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o $(STAGE)/server/plugin-windows-amd64.exe ./server
	cd "$(KANDEV_TOOLING)" && GOWORK=off go run ./cmd/plugin-pack -dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG_OUT)
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Package for the host platform only — faster local iteration than the full
## 5-platform `make package` (matches plugin-pack's -platform-only).
package-host: sdk-check
	$(MAKE) _package-host

_package-host:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server
	cd "$(KANDEV_TOOLING)" && GOWORK=off go run ./cmd/plugin-pack -dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG_OUT) -platform-only
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

# Explicit private development lane for the coordinated, unreleased Host API.
# Normal build/package/release paths retain the published SDK checks above.
development-sdk:
	node scripts/prepare-development-sdk.mjs "$(KANDEV_FORMATTER_SOURCE)"

dev-test: export GOWORK = $(CURDIR)/.build/development.go.work
dev-test: development-sdk
	$(MAKE) test
	GOWORK="$(CURDIR)/.build/development.go.work" go test -trimpath -race ./server/... ./cmd/... ./recipes/source-control/server/...
	node node_modules/typescript/bin/tsc --project .build/development.tsconfig.json --noEmit

dev-package-host: development-sdk
	GOWORK="$(CURDIR)/.build/development.go.work" $(MAKE) _package-host KANDEV_TOOLING="$(KANDEV_FORMATTER_SOURCE)/apps/backend"
	@set -eu; tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		sh scripts/verify-package.sh "$$tmp" host "$$(go env GOOS)-$$(go env GOARCH)"

## Build and validate the all-platform archive: plugin-pack checks the manifest;
## this additionally verifies checksums, expected binaries, and that opt-in
## recipe/development files did not leak into the generated starter package.
verify-package: package
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		sh scripts/verify-package.sh "$$tmp" full

## Faster equivalent for local/CI host-platform packaging.
verify-package-host: package-host
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		sh scripts/verify-package.sh "$$tmp" host "$$(go env GOOS)-$$(go env GOARCH)"

## Print the archive name without building it. Release automation uses this
## after it validates the manifest and Makefile versions.
package-file:
	@printf '%s\n' "$(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) $(notdir $(BIN))-*.tar.gz
