-- The changelog said YUGEN Remastered was used "with Garin's permission"; it was taken from his free public release on
-- the osu! forums (credited, not under an open licence). Same wording as the built-in history in js/pages.js.
update obv.changelog set content_md = replace(replace(content_md,
  'YUGEN Remastered (default, used with Garin''s permission)', 'YUGEN Remastered by Garin (from his free public release)'),
  'YUGEN Remastered becomes the default skin (with Garin''s permission)', 'YUGEN Remastered by Garin (from his free public release) becomes the default skin'),
  updated_at = now()
where content_md like '%Garin''s permission%';
