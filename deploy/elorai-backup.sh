#!/usr/bin/env bash
# ============================================================================
# Elorai · copia diaria de la base de datos y de los archivos subidos.
#
# Se instala en /usr/local/bin/elorai-backup.sh — ver deploy/README.md § 8.
# ============================================================================
set -euo pipefail

DESTINO=/var/backups/elorai
APP_DIR=/var/www/elorai
ENV_FILE=/etc/elorai/elorai.env
RETENCION_DIAS=30
FECHA=$(date +%F-%H%M)

mkdir -p "$DESTINO"

# Base de datos
sudo -u postgres pg_dump elorai | gzip > "$DESTINO/db-$FECHA.sql.gz"

# Archivos de los clientes
if [[ -d "$APP_DIR/uploads" ]]; then
  tar czf "$DESTINO/uploads-$FECHA.tar.gz" -C "$APP_DIR" uploads
fi

# Configuración: contiene ENCRYPTION_KEY, sin la cual el dump no sirve de nada
cp "$ENV_FILE" "$DESTINO/env-$FECHA.bak"
chmod 600 "$DESTINO/env-$FECHA.bak"

# Fuera del servidor: sin esto, un disco corrupto se lleva la copia con todo
# lo demás. Requiere `rclone config` hecho una vez — ver deploy/README.md.
if command -v rclone >/dev/null && rclone listremotes | grep -q .; then
  REMOTO=$(rclone listremotes | head -1)
  rclone copy "$DESTINO" "${REMOTO}elorai-backups" --max-age 24h --quiet
fi

# Limpieza local — el remoto administra su propia retención
find "$DESTINO" -type f -mtime "+$RETENCION_DIAS" -delete

echo "$(date -Is) copia completada: $(du -sh "$DESTINO" | cut -f1)"
