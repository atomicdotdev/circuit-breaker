/**
 * Runner baseline — minimum packages needed in a sealed runner VM.
 *
 * Uses Node's `crypto` module for hashing so editors without bun-types
 * don't flag errors. Bun ships a full Node `crypto` implementation so
 * this works identically at runtime.
 *
 * A bare `ubuntu:24.04` OCI image ships almost nothing. GitHub-hosted
 * runners include hundreds of packages (Node, Python, Go, Rust, Java,
 * .NET, Docker, browsers, Android SDK…). We don't need all of that.
 *
 * This module defines the **practical minimum** that lets resolved
 * `uses:` composite-action scripts execute successfully. The baseline
 * is installed once during the builder-VM phase of the sealed runner,
 * before any `uses:` install scripts run.
 *
 * @module
 */

// ============ Package Groups ============

/**
 * Packages without which nothing works.
 *
 * - `bash`       — composite actions use bash syntax, not dash/sh
 * - `curl`       — downloading tool installers (rustup, nvm, etc.)
 * - `wget`       — some actions prefer wget
 * - `ca-certificates` — HTTPS connections succeed
 * - `git`        — most actions invoke git at some point
 */
const ESSENTIAL = ["bash", "curl", "wget", "ca-certificates", "git"] as const;

/**
 * Archive and compression tools.
 *
 * Installers download tarballs and zips. Without these the
 * extract step fails silently or with a cryptic error.
 *
 * - `tar`        — .tar.gz / .tar.xz extraction
 * - `unzip`      — .zip extraction
 * - `xz-utils`   — .xz decompression (rustup, many others)
 * - `zip`        — creating archives (some actions do this)
 * - `gzip`       — .gz files
 * - `bzip2`      — .bz2 files
 */
const ARCHIVE = ["tar", "unzip", "xz-utils", "zip", "gzip", "bzip2"] as const;

/**
 * Build toolchain — needed the moment anything compiles.
 *
 * - `build-essential` — gcc, g++, make, libc-dev
 * - `pkg-config`      — finding system libraries
 * - `libssl-dev`      — OpenSSL headers (cargo, pip, gem all need this)
 * - `autoconf`        — some native extensions run autoconf
 * - `automake`        — accompanies autoconf
 * - `libtool`         — accompanies autoconf/automake
 */
const BUILD = [
  "build-essential",
  "pkg-config",
  "libssl-dev",
  "autoconf",
  "automake",
  "libtool",
] as const;

/**
 * System plumbing that install scripts expect to exist.
 *
 * - `sudo`                        — many install scripts use `sudo`
 * - `gnupg`                       — apt key verification, GPG signing
 * - `openssh-client`              — ssh / git+ssh operations
 * - `software-properties-common`  — `add-apt-repository` for PPAs
 * - `apt-transport-https`         — HTTPS apt sources
 * - `lsb-release`                 — distro detection (some installers check this)
 */
const SYSTEM = [
  "sudo",
  "gnupg",
  "openssh-client",
  "software-properties-common",
  "apt-transport-https",
  "lsb-release",
] as const;

/**
 * Utilities that are commonly assumed present.
 *
 * - `jq`                — JSON processing (very common in actions)
 * - `file`              — file type detection
 * - `locales`           — locale generation (prevents perl/python warnings)
 * - `python3`           — some actions run Python helper scripts
 * - `python3-pip`       — pip install in setup scripts
 * - `python-is-python3` — `python` symlink points to python3
 */
const UTILITIES = [
  "jq",
  "file",
  "locales",
  "python3",
  "python3-pip",
  "python-is-python3",
] as const;

// ============ Combined Package List ============

/** All baseline packages, flattened. */
export const BASELINE_PACKAGES: readonly string[] = [
  ...ESSENTIAL,
  ...ARCHIVE,
  ...BUILD,
  ...SYSTEM,
  ...UTILITIES,
];

// ============ Install Scripts ============

