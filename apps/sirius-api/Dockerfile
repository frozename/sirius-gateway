# syntax=docker/dockerfile:1.7

# Multi-stage build for the sirius-api HTTP gateway.
#
# Build context: the parent directory containing `sirius-gateway/`.
# Example:
#   cd /path/to/personal
#   docker build -f sirius-gateway/apps/sirius-api/Dockerfile \
#     -t llamactl/sirius-api:dev .


# ---------- builder ----------
FROM oven/bun:1.3.13 AS builder

WORKDIR /build

# Copy the repository. The Dockerfile-specific `.dockerignore`
# keeps node_modules / dist / .git / env files out.
COPY sirius-gateway ./sirius-gateway

WORKDIR /build/sirius-gateway

# Install the full workspace graph — NestJS pulls dozens of transitive
# packages and we want the runtime stage to reuse this tree verbatim.
RUN bun install --frozen-lockfile

# Run TypeScript directly, matching the package start script.

# ---------- runtime ----------
FROM oven/bun:1.3.13-slim AS runtime

# Bun base images ship a non-root `bun` user (uid/gid 1000); run as it.
WORKDIR /app

# Copy the installed workspace and its registry dependencies.
COPY --from=builder --chown=bun:bun /build/sirius-gateway ./sirius-gateway

WORKDIR /app/sirius-gateway

ENV NODE_ENV=production \
    SIRIUS_HOST=0.0.0.0 \
    SIRIUS_PORT=3000

# Placeholder values so the NestJS DI graph wires up at boot even
# when no upstream providers are configured — the OpenAI and
# Anthropic adapters currently require their env vars to be non-empty
# regardless of whether they're actually reached. Operators must
# override with real keys at `docker run -e ...` / composite env
# time to enable those providers; the defaults only let the
# container start and serve /health for composite-applier readiness
# probes.
ENV OPENAI_API_KEY=placeholder \
    ANTHROPIC_API_KEY=placeholder

EXPOSE 3000

USER bun

# /health is public (no bearer auth) — see HealthController.
# Bun ships fetch + stdlib in the runtime image, no curl needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.SIRIUS_PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Entry is the TS main (bun executes TS natively). Port is driven by
# SIRIUS_PORT at runtime, so operators override via env, not CMD.
CMD ["bun", "apps/sirius-api/src/main.ts"]
