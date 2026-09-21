-- Identity: merchants, users, refresh tokens.
--
-- Auth is built here rather than delegated to a hosted identity provider, per
-- the brief. A user belongs to exactly one merchant, OR is platform staff and
-- belongs to none. That constraint is enforced in the table, not just in code.

CREATE TABLE merchants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    slug       text        NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('merchant_user', 'platform_staff');

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL,
    password_hash text        NOT NULL,
    role          user_role   NOT NULL,
    merchant_id   uuid        REFERENCES merchants (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_merchant_matches_role CHECK (
        (role = 'merchant_user'  AND merchant_id IS NOT NULL) OR
        (role = 'platform_staff' AND merchant_id IS NULL)
    )
);

-- Email uniqueness is case-insensitive without needing the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_merchant_idx ON users (merchant_id);

-- Refresh tokens are stored as a SHA-256 digest: a database leak does not hand
-- the attacker usable tokens.
CREATE TABLE refresh_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash bytea       NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
