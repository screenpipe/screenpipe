#!/usr/bin/env bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
# This client receives only the scoped artifact-upload capability. The server
# cannot write updater pointers, GitHub releases, or enterprise publication state.

set -euo pipefail

if [[ $# -lt 4 ]]; then
	echo "usage: upload-release-artifacts.sh <consumer|enterprise> <version> <target> <file/glob>..." >&2
	exit 2
fi

: "${RELEASE_UPLOAD_URL:?RELEASE_UPLOAD_URL is required}"
: "${RELEASE_UPLOAD_TOKEN:?RELEASE_UPLOAD_TOKEN is required}"

scope="$1"
version="$2"
target="$3"
shift 3

base_url="${RELEASE_UPLOAD_URL%/}/v1/uploads/${scope}/${version}/${target}"
auth_header="Authorization: Bearer ${RELEASE_UPLOAD_TOKEN}"
curl_bin="curl"
if [[ -x /opt/homebrew/opt/curl/bin/curl ]]; then
	curl_bin="/opt/homebrew/opt/curl/bin/curl"
fi

curl_json() {
	"$curl_bin" --fail --silent --show-error --retry 3 --retry-all-errors "$@"
}

echo "clearing stale ${scope} artifacts for ${version}/${target}"
curl_json -X DELETE -H "$auth_header" "$base_url" >/dev/null

uploaded=0
for artifact in "$@"; do
	[[ -f "$artifact" ]] || continue
	filename="$(basename "$artifact")"
	work_dir="$(mktemp -d)"
	upload_id=""

	cleanup_upload() {
		if [[ -n "$upload_id" ]]; then
			curl_json -X DELETE \
				-H "$auth_header" \
				-H "X-Artifact-Name: $filename" \
				"${base_url}?uploadId=${upload_id}" >/dev/null 2>&1 || true
		fi
		rm -rf "$work_dir"
	}
	trap cleanup_upload EXIT

	init_json="$(curl_json -X POST -H "$auth_header" -H "X-Artifact-Name: $filename" "$base_url")"
	upload_id="$(jq -er '.uploadId' <<<"$init_json")"

	# Stay under the smallest Cloudflare request-body limit. R2 multipart
	# assembly preserves support for large DMGs/AppImages without granting CI
	# bucket credentials.
	split -b 80000000 "$artifact" "$work_dir/part-"
	parts='[]'
	part_number=0
	for part in "$work_dir"/part-*; do
		part_number=$((part_number + 1))
		part_json="$(curl_json -X PUT \
			-H "$auth_header" \
			-H "X-Artifact-Name: $filename" \
			-H "Content-Type: application/octet-stream" \
			--data-binary "@$part" \
			"${base_url}?uploadId=${upload_id}&partNumber=${part_number}")"
		parts="$(jq -c --argjson part "$part_json" '. + [$part]' <<<"$parts")"
	done

	complete_body="$(jq -nc --argjson parts "$parts" '{parts: $parts}')"
	curl_json -X POST \
		-H "$auth_header" \
		-H "X-Artifact-Name: $filename" \
		-H "Content-Type: application/json" \
		--data "$complete_body" \
		"${base_url}?action=complete&uploadId=${upload_id}" >/dev/null

	upload_id=""
	rm -rf "$work_dir"
	trap - EXIT
	uploaded=$((uploaded + 1))
	echo "uploaded $filename"
done

if [[ "$uploaded" -eq 0 ]]; then
	echo "no release artifacts matched" >&2
	exit 1
fi

echo "uploaded ${uploaded} ${scope} artifact(s) for ${version}/${target}"
