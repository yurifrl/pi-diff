#!/usr/bin/env bash
# install.sh — download and install the pi-diff single-file binary.
#
# USAGE: ./install.sh [--version vX.Y.Z] [--prefix /path] [--help]

set -euo pipefail

# TODO: replace this with the actual GitHub repo (owner/name) once the
# project has a public origin remote. The user can also override at runtime
# via the PI_DIFF_REPO env var.
DEFAULT_REPO="yurifrl/pi-diff"

VERSION=""
PREFIX=""

err() { printf 'install.sh: %s\n' "$*" >&2; }

usage() {
	cat <<EOF
USAGE: ./install.sh [--version vX.Y.Z] [--prefix /path] [--help]

Downloads the pi-diff binary that matches your OS/arch from a GitHub release
and installs it to a directory on your PATH.

Options:
  --version vX.Y.Z   Install a specific tag. Defaults to the latest release.
  --prefix /path     Install directory. Defaults to /usr/local/bin if writable
                     (or via sudo), otherwise \$HOME/.local/bin.
  --help             Show this message.

Environment:
  PI_DIFF_REPO       owner/repo override (e.g. acme/pi-diff). Required if the
                     script can't auto-detect the repo from the local checkout.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--version)
			[ "$#" -ge 2 ] || { err "--version requires an argument"; exit 2; }
			VERSION="$2"; shift 2 ;;
		--version=*)
			VERSION="${1#--version=}"; shift ;;
		--prefix)
			[ "$#" -ge 2 ] || { err "--prefix requires an argument"; exit 2; }
			PREFIX="$2"; shift 2 ;;
		--prefix=*)
			PREFIX="${1#--prefix=}"; shift ;;
		--help|-h)
			usage; exit 0 ;;
		*)
			err "unknown argument: $1"
			usage >&2
			exit 2 ;;
	esac
done

# ----------------------------------------------------------------------------
# Detect OS and architecture.
# ----------------------------------------------------------------------------

uname_s="$(uname -s)"
case "$uname_s" in
	Darwin) OS="darwin" ;;
	Linux)  OS="linux" ;;
	*) err "unsupported OS: $uname_s"; exit 1 ;;
esac

uname_m="$(uname -m)"
case "$uname_m" in
	x86_64|amd64) ARCH="x64" ;;
	arm64|aarch64) ARCH="arm64" ;;
	*) err "unsupported arch: $uname_m"; exit 1 ;;
esac

# ----------------------------------------------------------------------------
# Resolve repo (owner/name).
# ----------------------------------------------------------------------------

resolve_repo() {
	if [ -n "${PI_DIFF_REPO:-}" ]; then
		printf '%s' "$PI_DIFF_REPO"
		return 0
	fi
	if [ -n "$DEFAULT_REPO" ]; then
		printf '%s' "$DEFAULT_REPO"
		return 0
	fi
	# Try `git remote get-url origin` from the script's directory.
	local script_dir url
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || script_dir=""
	if [ -n "$script_dir" ] && command -v git >/dev/null 2>&1; then
		url="$(git -C "$script_dir" remote get-url origin 2>/dev/null || true)"
		if [ -n "$url" ]; then
			# Normalize git@github.com:owner/repo.git or https://github.com/owner/repo(.git)
			case "$url" in
				git@github.com:*)
					url="${url#git@github.com:}" ;;
				https://github.com/*)
					url="${url#https://github.com/}" ;;
				ssh://git@github.com/*)
					url="${url#ssh://git@github.com/}" ;;
				*)
					url="" ;;
			esac
			url="${url%.git}"
			if [ -n "$url" ]; then
				printf '%s' "$url"
				return 0
			fi
		fi
	fi
	return 1
}

if ! REPO="$(resolve_repo)"; then
	err "could not determine GitHub repo (owner/name)."
	err "set PI_DIFF_REPO=owner/repo or run from a checkout with a github.com origin."
	exit 1
fi

# ----------------------------------------------------------------------------
# Resolve version (or fall back to building from source).
# ----------------------------------------------------------------------------

if [ -z "$VERSION" ]; then
	command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }
	api_url="https://api.github.com/repos/$REPO/releases/latest"
	# Don't use -f so a 404 doesn't kill the pipe under set -e.
	VERSION="$(curl -sSL "$api_url" | sed -nE 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
	if [ -z "$VERSION" ]; then
		err "no releases found for $REPO."
		err "cut one with: task release:tag VERSION=vX.Y.Z && task release:push VERSION=vX.Y.Z"
		err "or pass --version vX.Y.Z explicitly."
		exit 1
	fi
fi

# ----------------------------------------------------------------------------
# Resolve install prefix.
# ----------------------------------------------------------------------------

USE_SUDO=""
if [ -z "$PREFIX" ]; then
	if [ -w "/usr/local/bin" ]; then
		PREFIX="/usr/local/bin"
	elif command -v sudo >/dev/null 2>&1 && [ -d "/usr/local/bin" ]; then
		PREFIX="/usr/local/bin"
		USE_SUDO="sudo"
	else
		PREFIX="$HOME/.local/bin"
	fi
fi
mkdir -p "$PREFIX" 2>/dev/null || ${USE_SUDO} mkdir -p "$PREFIX"

# ----------------------------------------------------------------------------
# Download + verify + install.
# ----------------------------------------------------------------------------

ASSET="pi-diff-$OS-$ARCH"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

echo "→ downloading $ASSET ($VERSION) from $REPO"
curl -fL --progress-bar -o "$TMP/$ASSET" "$BASE_URL/$ASSET"
curl -fL --silent       -o "$TMP/$ASSET.sha256" "$BASE_URL/$ASSET.sha256"

echo "→ verifying checksum"
(
	cd "$TMP"
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 -c "$ASSET.sha256"
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum -c "$ASSET.sha256"
	else
		err "neither shasum nor sha256sum is available"
		exit 1
	fi
)

chmod 0755 "$TMP/$ASSET"
DEST="$PREFIX/pi-diff"
if [ -n "$USE_SUDO" ]; then
	$USE_SUDO mv -f "$TMP/$ASSET" "$DEST"
	$USE_SUDO chmod 0755 "$DEST"
else
	mv -f "$TMP/$ASSET" "$DEST"
	chmod 0755 "$DEST"
fi

echo "installed pi-diff $VERSION → $DEST"

# Warn if PREFIX isn't on PATH.
case ":$PATH:" in
	*":$PREFIX:"*) ;;
	*)
		echo
		echo "note: $PREFIX is not on your PATH."
		echo "      add this to your shell profile:"
		echo "        export PATH=\"$PREFIX:\$PATH\""
		;;
esac
