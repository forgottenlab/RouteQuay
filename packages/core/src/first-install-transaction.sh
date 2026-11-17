# Embedded in the node-specific installer. All paths are validated before use.
fail() { printf '%s\n' "$1" >&2; exit 1; }

rollback() {
  [ -f "$receipt/baseline" ] && [ ! -e "$receipt/recovered" ] || return 1
  local index file dir
  # Each digest was recorded before publishing its corresponding file.
  for index in "${!targets[@]}"; do
    file=${targets[$index]}
    [ ! -L "$file" ] || return 1
    if [ -e "$file" ]; then
      [ "$(stat -c '%d:%i' -- "$file")" = "$(cat "$receipt/$index.identity")" ] || return 1
      [ -f "$receipt/$index.sha256" ] && sha256sum --status -c "$receipt/$index.sha256" || return 1
    fi
  done
  if [ -f "$unit" ]; then
    systemctl daemon-reload || return 1
    systemctl stop xray || return 1
    systemctl disable xray || return 1
  fi
  for file in "${targets[@]}"; do
    rm -f -- "$file" || return 1
  done
  systemctl daemon-reload || return 1
  if declare -F rollback_owned_account >/dev/null; then rollback_owned_account || return 1; fi
  for dir in "$DEPLOY_DIR" "$config_dir"; do
    if grep -Fxq -- "$dir" "$receipt/new-dirs" && [ -d "$dir" ]; then rmdir -- "$dir" || return 1; fi
  done
  touch "$receipt/recovered"
}

# Install by hard-linking a complete sibling file. Never overwrite an existing file.
publish() {
  local index=$1 source=$2 mode=$3 file tmp digest
  file=${targets[$index]}
  tmp=$(mktemp -- "${file}.XXXXXX")
  if ! install -m "$mode" -- "$source" "$tmp"; then rm -f -- "$tmp"; return 1; fi
  digest=$(sha256sum -- "$tmp")
  printf '%s  %s\n' "${digest%% *}" "$file" > "$receipt/$index.sha256"
  stat -c '%d:%i' -- "$tmp" > "$receipt/$index.identity"
  if ! ln -- "$tmp" "$file"; then rm -f -- "$tmp"; return 1; fi
  rm -f -- "$tmp"
}

finish_first_install() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" != 0 ]; then
    if declare -F finish_install_stage >/dev/null; then finish_install_stage "$rc"; fi
    if [ -n "${INSTALL_STAGE:-}" ]; then printf '%s\n' "$INSTALL_STAGE" > "$receipt/failure-stage"; fi
    rollback || { echo "ROLLBACK_FAILED; inspect $receipt" >&2; exit 70; }
    if [ -n "${INSTALL_STAGE:-}" ]; then printf 'VPNCP_FAILED:%s:restored\n' "$INSTALL_STAGE"; fi
  fi
  exit "$rc"
}

begin_first_install() {
  umask 077
  [ "$(id -u)" = 0 ] && [ "${ALLOW_DEPLOY:-}" = true ] || fail "Explicit deployment approval and root are required."
  read -r _ _ connected_host connected_port <<< "${SSH_CONNECTION:-}"
  [ "$connected_host" = "$PUBLIC_IP" ] && [ "$connected_port" = "$SSH_PORT" ] || fail "SSH endpoint mismatch."
  unit=/etc/systemd/system/xray.service
  binary=/usr/local/bin/xray
  config_dir=$(dirname "$XRAY_CONFIG_PATH")
  receipt="/var/backups/vpn-control-plane-$JOB_ID"
  targets=("$binary" "$XRAY_CONFIG_PATH" "$unit" "$CLIENT_LINKS_PATH")
  for item in "${targets[@]}" "$receipt" "$DEPLOY_DIR"; do
    [ "$(realpath -m -- "$item")" = "$item" ] && [ ! -L "$item" ] || fail "Unexpected path or symlink."
  done

  # Serialize cooperating installers, including different kits for the same host.
  exec 9</var/backups
  flock -nx 9 || fail "Another first-install or recovery operation is active."

  if [ "${1:-}" = --rollback ]; then
    rollback || fail "Rollback stopped. Inspect the retained receipt before retrying."
    exit 0
  fi
  [ "$#" = 0 ] || fail "Unknown install action."
  if declare -F verify_install_baseline >/dev/null; then verify_install_baseline || fail 'INSTALL_BASELINE_CHANGED'; fi
  for cmd in awk cat curl dirname flock grep id install ln mkdir mktemp openssl python3 realpath rm rmdir sha256sum ss stat systemctl touch uname; do
    command -v "$cmd" >/dev/null || fail "Missing prerequisite: $cmd"
  done
  [[ ${XRAY_RELEASE_SHA256:-} =~ ^[0-9a-fA-F]{64}$ ]] || fail "Verified release digest required."
  [ "$(systemctl show xray.service --property=LoadState --value)" = not-found ] || fail "Existing Xray unit."
  ! command -v xray >/dev/null || fail "Existing Xray installation."
  listeners=$(ss -H -ltn "sport = :$XRAY_PORT")
  [ -z "$listeners" ] || fail "Planned port already in use."
  for file in "${targets[@]}"; do [ ! -e "$file" ] || fail "Existing install target."; done
  [ -d /usr/local/bin ] && [ -d /usr/local/etc ] || fail "Missing system directory."
  mkdir -m 700 -- "$receipt" || fail "Receipt already exists or is unavailable."
  : > "$receipt/new-dirs"
  for dir in "$config_dir" "$DEPLOY_DIR"; do
    if [ ! -d "$dir" ]; then printf '%s\n' "$dir" >> "$receipt/new-dirs"; fi
  done
  printf '%s\n' "node=$NODE_ID" "job=$JOB_ID" "xray-unit=not-found" "listener=absent" "${targets[@]/#/absent=}" > "$receipt/baseline"
  [ "$(grep -c '^absent=' "$receipt/baseline")" = 4 ] || fail "Baseline verification failed."
  trap finish_first_install EXIT
  trap 'exit 1' HUP INT TERM
  mkdir -p -- "$config_dir" "$DEPLOY_DIR"
}
