-- Cada cliente conecta su propio número con SU PROPIA app de Meta (el cliente
-- pega su Access Token, Phone Number ID y Business Account ID desde su panel
-- de Meta for Developers — no existe una app central de Elorai). Por lo tanto
-- Meta firma cada entrega de webhook con el App Secret de LA APP DEL CLIENTE,
-- no con un secreto único de la plataforma. Un META_APP_SECRET global nunca
-- puede validar la firma de más de una cuenta a la vez.
--
-- Se guarda cifrado igual que wa_token_enc (misma clave ENCRYPTION_KEY).
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS wa_app_secret_enc text;
