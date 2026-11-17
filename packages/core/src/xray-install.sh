# Appended to the shared first-install transaction, never invoked independently.
finish_install_stage() {
  if [ -n "${INSTALL_STAGE:-}" ]; then
    printf '%s\t%s\tend\t%s\n' "$(date -u +%FT%TZ)" "$INSTALL_STAGE" "$1" >> "$receipt/stages.tsv"
  fi
}
install_stage() {
  finish_install_stage 0
  INSTALL_STAGE=$1
  printf '%s\t%s\tstart\t-\n' "$(date -u +%FT%TZ)" "$INSTALL_STAGE" >> "$receipt/stages.tsv"
}
rollback_owned_account() {
  if [ -f "$receipt/account.uid" ]; then
    [ "$(id -u "$ACCOUNT")" = "$(cat "$receipt/account.uid")" ] || return 1
    userdel "$ACCOUNT" || return 1
    if getent group "$ACCOUNT" >/dev/null; then
      [ "$(getent group "$ACCOUNT" | cut -d: -f3)" = "$(cat "$receipt/account.gid")" ] || return 1
      groupdel "$ACCOUNT" || return 1
    fi
  elif getent passwd "$ACCOUNT" >/dev/null; then
    # A crash between useradd and its receipt cannot prove ownership.
    return 1
  fi
}

begin_first_install
install_stage asset-download
[ ! -e "$receipt/installed" ] || fail 'TRANSACTION_ALREADY_INSTALLED'
! getent passwd "$ACCOUNT" >/dev/null || fail 'SERVICE_ACCOUNT_CONFLICT'
! getent group "$ACCOUNT" >/dev/null || fail 'SERVICE_GROUP_CONFLICT'
curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 --max-redirs 5 \
  "https://github.com/XTLS/Xray-core/releases/download/v$XRAY_VERSION/$XRAY_ASSET" -o "$receipt/xray.zip" 2>/dev/null
install_stage asset-checksum
printf '%s  %s\n' "$XRAY_RELEASE_SHA256" "$receipt/xray.zip" | sha256sum --status -c -
install_stage asset-extraction
python3 - "$receipt/xray.zip" "$receipt/xray" <<'EXTRACT'
import shutil
import stat
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = [entry for entry in archive.infolist() if entry.filename == 'xray']
    assert len(entries) == 1 and not entries[0].is_dir()
    assert stat.S_IFMT(entries[0].external_attr >> 16) in (0, stat.S_IFREG)
    assert entries[0].file_size < 200 * 1024 * 1024
    with archive.open(entries[0]) as source, open(sys.argv[2], 'xb') as output:
        shutil.copyfileobj(source, output, 65536)
EXTRACT
chmod 0755 "$receipt/xray"
install_stage binary-version
version=$("$receipt/xray" version)
[[ "$version" = "Xray $XRAY_VERSION "* ]] || fail 'BINARY_VERSION_MISMATCH'
# Confirm TLS 1.3, certificate trust and SNI at the proposed REALITY target.
install_stage reality-target
target_check=$(timeout 15 openssl s_client -connect "$REALITY_TARGET" -servername "$SERVER_NAME" \
  -verify_hostname "$SERVER_NAME" -verify_return_error -tls1_3 -alpn h2 </dev/null 2>&1) || fail 'REALITY_TARGET_UNVERIFIED'
printf '%s\n' "$target_check" | grep -Fq 'ALPN protocol: h2' || fail 'REALITY_TARGET_H2_UNVERIFIED'
unset target_check
install_stage config-generate
python3 - "$receipt/config.json" <<'CONFIG'
import base64
import sys
with open(sys.argv[1], 'xb') as output:
    output.write(base64.b64decode('__CONFIG_BASE64__'))
CONFIG
install_stage config-validation
"$receipt/xray" run -test -config "$receipt/config.json" >/dev/null 2>&1 || fail 'CONFIG_VALIDATION_FAILED'
# No home directory, no login shell and no shared service identity.
install_stage account-create
useradd --system --no-create-home --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$ACCOUNT"
id -u "$ACCOUNT" > "$receipt/account.uid"
id -g "$ACCOUNT" > "$receipt/account.gid"
chown "root:$ACCOUNT" "$config_dir"
chmod 0750 "$config_dir"
cat > "$receipt/xray.service" <<UNIT
[Unit]
Description=Xray managed by vpncp
After=network-online.target
Wants=network-online.target
[Service]
User=$ACCOUNT
Group=$ACCOUNT
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
UNIT
install_stage file-publish
publish 0 "$receipt/xray" 0755
publish 1 "$receipt/config.json" 0600
chown "root:$ACCOUNT" "$XRAY_CONFIG_PATH"
chmod 0640 "$XRAY_CONFIG_PATH"
# Refresh identity/digest before the unit is made visible. chmod/chown preserve inode.
publish 2 "$receipt/xray.service" 0644
printf '{"transaction":"%s","version":"%s"}\n' "$JOB_ID" "$XRAY_VERSION" > "$receipt/metadata.json"
publish 3 "$receipt/metadata.json" 0600
install_stage service-start
systemctl daemon-reload
systemctl enable xray >/dev/null 2>&1
systemctl start xray >/dev/null 2>&1
install_stage service-readiness
ready=false
for ((attempt=0; attempt<READY_TIMEOUT; attempt++)); do
  if systemctl is-active --quiet xray && ss -H -ltn "sport = :$XRAY_PORT" | grep -q .; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail 'SERVICE_NOT_READY'
/usr/local/bin/xray run -test -config "$XRAY_CONFIG_PATH" >/dev/null 2>&1 || fail 'CONFIG_VALIDATION_FAILED'
finish_install_stage 0
touch "$receipt/installed"
trap - EXIT HUP INT TERM
printf '%s\n' 'VPNCP_INSTALLED'
