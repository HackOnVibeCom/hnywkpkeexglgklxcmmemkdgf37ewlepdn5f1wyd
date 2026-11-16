-- CANCEL THE THREE DEMO CAMPAIGNS (created 2026-11-15 for the Customer Journey Video). NOT EXECUTED: run only when the owner says so.
--
-- Why SQL: the three demo campaigns belong to throw-away anonymous identities whose browser sessions ended with the test Chrome, so the
-- normal "Cancel & refund" button is unreachable. This calls the app's REAL function public.cancel_campaign() once per owner with
-- that owner's identity (the same function and checks the button uses): status -> 'cancelled', exactly 1 credit refunded to the
-- owner (at most once, idempotent), campaign leaves Discover. It refuses by itself if a tester holds a reservation right now
-- (campaign_not_found / "cannot be cancelled") - then simply retry in a few minutes. Nothing else is touched.
-- If nobody cancels them they expire by themselves on 2026-11-22 and the credit is refunded automatically (settle_expired_campaigns).
--
--   npx supabase db query --remote --yes --file docs/cancel-demo-campaigns.sql
-- (tested on real Postgres in supabase/tests/cancel_demo.mjs)
select set_config('request.jwt.claim.sub', '5abbb472-49d9-4920-a8d7-eada17396228', false);
select public.cancel_campaign('d2a47cc9-83e2-433d-ac52-09644fa3b30c') as api_console_demo;
select set_config('request.jwt.claim.sub', '7eb06d6f-0b37-458a-a395-d04f74e51c5c', false);
select public.cancel_campaign('54c9593c-93ee-4e6a-934d-87ea246fa9bf') as meal_planner_demo;
select set_config('request.jwt.claim.sub', '939c0dff-c08f-4f1e-9c07-a36dcdb025c7', false);
select public.cancel_campaign('66fcf7f4-7238-4701-a6e7-68073da0d42c') as invoice_inbox_demo;
select set_config('request.jwt.claim.sub', '', false);
-- verification (read-only): the three campaigns are 'cancelled', each owner balance is 1, ledger has one campaign_refund each
select c.status, p.credit_balance from public.campaigns c join public.profiles p on p.id = c.owner_id
 where c.id in ('d2a47cc9-83e2-433d-ac52-09644fa3b30c', '54c9593c-93ee-4e6a-934d-87ea246fa9bf', '66fcf7f4-7238-4701-a6e7-68073da0d42c');
