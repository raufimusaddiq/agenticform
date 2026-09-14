ALTER TABLE projects ADD COLUMN github_token_ciphertext TEXT;
ALTER TABLE execution_nodes ADD COLUMN encryption_public_key_base64 TEXT;
