ARG RUST_VERSION=1.91.1
FROM rust:${RUST_VERSION}-slim-bookworm
# Each download has a deadline, so a stalled mirror fails the build instead of holding it until the
# CI job's timeout.
RUN timeout 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update && timeout 600 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    build-essential cmake pkg-config git libssl-dev ca-certificates protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# CRISP's program runner, which serves the OpenVM proving service and the unproved development
# runner. Cargo fetches the Interfold crates from git; the image builds only the workspace members.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY runner ./runner
COPY program ./program
COPY server ./server
COPY crates ./crates
RUN cargo build --locked --release --bin program-runner
# Mount the separately built OpenVM workers, their configuration, and the proving artifacts, and
# set OPENVM_PROVER_BIN, OPENVM_PROVER_BIN_CUDA, OPENVM_PROVER_CONFIG and OPENVM_BACKEND.
ENV OPENVM_BIND_ADDR=0.0.0.0:13151
# A test deployment with the unproved receipt verifier (CRISP_UNPROVED_TEST=1) gives `dev` as the
# command instead, which starts the development runner. It binds 0.0.0.0:13151 by default.
ENTRYPOINT ["./target/release/program-runner"]
CMD ["openvm"]
