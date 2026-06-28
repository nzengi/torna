# Torna v4 build.
#
#   make test         host-side L1 unit + L2 differential tests (assertions on)
#   make test-asan    same, under AddressSanitizer
#   make sbf          build the on-chain program -> sbf/out/torna.so
#   make integration  build + run the LiteSVM on-chain tests (smoke + inttest)
#   make diff          exhaustive on-chain differential vs an oracle (~70s)
#   make fuzz          fuzz handlers for memory safety (FUZZ_ITERS=N, default 20000)
#   make all          test + sbf + integration + diff + fuzz
#   make clean
#
# Toolchain: the SBF build and the integration crate use the platform-tools at
# ~/.local/share/solana/install/active_release/bin (add it to PATH first).

CC      ?= gcc
HOSTFLAGS = -DTORNA_DEBUG -O1 -std=c11 -Wall -Wextra -Werror
BUILD    = build

SBF_SDK := $(HOME)/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf

.PHONY: all test test-asan sbf probe cpi-probe integration diff fuzz cu clean

all: test sbf integration diff fuzz cu

# build the on-chain program -> sbf/out/torna.so
sbf:
	$(MAKE) -f $(SBF_SDK)/c/sbf.mk \
	  SRC_DIR=$(CURDIR)/sbf/src OUT_DIR=$(CURDIR)/sbf/out \
	  INC_DIRS=$(CURDIR)/src torna

# composability de-risk probe (MOAT step 1) -> sbf/out/probe.so
probe:
	$(MAKE) -f $(SBF_SDK)/c/sbf.mk \
	  SRC_DIR=$(CURDIR)/sbf/src OUT_DIR=$(CURDIR)/sbf/out \
	  INC_DIRS=$(CURDIR)/src probe

# Rust CPI probe (exercises the torna-cpi crate) -> sbf, via cargo build-sbf
cpi-probe:
	cd cpi-probe && cargo build-sbf --offline

# on-chain integration tests in LiteSVM (needs sbf/out/torna.so built first)
integration: sbf probe cpi-probe
	cd integration && cargo build --offline
	cd integration && ./target/debug/smoke
	cd integration && ./target/debug/inttest
	cd integration && ./target/debug/cpitest
	cd integration && ./target/debug/sdktest

# exhaustive on-chain differential vs an oracle (validates the SBF wrapper; ~70s)
diff: sbf
	cd integration && cargo build --offline --bin difftest
	cd integration && ./target/debug/difftest

# fuzz every handler with malformed ix bytes + random account sets (memory safety)
# pass N for a longer run: make fuzz FUZZ_ITERS=60000
FUZZ_ITERS ?= 20000
fuzz: sbf
	cd integration && cargo build --offline --bin fuzz
	cd integration && ./target/debug/fuzz $(FUZZ_ITERS)

# CU at production scale (F=16/64/128, full nodes, max MultiLeaf) vs the budgets
cu: sbf
	cd integration && cargo build --offline --bin cu
	cd integration && ./target/debug/cu

test: $(BUILD)/test_node $(BUILD)/test_tree
	$(BUILD)/test_node
	$(BUILD)/test_tree

# memory-checked variants (ASan) — run before trusting a change
test-asan: | $(BUILD)
	$(CC) -DTORNA_DEBUG -O0 -g -fsanitize=address -o $(BUILD)/test_node_asan test/test_node.c
	$(CC) -DTORNA_DEBUG -O0 -g -fsanitize=address -o $(BUILD)/test_tree_asan test/test_tree.c
	$(BUILD)/test_node_asan
	$(BUILD)/test_tree_asan

$(BUILD)/test_node: test/test_node.c src/node.h | $(BUILD)
	$(CC) $(HOSTFLAGS) -o $@ test/test_node.c

$(BUILD)/test_tree: test/test_tree.c src/node.h | $(BUILD)
	$(CC) $(HOSTFLAGS) -o $@ test/test_tree.c

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD) sbf/out integration/target
