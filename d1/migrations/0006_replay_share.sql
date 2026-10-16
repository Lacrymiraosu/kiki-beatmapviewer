alter table replays add column share_key text check (share_key is null or (length(share_key) = 32 and share_key not glob '*[^A-Za-z0-9_-]*'));
create unique index if not exists replays_share_key_idx on replays (share_key) where share_key is not null;
