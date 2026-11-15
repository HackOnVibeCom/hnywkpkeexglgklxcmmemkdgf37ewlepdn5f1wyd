// Runs the REAL, UNMODIFIED Edge Function entry point (supabase/functions/ai-match/index.ts) under Deno for the end-to-end test.
// The only thing this wrapper changes is WHICH PORT Deno.serve listens on (the Supabase runtime chooses its own); the function
// code, its imports (npm:@supabase/supabase-js, the shared modules) and its handler are exactly what would be deployed.
const originalServe = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handler: Deno.ServeHandler) => originalServe({ port: Number(Deno.env.get('E2E_PORT')), hostname: '127.0.0.1', onListen: () => console.log('E2E-LISTENING') }, handler);
await import('../../supabase/functions/ai-match/index.ts');
