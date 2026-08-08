-- Cousin Congress — D1 schema for the two private, non-replicated flows.
-- The chamber record itself is NOT here: it lives in each client's op log
-- and in the ChamberRoom Durable Object's storage.

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT 'petition',
  body        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  email         TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL
);
