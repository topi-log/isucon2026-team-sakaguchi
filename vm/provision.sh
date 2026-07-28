#!/usr/bin/env bash
set -euo pipefail

readonly NODE_VERSION="24.18.0"
readonly PNPM_VERSION="11.1.1"
readonly KUMO_VERSION="0.25.3"
readonly APP_ROOT="/opt/sakaguchi"
readonly CURRENT_DIR="${APP_ROOT}/current"
readonly INCOMING_DIR="${APP_ROOT}/incoming"
readonly PREVIOUS_DIR="${APP_ROOT}/previous"

if [[ "${EUID}" -ne 0 ]]; then
  echo "vm/provision.sh は root 権限で実行してください" >&2
  exit 1
fi

if [[ "$#" -ne 1 || "$1" != /* || ! -f "$1/package.json" || ! -f "$1/pnpm-lock.yaml" ]]; then
  echo "usage: sudo vm/provision.sh /absolute/path/to/source" >&2
  exit 1
fi

readonly SOURCE_DIR="${1%/}"

case "$(uname -m)" in
  x86_64)
    readonly NODE_ARCH="x64"
    readonly NODE_SHA256="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
    readonly KUMO_ARCH="amd64"
    readonly KUMO_SHA256="30ffc00c190bccc1f73fd852b0200015e746cbc563d522276db117b1ed3a4531"
    ;;
  aarch64 | arm64)
    readonly NODE_ARCH="arm64"
    readonly NODE_SHA256="58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"
    readonly KUMO_ARCH="arm64"
    readonly KUMO_SHA256="ccdbfc6051e4dcdc39ed8a75129fb0da2ff15aad3e7e908033dbe3de2c241df6"
    ;;
  *)
    echo "未対応のCPU architectureです: $(uname -m)" >&2
    exit 1
    ;;
esac

download_checked() {
  local url="$1"
  local sha256="$2"
  local destination="$3"

  curl --fail --location --retry 3 --output "${destination}" "${url}"
  printf '%s  %s\n' "${sha256}" "${destination}" | sha256sum --check --status
}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  ca-certificates \
  curl \
  nginx \
  postgresql \
  postgresql-contrib \
  rsync \
  tar \
  xz-utils

if ! id sakaguchi >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /var/lib/sakaguchi \
    --shell /usr/sbin/nologin sakaguchi
fi
if ! id kumo >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /var/lib/kumo \
    --shell /usr/sbin/nologin kumo
fi

node_dir="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
if [[ ! -x "${node_dir}/bin/node" ]] || [[ "$("${node_dir}/bin/node" --version)" != "v${NODE_VERSION}" ]]; then
  node_archive="$(mktemp)"
  download_checked \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    "${NODE_SHA256}" \
    "${node_archive}"
  rm -rf "${node_dir}"
  tar --extract --xz --file "${node_archive}" --directory /opt
  rm -f "${node_archive}"
fi
for command in node npm npx corepack; do
  ln -sfn "${node_dir}/bin/${command}" "/usr/local/bin/${command}"
done
corepack enable --install-directory /usr/local/bin
corepack install --global "pnpm@${PNPM_VERSION}"

if [[ ! -x /usr/local/bin/kumo ]] || [[ ! -f /opt/kumo-version ]] ||
  [[ "$(< /opt/kumo-version)" != "${KUMO_VERSION}" ]]; then
  kumo_archive="$(mktemp)"
  kumo_extract_dir="$(mktemp -d)"
  download_checked \
    "https://github.com/sivchari/kumo/releases/download/v${KUMO_VERSION}/kumo_${KUMO_VERSION}_linux_${KUMO_ARCH}.tar.gz" \
    "${KUMO_SHA256}" \
    "${kumo_archive}"
  tar --extract --gzip --file "${kumo_archive}" --directory "${kumo_extract_dir}"
  install --mode 0755 "${kumo_extract_dir}/kumo" /usr/local/bin/kumo
  printf '%s\n' "${KUMO_VERSION}" > /opt/kumo-version
  rm -rf "${kumo_archive}" "${kumo_extract_dir}"
fi

install --directory --owner=sakaguchi --group=sakaguchi "${APP_ROOT}"
rm -rf "${INCOMING_DIR}"
install --directory --owner=sakaguchi --group=sakaguchi "${INCOMING_DIR}"
rsync --archive --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  "${SOURCE_DIR}/" "${INCOMING_DIR}/"
chown -R sakaguchi:sakaguchi "${INCOMING_DIR}"

runuser -u sakaguchi -- env HOME=/var/lib/sakaguchi \
  /bin/bash -c "cd '${INCOMING_DIR}' && /usr/local/bin/pnpm install --frozen-lockfile"
runuser -u sakaguchi -- env HOME=/var/lib/sakaguchi \
  /bin/bash -c "cd '${INCOMING_DIR}' && /usr/local/bin/pnpm build"

rm -rf "${PREVIOUS_DIR}"
if [[ -d "${CURRENT_DIR}" ]]; then
  mv "${CURRENT_DIR}" "${PREVIOUS_DIR}"
fi
if ! mv "${INCOMING_DIR}" "${CURRENT_DIR}"; then
  if [[ -d "${PREVIOUS_DIR}" ]]; then
    mv "${PREVIOUS_DIR}" "${CURRENT_DIR}"
  fi
  exit 1
fi
rm -rf "${PREVIOUS_DIR}"
chmod -R a+rX "${CURRENT_DIR}"

install --directory /etc/sakaguchi
install --mode 0644 "${CURRENT_DIR}/vm/app.env" /etc/sakaguchi/app.env
install --mode 0644 "${CURRENT_DIR}/vm/systemd/sakaguchi-app.service" \
  /etc/systemd/system/sakaguchi-app.service
install --mode 0644 "${CURRENT_DIR}/vm/systemd/kumo.service" \
  /etc/systemd/system/kumo.service
install --mode 0644 "${CURRENT_DIR}/vm/nginx/sakaguchi.conf" \
  /etc/nginx/conf.d/sakaguchi.conf
rm -f /etc/nginx/sites-enabled/default

postgres_conf_dirs=(/etc/postgresql/*/main/conf.d)
if [[ ! -d "${postgres_conf_dirs[0]}" ]]; then
  echo "PostgreSQLのconf.dが見つかりません" >&2
  exit 1
fi
for postgres_conf_dir in "${postgres_conf_dirs[@]}"; do
  install --mode 0644 "${CURRENT_DIR}/vm/postgresql/sakaguchi.conf" \
    "${postgres_conf_dir}/sakaguchi.conf"
done

systemctl daemon-reload
systemctl enable nginx postgresql kumo sakaguchi-app
systemctl restart postgresql

if ! runuser -u postgres -- psql --tuples-only --no-align --command \
  "SELECT 1 FROM pg_roles WHERE rolname = 'sakaguchi'" | grep -qx 1; then
  runuser -u postgres -- createuser --login sakaguchi
fi
if ! runuser -u postgres -- psql --tuples-only --no-align --command \
  "SELECT 1 FROM pg_database WHERE datname = 'sakaguchi'" | grep -qx 1; then
  runuser -u postgres -- createdb --owner sakaguchi sakaguchi
fi

runuser -u postgres -- psql --dbname sakaguchi --set ON_ERROR_STOP=1 \
  --command "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
runuser -u sakaguchi -- psql --dbname sakaguchi --set ON_ERROR_STOP=1 \
  --file "${CURRENT_DIR}/database/001-schema.sql"
user_count="$(runuser -u sakaguchi -- psql --dbname sakaguchi --tuples-only --no-align \
  --command "SELECT count(*) FROM users")"
if [[ "${user_count}" -eq 0 ]]; then
  runuser -u sakaguchi -- psql --dbname sakaguchi --set ON_ERROR_STOP=1 \
    --file "${CURRENT_DIR}/database/seed.sql"
fi

systemctl restart kumo
nginx -t
systemctl restart sakaguchi-app
systemctl restart nginx

for _ in {1..30}; do
  if curl --fail --silent http://127.0.0.1/api/health >/dev/null; then
    echo "Sakaguchi VM is ready: http://127.0.0.1/"
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --full status nginx postgresql kumo sakaguchi-app || true
echo "health checkに失敗しました" >&2
exit 1
