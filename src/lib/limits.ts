/**
 * Anti-abuse / lifecycle constants — DISPLAY ONLY.
 * The database is the source of truth and enforces every one of these
 * (supabase/migrations/20261114000100_lifecycle_antiabuse.sql). If you change a value there,
 * change it here so the copy shown to users stays honest.
 */
export const CAMPAIGN_EXPIRY_DAYS = 7;
export const RESERVATION_MINUTES = 15;
export const MIN_TEST_SECONDS = 60;
export const DAILY_REWARD_CAP = 5;
