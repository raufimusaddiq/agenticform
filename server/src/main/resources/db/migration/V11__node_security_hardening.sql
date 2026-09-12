CREATE TABLE node_request_nonces (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    nonce VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_node_request_nonce UNIQUE (node_id, nonce)
);

CREATE INDEX idx_node_request_nonces_expires_at ON node_request_nonces(expires_at);
