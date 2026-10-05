// Starts the local Supabase stand-in (and the osu! API stand-in) for manual testing with the dev server:
//   node tests/emu/run-emu.mjs          -> Supabase stand-in on :54321, osu! stand-in on :54330
//   node scripts/dev-server.mjs 5174 tests/emu/dev.env
import { startSupabaseEmu } from "./supabase-emu.mjs";
import { startOsuMock } from "./osu-mock.mjs";
const emu = await startSupabaseEmu({ port: 54321 });
await startOsuMock(54330);
await emu.db.query("update obv.settings set value = '100' where key = 'max_projects_per_user'");
console.log("supabase stand-in on " + emu.url + ", osu! stand-in on http://127.0.0.1:54330");
