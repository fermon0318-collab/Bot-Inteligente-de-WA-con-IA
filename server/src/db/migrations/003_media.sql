-- Datos que faltan para gestionar archivos de verdad
ALTER TABLE media_files
    ADD COLUMN mime_type       text NOT NULL DEFAULT '',
    ADD COLUMN wa_uploaded_at  timestamptz,
    ADD COLUMN checksum        text;

-- Meta caduca los media_id a los 30 días: hay que saber cuáles renovar
CREATE INDEX media_wa_expiry_idx ON media_files (wa_uploaded_at)
    WHERE wa_media_id IS NOT NULL;

-- Un mismo nombre dos veces en la misma cuenta rompe el envío por nombre
CREATE UNIQUE INDEX media_name_uniq ON media_files (account_id, name);
