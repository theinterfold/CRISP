############### stage 0: base-dev ###############
ARG RUST_VERSION=1.91.1
ARG SKIP_SOLIDITY=0

FROM rust:${RUST_VERSION}-slim-bookworm AS base-dev

ENV CARGO_HOME=/usr/local/cargo

# Each download has a deadline, so a stalled mirror fails the build instead of holding it until the
# CI job's timeout.
RUN timeout 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update && \
    timeout 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    jq pkg-config libssl-dev curl wget ca-certificates protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*

RUN timeout 300 wget -q --timeout=30 --tries=5 https://github.com/argotorg/solidity/releases/download/v0.8.27/solc-static-linux \
    && chmod +x solc-static-linux \
    && mv solc-static-linux /usr/local/bin/solc \
    && solc --version

RUN cargo install --locked cargo-chef

#################################################
############### stage 1: chef ###################
FROM base-dev AS chef
WORKDIR /app

# `cargo metadata` loads every workspace member, so the recipe needs the member sources.
# `.interfold/support/dev` and `.interfold/support/openvm/service` are symlinks into the interfold
# submodule, so the submodule's support-scripts crates are part of the build context. The `e3-*`
# crates themselves are git dependencies that Cargo fetches.
COPY Cargo.toml Cargo.lock ./
COPY .interfold/ .interfold/
COPY interfold/crates/support-scripts/ interfold/crates/support-scripts/
COPY server/ server/
COPY program/ program/
COPY crates/ crates/
COPY packages/crisp-contracts/deployed_contracts.json \
    packages/crisp-contracts/deployed_contracts.json

RUN cargo chef prepare --recipe-path recipe.json

############### stage 2: planner ###############
FROM base-dev AS planner

ARG SKIP_SOLIDITY
ENV SKIP_SOLIDITY=${SKIP_SOLIDITY}

WORKDIR /app
COPY --from=chef /app/recipe.json /app/recipe.json

COPY Cargo.toml Cargo.lock ./
COPY .interfold/ .interfold/
COPY interfold/crates/support-scripts/ interfold/crates/support-scripts/

RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cargo-target,target=/app/target,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json

############### stage 3: builder ###############
FROM base-dev AS builder

ARG SKIP_SOLIDITY
ENV SKIP_SOLIDITY=${SKIP_SOLIDITY}

WORKDIR /app

COPY .interfold/ .interfold/
COPY interfold/crates/support-scripts/ interfold/crates/support-scripts/
COPY server/ server/
COPY program/ program/
COPY crates/ crates/
COPY packages/crisp-contracts/deployed_contracts.json \
    packages/crisp-contracts/deployed_contracts.json
COPY Cargo.* ./

RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cargo-target,target=/app/target,sharing=locked \
    cargo build --locked --release --bin server && \
    mkdir -p /app/dist && cp target/release/server /app/dist/server

############### stage 4: runtime ###############
FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /

COPY --from=builder /app/dist/server \
    /usr/local/bin/server
ENTRYPOINT ["/usr/local/bin/server"]
