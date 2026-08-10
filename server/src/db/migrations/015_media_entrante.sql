-- ============================================================================
-- Adjuntos que ENVÍAN los clientes (imágenes, audios, videos, documentos).
--
-- Hasta ahora del mensaje entrante solo se guardaba un texto de relleno
-- ("📷 Imagen"): el archivo real nunca se descargaba de Meta, así que en Chat
-- en Vivo no había nada que mostrar ni reproducir. `media_url` ya existía en
-- la tabla desde 001 pero nadie la escribía.
--
-- Las URLs que da Meta caducan y exigen el token de la cuenta, así que no
-- sirve guardarlas: el archivo se descarga y se guarda en nuestro
-- almacenamiento (el volumen de UPLOADS_DIR), y `media_url` pasa a contener
-- esa ruta interna — nunca se expone al navegador tal cual, se sirve por
-- /api/messages/:id/media, que comprueba la cuenta.
-- ============================================================================

ALTER TABLE messages
  -- image | video | audio | pdf — decide cómo se pinta la burbuja
  ADD COLUMN media_type text,
  -- mime real, para servir el archivo con el Content-Type correcto
  ADD COLUMN media_mime text,
  -- nombre original, solo relevante en documentos
  ADD COLUMN media_name text;
