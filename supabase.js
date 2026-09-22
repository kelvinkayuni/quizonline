import { createClient } from '@supabase/supabase-js';

if (!__SUPABASE_URL__ || !__SUPABASE_ANON_KEY__) {
	throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variable.');
}

export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__);
