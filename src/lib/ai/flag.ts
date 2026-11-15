// Build-time switch for the whole AI matching UI. A plain boolean, NOT a secret (it ships in the bundle by design).
// Default OFF: until VITE_AI_MATCHING=1 is set for a build, the app makes no AI calls at all and behaves exactly as
// before. This lets the UI be deployed independently of the database migration / Edge Function / OpenAI key.
export const AI_ENABLED: boolean = (import.meta.env.VITE_AI_MATCHING ?? '').toString().trim() === '1';
