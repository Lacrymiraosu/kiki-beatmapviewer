[← Documentation](README.md) · [Project README](../README.md)

# Setting up the osu! login (OAuth)

The osu! login is needed for live sessions and the online features (Save online, sharing, annotations, admin); everything else works without it.

1. Go to https://osu.ppy.sh/home/account/edit → **OAuth** → **New OAuth Application**
2. Give it a name and set the **Application Callback URL** to
   ```
   https://<your-domain>/api/auth/callback
   ```
3. You get a **Client ID** and a **Client Secret**
4. Put them in the server's [environment variables](environment-variables.md). **Never put the Client Secret in the code or commit it.**

How it works:

- Only the `identify` scope is requested (user ID, username, avatar, country)
- The osu! access token is used once to read the profile and then discarded
- Logins are kept with an HttpOnly cookie `obv_s` (30 days), HMAC-signed with a key derived from the Client Secret
- `/api/auth/me` returns a 4-hour `ticket` that proves who you are to others in a live session (checked with `/api/auth/verify`)
- Resetting the Client Secret logs everyone out
