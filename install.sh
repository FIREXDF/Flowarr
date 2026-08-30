#!/usr/bin/env bash
set -Eeuo pipefail

# Flowarr bare-metal installer for Debian 12/13.
# Run from the root of a Flowarr checkout: sudo bash install.sh

FLOWARR_USER="${FLOWARR_USER:-flowarr}"
FLOWARR_GROUP="${FLOWARR_GROUP:-flowarr}"
INSTALL_DIR="${INSTALL_DIR:-/opt/flowarr}"
DATA_DIR="${DATA_DIR:-/var/lib/flowarr}"
MEDIA_DIR="${MEDIA_DIR:-/srv/flowarr/media}"
PLUGIN_DIR="${PLUGIN_DIR:-/var/lib/flowarr/plugins}"
TEMP_DIR="${TEMP_DIR:-/var/lib/flowarr/temp}"
CONFIG_DIR="${CONFIG_DIR:-/etc/flowarr}"
PORT="${PORT:-3000}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
PNPM_VERSION="${PNPM_VERSION:-11.19.0}"
NODE_MAJOR="${NODE_MAJOR:-24}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n\033[1;32m[Flowarr]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[Flowarr]\033[0m %s\n' "$*" >&2; exit 1; }

on_error() {
  local exit_code=$?
  printf '\nInstallation interrompue (ligne %s, code %s).\n' "${BASH_LINENO[0]}" "$exit_code" >&2
  printf 'Après création du service: journalctl -u flowarr -n 100 --no-pager\n' >&2
  exit "$exit_code"
}
trap on_error ERR

[[ $EUID -eq 0 ]] || die "Lancez: sudo bash install.sh"
[[ -r /etc/os-release ]] || die "Distribution non reconnue. Debian requis."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "Debian requis (détecté: ${PRETTY_NAME:-inconnu})."
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/pnpm-workspace.yaml" ]] || \
  die "Lancez ce script depuis une copie complète du dépôt Flowarr."
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "PORT invalide: $PORT"

install_node() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi
  if [[ "$current_major" == "$NODE_MAJOR" ]]; then
    log "Node.js $(node --version) déjà présent"
    return
  fi

  local machine node_arch base version archive expected work_dir
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "Architecture non prise en charge: $machine (amd64/arm64 requis)." ;;
  esac

  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' RETURN
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  log "Installation Node.js ${NODE_MAJOR}.x officiel"
  curl --fail --location --silent --show-error "$base/SHASUMS256.txt" -o "$work_dir/SHASUMS256.txt"
  archive="$(awk -v arch="linux-${node_arch}.tar.xz" '$2 ~ arch "$" { print $2; exit }' "$work_dir/SHASUMS256.txt")"
  [[ -n "$archive" ]] || die "Archive Node.js introuvable pour $node_arch."
  version="${archive%-linux-${node_arch}.tar.xz}"
  expected="$(awk -v file="$archive" '$2 == file { print $1; exit }' "$work_dir/SHASUMS256.txt")"
  curl --fail --location --silent --show-error "$base/$archive" -o "$work_dir/$archive"
  printf '%s  %s\n' "$expected" "$work_dir/$archive" | sha256sum --check --status || die "Somme SHA-256 Node.js invalide."
  install -d -m 0755 /usr/local/lib/nodejs
  rm -rf -- "/usr/local/lib/nodejs/$version"
  tar -xJf "$work_dir/$archive" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/$version/bin/node" /usr/local/bin/node
  ln -sfn "/usr/local/lib/nodejs/$version/bin/npm" /usr/local/bin/npm
  ln -sfn "/usr/local/lib/nodejs/$version/bin/npx" /usr/local/bin/npx
  hash -r
  trap - RETURN
  rm -rf -- "$work_dir"
}

systemd_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

log "Installation dépendances système"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl ffmpeg openssl rsync xz-utils npm

install_node
log "Installation pnpm ${PNPM_VERSION}"
npm install --global --prefix /usr/local "pnpm@${PNPM_VERSION}"

if ! getent group "$FLOWARR_GROUP" >/dev/null; then
  groupadd --system "$FLOWARR_GROUP"
fi
if ! id "$FLOWARR_USER" >/dev/null 2>&1; then
  useradd --system --gid "$FLOWARR_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$FLOWARR_USER"
fi

log "Copie application vers $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.agents/' \
  --exclude='.codex/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='data/' \
  --exclude='test/' \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

log "Installation modules et compilation"
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile
pnpm build

install -d -o "$FLOWARR_USER" -g "$FLOWARR_GROUP" -m 0750 \
  "$DATA_DIR" "$PLUGIN_DIR" "$TEMP_DIR" "$MEDIA_DIR"
if [[ -d "$INSTALL_DIR/plugins" ]]; then
  rsync -a --ignore-existing "$INSTALL_DIR/plugins/" "$PLUGIN_DIR/"
  chown -R "$FLOWARR_USER:$FLOWARR_GROUP" "$PLUGIN_DIR"
fi
chown -R root:root "$INSTALL_DIR"
chmod -R u=rwX,go=rX "$INSTALL_DIR"

install -d -m 0750 "$CONFIG_DIR"
ENV_FILE="$CONFIG_DIR/flowarr.env"
if [[ ! -f "$ENV_FILE" ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  {
    printf 'FLOWARR_HOST=%s\n' "$(systemd_quote "$BIND_HOST")"
    printf 'FLOWARR_PORT=%s\n' "$(systemd_quote "$PORT")"
    printf 'FLOWARR_DATA_DIR=%s\n' "$(systemd_quote "$DATA_DIR")"
    printf 'FLOWARR_WEB_DIR=%s\n' "$(systemd_quote "$INSTALL_DIR/apps/web/dist")"
    printf 'FLOWARR_PLUGIN_DIR=%s\n' "$(systemd_quote "$PLUGIN_DIR")"
    printf 'FLOWARR_JWT_SECRET=%s\n' "$(systemd_quote "$JWT_SECRET")"
    printf 'FLOWARR_ENCRYPTION_KEY=%s\n' "$(systemd_quote "$ENCRYPTION_KEY")"
    printf 'FLOWARR_SECURE_COOKIES="false"\n'
  } > "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chown root:"$FLOWARR_GROUP" "$ENV_FILE"
else
  log "Configuration existante conservée: $ENV_FILE"
fi

log "Création service systemd"
cat > /etc/systemd/system/flowarr.service <<EOF
[Unit]
Description=Flowarr media automation server
Documentation=https://github.com/FIREXDF/Flowarr
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$FLOWARR_USER
Group=$FLOWARR_GROUP
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node $INSTALL_DIR/apps/server/dist/index.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$DATA_DIR $PLUGIN_DIR $TEMP_DIR $MEDIA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now flowarr.service

log "Vérification service"
for _ in {1..20}; do
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    printf '\nFlowarr installé. Ouvrez: http://ADRESSE_IP_DU_SERVEUR:%s\n' "$PORT"
    printf 'Médias: %s\nConfiguration: %s\nLogs: journalctl -u flowarr -f\n' "$MEDIA_DIR" "$ENV_FILE"
    exit 0
  fi
  sleep 1
done

systemctl status flowarr.service --no-pager || true
journalctl -u flowarr.service -n 50 --no-pager || true
die "Service démarré, mais contrôle HTTP échoué. Consultez les logs ci-dessus."
