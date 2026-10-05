-- The animated invitation is off unless a person turns it on for their links (Invite friends page → "Invitation
-- effect"). Everyone starts with it off, including accounts from before this change. Run once, after invite_fx.
alter table obv.users alter column invite_fx set default false;
update obv.users set invite_fx = false where invite_fx;
