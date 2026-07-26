#!/usr/bin/env bash
# ============================================================================
# Elorai · instalación y despliegue en Ubuntu 22.04 / 24.04
#
#   sudo bash deploy/deploy.sh elorai.io
#
# Es idempotente: puedes volver a ejecutarlo para desplegar cambios. Lo que ya
# está hecho se detecta y se salta.
# ============================================================================

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/var/www/elorai
ENV_FILE=/etc/elorai/elorai.env
REPO="${ELORAI_REPO:-https://github.com/fermon0318-collab/Bot-Inteligente-de-WA-con-IA.git}"
BRANCH="${ELORAI_BRANCH:-main}"
NODE_MAJOR=22

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta con sudo: sudo bash deploy/deploy.sh tu-dominio.com"
[[ -n "$DOMAIN" ]] || die "Falta el dominio: sudo bash deploy/deploy.sh elorai.io"

bold "Elorai → $DOMAIN"

# --- 1. Paquetes del sistema ------------------------------------------------
bold "1/8 · Paquetes del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg nginx postgresql \
                       certbot python3-certbot-nginx ufw >/dev/null
ok "nginx, PostgreSQL y certbot instalados"

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

# --- 2. Usuario del servicio -----------------------------------------------
bold "2/8 · Usuario del sistema"
if ! id elorai >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin elorai
  ok "usuario 'elorai' creado"
else
  ok "usuario 'elorai' ya existe"
fi

# --- 3. Base de datos -------------------------------------------------------
bold "3/8 · Base de datos"
systemctl enable --now postgresql >/dev/null 2>&1 || true

if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='elorai'\"" | grep -q 1; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  su postgres -c "psql -qc \"CREATE ROLE elorai LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
  su postgres -c "createdb -O elorai elorai" >/dev/null
  ok "base de datos 'elorai' creada"
  NEW_DB=1
else
  ok "base de datos ya existe"
  NEW_DB=0
fi

# --- 4. Código --------------------------------------------------------------
bold "4/8 · Código"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
  ok "actualizado desde origin/$BRANCH"
else
  mkdir -p "$APP_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
  ok "clonado en $APP_DIR"
fi

mkdir -p "$APP_DIR/uploads"
npm --prefix "$APP_DIR/server" ci --omit=dev --silent 2>/dev/null \
  || npm --prefix "$APP_DIR/server" install --omit=dev --silent
chown -R elorai:elorai "$APP_DIR"
ok "dependencias instaladas"

# --- 5. Variables de entorno ------------------------------------------------
bold "5/8 · Configuración"
mkdir -p /etc/elorai

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" "$ENV_FILE"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" "$ENV_FILE"
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" "$ENV_FILE"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$ENV_FILE"
  [[ "${NEW_DB}" == "1" ]] && \
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://elorai:${DB_PASSWORD}@127.0.0.1:5432/elorai|" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown root:elorai "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  warn "Completa las credenciales de Google y Stripe en $ENV_FILE y vuelve a ejecutar este script"
  PENDING_SECRETS=1
else
  ok "configuración existente conservada"
  PENDING_SECRETS=0
fi

if grep -qE '^(GOOGLE_CLIENT_ID|STRIPE_SECRET_KEY)=$' "$ENV_FILE"; then
  PENDING_SECRETS=1
fi

# --- 6. Migraciones ---------------------------------------------------------
bold "6/8 · Migraciones"
if [[ "$PENDING_SECRETS" == "1" ]]; then
  warn "omitidas: faltan credenciales en $ENV_FILE"
else
  ( set -a; . "$ENV_FILE"; set +a; npm --prefix "$APP_DIR/server" run migrate )
  ok "esquema al día"
fi

# --- 7. Servicio ------------------------------------------------------------
bold "7/8 · Servicio"
install -m 644 "$APP_DIR/deploy/elorai.service" /etc/systemd/system/elorai.service
systemctl daemon-reload
systemctl enable elorai >/dev/null 2>&1 || true

if [[ "$PENDING_SECRETS" == "1" ]]; then
  warn "servicio no iniciado: completa $ENV_FILE primero"
else
  systemctl restart elorai
  sleep 2
  if systemctl is-active --quiet elorai; then
    ok "elorai.service activo"
  else
    journalctl -u elorai -n 30 --no-pager
    die "el servicio no arrancó (registro arriba)"
  fi
fi

# --- 8. nginx y TLS ---------------------------------------------------------
bold "8/8 · nginx y certificado"
mkdir -p /var/www/certbot /etc/nginx/snippets
install -m 644 "$APP_DIR/deploy/elorai-proxy.conf" /etc/nginx/snippets/elorai-proxy.conf
install -m 644 "$APP_DIR/deploy/elorai-headers.conf" /etc/nginx/snippets/elorai-headers.conf

# La primera vez el certificado aún no existe y nginx no arrancaría con una
# ruta ssl_certificate inexistente: se emite antes, sirviendo por HTTP.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  cat > /etc/nginx/sites-available/elorai <<TEMP
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    root ${APP_DIR};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { try_files \$uri \$uri/ /index.html; }
}
TEMP
  ln -sf /etc/nginx/sites-available/elorai /etc/nginx/sites-enabled/elorai
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -d "www.${DOMAIN}" \
          --agree-tos --register-unsafely-without-email --non-interactive \
    || die "No se pudo emitir el certificado. Comprueba que $DOMAIN apunta a esta IP."
  ok "certificado emitido"
else
  ok "certificado ya presente"
fi

sed "s/DOMINIO/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/elorai

# En un servidor sin IPv6, `listen [::]` impide que nginx arranque. Se comentan
# esas líneas en lugar de dar por hecho que la pila está disponible.
if ! ip -6 addr show scope global 2>/dev/null | grep -q inet6; then
  sed -i 's|^\( *\)listen \[::\]|\1# listen [::]|' /etc/nginx/sites-available/elorai
  warn "sin IPv6 global: se desactivaron los listeners [::]"
fi

ln -sf /etc/nginx/sites-available/elorai /etc/nginx/sites-enabled/elorai
rm -f /etc/nginx/sites-enabled/default
nginx -t || die "configuración de nginx inválida"
systemctl reload nginx
ok "nginx recargado"

systemctl enable certbot.timer >/dev/null 2>&1 || true

# --- Cortafuegos ------------------------------------------------------------
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ok "cortafuegos: solo SSH, HTTP y HTTPS"

# --- Resumen ----------------------------------------------------------------
if [[ "$PENDING_SECRETS" == "1" ]]; then
  bold "Falta un paso"
  cat <<FIN

  Completa las credenciales en:  $ENV_FILE

    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
      → https://console.cloud.google.com/apis/credentials
      → URI de redirección autorizada:
        https://${DOMAIN}/auth/google/callback

    STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_*
      → https://dashboard.stripe.com/apikeys
      → endpoint del webhook:
        https://${DOMAIN}/api/billing/webhook

  Y vuelve a ejecutar:  sudo bash deploy/deploy.sh ${DOMAIN}

FIN
else
  bold "Listo"
  echo "  https://${DOMAIN}"
  echo
  echo "  Estado:    systemctl status elorai"
  echo "  Registro:  journalctl -u elorai -f"
  echo
fi
