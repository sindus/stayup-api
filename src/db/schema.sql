-- Tables from stayup-cmd-changelog
CREATE TABLE IF NOT EXISTS repository (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connector_changelog (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES repository(id),
  version TEXT,
  content TEXT NOT NULL,
  diff TEXT,
  datetime TIMESTAMPTZ,
  executed_at TIMESTAMPTZ NOT NULL,
  success BOOLEAN NOT NULL
);

-- Tables from stayup-cmd-youtube
CREATE TABLE IF NOT EXISTS profile (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connector_youtube (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES profile(id),
  version TEXT,
  content TEXT NOT NULL,
  diff TEXT,
  datetime TIMESTAMPTZ,
  executed_at TIMESTAMPTZ NOT NULL,
  success BOOLEAN NOT NULL
);

-- Unified log table
CREATE TABLE IF NOT EXISTS log (
  id SERIAL PRIMARY KEY,
  repository_id INTEGER REFERENCES repository(id),
  profile_id INTEGER REFERENCES profile(id),
  error TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL
);
