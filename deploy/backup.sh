#!/bin/sh
set -eu
umask 077

PROJECT_DIR=/opt/myqadam
BACKUP_DIR=/var/backups/myqadam
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

install -d -m 700 "$BACKUP_DIR"
cd "$PROJECT_DIR"

docker compose --env-file .env -f docker-compose.prod.yml exec -T db \
  pg_dump -U qadam -d qadam_lms | gzip -9 > "$BACKUP_DIR/database-$STAMP.sql.gz"

docker compose --env-file .env -f docker-compose.prod.yml run --rm --no-deps -T \
  -v "$BACKUP_DIR:/backup" app \
  sh -c "tar -czf /backup/uploads-$STAMP.tar.gz -C /app/uploads ."

find "$BACKUP_DIR" -type f -name '*.gz' -mtime +7 -delete
