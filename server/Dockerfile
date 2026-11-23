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

############### stage 1: builder ###############
FROM base-dev AS builder

ARG SKIP_SOLIDITY
ENV SKIP_SOLIDITY=${SKIP_SOLIDITY}

WORKDIR /app

COPY runner/ runner/
COPY server/ server/
COPY program/ program/
COPY crates/ crates/
COPY extensions/core/remote-input/ extensions/core/remote-input/
COPY extensions/aztec/ingest/ extensions/aztec/ingest/
COPY extensions/gnosis/ingest/ extensions/gnosis/ingest/
COPY packages/crisp-contracts/deployed_contracts.json \
    packages/crisp-contracts/deployed_contracts.json
COPY Cargo.* ./

RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cargo-target,target=/app/target,sharing=locked \
    cargo build --locked --release --bin server && \
    mkdir -p /app/dist && cp target/release/server /app/dist/server

############### stage 2: bb ###############
# The server verifies staging passes (`PROGRAM_KIND=aztec`) with the Barretenberg CLI. The version
# must be the one that made `staging_pass.vk` (`extensions/core/circuits/staging_pass/build.sh`);
# the server refuses to start with another.
FROM base-dev AS bb

ARG BB_VERSION=6.0.0
ARG TARGETARCH

RUN timeout 600 curl -fsSL --retry 5 --connect-timeout 30 \
    "https://github.com/AztecProtocol/aztec-packages/releases/download/v${BB_VERSION}/barretenberg-${TARGETARCH}-linux.tar.gz" \
    | tar -xz -C /usr/local/bin bb \
    && bb --version

# `bb verify` downloads its reference string on first use. Verify one real pass now, so the image
# carries the string and the server needs no network and no writable home to verify.
COPY extensions/core/circuits/staging_pass/compiled/staging_pass.vk /usr/local/share/crisp/staging_pass.vk
# `PROGRAM_KIND=aztec-votes` verifies passes of `staging_pass_votes` instead: set STAGING_PASS_VK_PATH to this key.
COPY extensions/core/circuits/staging_pass_votes/compiled/staging_pass_votes.vk /usr/local/share/crisp/staging_pass_votes.vk
COPY server/tests/fixtures/staging_pass.json /tmp/staging_pass.json
RUN mkdir -p /usr/local/share/bb-crs \
    && hex() { perl -e 'print pack("H*", $ARGV[0])' "$1"; } \
    && hex "$(jq -r '.staging_pass.proof[2:]' /tmp/staging_pass.json)" > /tmp/proof \
    && hex "$(jq -r '[.staging_pass.public_inputs[][2:]] | join("")' /tmp/staging_pass.json)" > /tmp/public_inputs \
    && bb verify -t evm -p /tmp/proof -i /tmp/public_inputs -k /usr/local/share/crisp/staging_pass.vk \
        --crs_path /usr/local/share/bb-crs \
    && rm /tmp/proof /tmp/public_inputs /tmp/staging_pass.json

############### stage 3: runtime ###############
FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /

COPY --from=builder /app/dist/server \
    /usr/local/bin/server
COPY --from=bb /usr/local/bin/bb /usr/local/bin/bb
COPY --from=bb /usr/local/share/crisp/staging_pass.vk /usr/local/share/crisp/staging_pass.vk
COPY --from=bb /usr/local/share/crisp/staging_pass_votes.vk /usr/local/share/crisp/staging_pass_votes.vk
COPY --from=bb /usr/local/share/bb-crs /usr/local/share/bb-crs
ENV BB_BINARY_PATH=/usr/local/bin/bb \
    STAGING_PASS_VK_PATH=/usr/local/share/crisp/staging_pass.vk \
    BB_CRS_PATH=/usr/local/share/bb-crs
ENTRYPOINT ["/usr/local/bin/server"]