/**
 * Baseline install broken into separate steps.
 *
 * A single giant `apt-get install` with 29 packages causes pipe-buffering
 * hangs when invoked via `Bun.spawn` → `smolvm machine exec`. Splitting
 * into per-group execs avoids this and lets each step stream its output.
 *
 * Each entry is a `{ label, script }` pair. The runner builder executes
 * them sequentially, one `smolvm machine exec` per entry.
 */
export const BASELINE_INSTALL_STEPS: { label: string; script: string }[] = [
  {
    label: "apt-get update",
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -qq",
    ].join("\n"),
  },
  {
    label: `essential (${ESSENTIAL.join(", ")})`,
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `apt-get install -y --no-install-recommends ${ESSENTIAL.join(" ")}`,
    ].join("\n"),
  },
  {
    label: `archive (${ARCHIVE.join(", ")})`,
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `apt-get install -y --no-install-recommends ${ARCHIVE.join(" ")}`,
    ].join("\n"),
  },
  {
    label: `build toolchain (${BUILD.join(", ")})`,
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `apt-get install -y --no-install-recommends ${BUILD.join(" ")}`,
    ].join("\n"),
  },
  {
    label: `system (${SYSTEM.join(", ")})`,
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `apt-get install -y --no-install-recommends ${SYSTEM.join(" ")}`,
    ].join("\n"),
  },
  {
    label: `utilities (${UTILITIES.join(", ")})`,
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `apt-get install -y --no-install-recommends ${UTILITIES.join(" ")}`,
    ].join("\n"),
  },
  {
    label: "locale + cleanup",
    script: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      "# Generate locale (prevents warnings in many tools)",
      "locale-gen en_US.UTF-8 || true",
      "update-locale LANG=en_US.UTF-8 || true",
      "",
      "# Create the shim directory for GITHUB_OUTPUT / GITHUB_ENV / GITHUB_PATH",
      "mkdir -p /tmp/.cb",
      "touch /tmp/.cb/github_output /tmp/.cb/github_env /tmp/.cb/github_path",
      "",
      "# Clean up apt caches to keep the sealed runner small",
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
    ].join("\n"),
  },
];

/**
 * Single-script version for documentation / manual use.
 * The builder uses BASELINE_INSTALL_STEPS instead.
 */
export const BASELINE_INSTALL_SCRIPT = BASELINE_INSTALL_STEPS.map(
  (s) => `# --- ${s.label} ---\n${s.script}`,
).join("\n\n");

// ============ GitHub Actions Environment Shim ============

/**
 * Shell preamble that sets up the GitHub Actions environment shim.
 *
 * Composite actions expect GITHUB_OUTPUT, GITHUB_ENV, GITHUB_PATH,
 * and related variables to exist. This shim creates temp files at
 * well-known paths and provides helper functions that mimic the
 * GitHub Actions runner behavior.
 *
 * Run this ONCE at the start of the builder VM, before any `uses:`
 * resolved scripts execute.
 */
export const GITHUB_ACTIONS_SHIM = `
set -eo pipefail

# GitHub Actions environment shim
export GITHUB_OUTPUT="/tmp/.cb/github_output"
export GITHUB_ENV="/tmp/.cb/github_env"
export GITHUB_PATH="/tmp/.cb/github_path"
export GITHUB_STEP_SUMMARY="/dev/null"
export GITHUB_WORKSPACE="/workspace"
export RUNNER_TEMP="/tmp"
export RUNNER_TOOL_CACHE="/opt/hostedtoolcache"
export RUNNER_OS="Linux"
export RUNNER_ARCH="$(uname -m | sed 's/aarch64/ARM64/' | sed 's/x86_64/X64/')"

mkdir -p /tmp/.cb /opt/hostedtoolcache
touch "$GITHUB_OUTPUT" "$GITHUB_ENV" "$GITHUB_PATH"

# Helper: read a step output from GITHUB_OUTPUT
_gh_output() {
  grep "^$1=" "$GITHUB_OUTPUT" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# Helper: source GITHUB_ENV and GITHUB_PATH between steps
_gh_source_env() {
  if [ -s "$GITHUB_ENV" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      [ -n "$_line" ] && export "$_line"
    done < "$GITHUB_ENV"
  fi
  if [ -s "$GITHUB_PATH" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      [ -n "$_line" ] && export PATH="$_line:$PATH"
    done < "$GITHUB_PATH"
  fi
  return 0
}
`.trim();

