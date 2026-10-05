# Contributing

Thanks for helping.

- The project is released under GPL-3.0. By sending a pull request you agree your contribution is released under it too.
- No build step: edit a file and reload. See the README for running locally and for the tests.
- Before opening a pull request, run `bash scripts/check-syntax.sh` and `npm --prefix tests test`. CI runs both
  on every pull request and must pass.
- New visible text goes through `tr()` and needs an entry in every `i18n/*.json` file (`""` = not translated yet).
- Never commit secrets, `.env*` files, a real `wrangler.jsonc`, tokens or personal data. The secret-scan check must pass.
- Do not add third-party code or assets without a compatible licence and an entry in `THIRD_PARTY_NOTICES.txt`.
