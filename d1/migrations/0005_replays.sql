create table if not exists replays (
  id text primary key,
  owner_id integer not null references users (osu_id) on delete cascade,
  sha256 text not null check (length(sha256) = 64),
  size integer not null check (size between 1 and 1048576),
  meta text not null default '{}' check (length(meta) <= 6144),
  data_b64 text not null,
  created_at text not null,
  expires_at text not null,
  unique (owner_id, sha256)
);
create index if not exists replays_expires_idx on replays (expires_at);
create index if not exists replays_owner_idx on replays (owner_id);