/**
 * Shell preamble for each `run:` step in the sealed runner.
 *
 * Sources any environment variables and PATH entries that were
 * written by `uses:` install scripts during the build phase.
 * These files persist in the sealed .smolmachine overlay.
 */
export const RUN_STEP_PREAMBLE = `
# Source env/path from the sealed runner's build phase
if [ -f /tmp/.cb/github_env ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    [ -n "$_line" ] && export "$_line"
  done < /tmp/.cb/github_env
fi
if [ -f /tmp/.cb/github_path ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    [ -n "$_line" ] && export PATH="$_line:$PATH"
  done < /tmp/.cb/github_path
fi

# Use the VM's local disk for ALL write-heavy I/O — virtiofs mounts are
# fast for reads but very slow for writes. Compilers, test runners, and
# package managers all produce heavy write I/O that must stay on local disk.

# Build artifacts (cargo, go, gradle, etc.)
export CARGO_TARGET_DIR=/tmp/cargo-target
mkdir -p /tmp/cargo-target

# Temp files — tests use tempfile/tempdir crates, and many tools write
# scratch data to TMPDIR. Without this, test I/O goes through virtiofs.
export TMPDIR=/tmp
export TEMPDIR=/tmp
export RUST_TEST_TMPDIR=/tmp
export XDG_CACHE_HOME=/tmp/cache
mkdir -p /tmp/cache
`.trim();

// ============ Cache Key ============

/**
 * Compute a cache key for a sealed runner.
 *
 * The key is a hex-encoded SHA-256 hash of the base image, the
 * baseline package list version, and all `uses:` steps with their
 * `with:` inputs. If any of these change, the runner is rebuilt.
 *
 * @param image   - Base OCI image (e.g., "ubuntu:24.04")
 * @param uses    - Array of { uses, with } from the workflow's `uses:` steps
 * @returns       - Hex SHA-256 string suitable for a filename
 */
export function runnerCacheKey(
  image: string,
  uses: { uses: string; with?: Record<string, unknown> }[],
): string {
  const { createHash } = require("crypto") as typeof import("crypto");
  const hasher = createHash("sha256");

  // Version the cache — bump this if BASELINE_PACKAGES changes
  hasher.update("baseline-v1\n");
  hasher.update(`image:${image}\n`);

  // Sort uses: steps for determinism
  const sorted = [...uses].sort((a, b) => a.uses.localeCompare(b.uses));
  for (const step of sorted) {
    hasher.update(`uses:${step.uses}\n`);
    if (step.with) {
      // Sort with: keys for determinism
      const keys = Object.keys(step.with).sort();
      for (const key of keys) {
        hasher.update(`  ${key}=${JSON.stringify(step.with[key])}\n`);
      }
    }
  }

  return hasher.digest("hex");
}

// ============ Paths ============

/** Directory where sealed runners are cached. */
export const RUNNER_CACHE_DIR: string = (() => {
  const home =
    typeof process !== "undefined" && process.env?.HOME
      ? process.env.HOME
      : require("os").homedir();
  return `${home}/.cb/runners`;
})();

/**
 * Full path to a cached sealed runner .smolmachine file.
 *
 * @param cacheKey - Hex hash from `runnerCacheKey()`
 * @returns Path like `~/.cb/runners/ab12cd34....smolmachine`
 */
export function runnerCachePath(cacheKey: string): string {
  return `${RUNNER_CACHE_DIR}/${cacheKey}.smolmachine`;
}
