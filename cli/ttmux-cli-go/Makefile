BIN := ttmux-go
PKG := ./cmd/ttmux-cli-go
VERSION := $(shell sed -n 's/.*Version = "\(.*\)".*/\1/p' internal/runtime/runtime.go)

.PHONY: build test e2e vet all dist clean

all: vet test build

build:
	go build -o $(BIN) $(PKG)

vet:
	go vet ./...

test:
	go test ./...

# Full end-to-end suite (isolated tmux server + temp dirs).
e2e:
	./e2e/e2e.sh

# Cross-compiled release binaries (pure Go, no cgo).
# Asset names match install.sh's download_asset: ttmux-<os>-<arch>.
dist:
	@mkdir -p dist
	@for t in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 freebsd/amd64; do \
		os=$${t%/*}; arch=$${t#*/}; \
		echo "building dist/ttmux-$$os-$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -o dist/ttmux-$$os-$$arch $(PKG); \
	done

clean:
	rm -f $(BIN)
	rm -rf dist
