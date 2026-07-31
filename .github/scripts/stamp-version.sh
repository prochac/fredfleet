#!/usr/bin/env bash
# Rewrite wails.json's info.productVersion from the tag being built.
#
# wails build has no --version flag: it reads info.productVersion out of
# wails.json and templates it into build/darwin/Info.plist (CFBundleVersion,
# CFBundleShortVersionString) and build/windows/info.json (file_version).
# Without this the checked-in placeholder 0.0.0 ships in every artifact.
#
# Windows' VERSIONINFO resource only accepts a numeric X.Y.Z, so a
# prerelease tag (v1.2.0-rc1) is stamped as its numeric core (1.2.0). The
# release asset filenames still carry the full tag.
set -euo pipefail

ref="${GITHUB_REF_NAME:-}"
version="0.0.0"

if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
	core="${ref#v}"
	core="${core%%-*}"
	if [[ "${core}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
		version="${core}"
	else
		echo "warning: tag ${ref} has no X.Y.Z core, stamping ${version}" >&2
	fi
fi

echo "stamping info.productVersion = ${version}"
jq --arg v "${version}" '.info.productVersion = $v' wails.json > wails.json.tmp
mv wails.json.tmp wails.json
