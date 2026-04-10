import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://xtndwkczzowmuarjjmzq.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0bmR3a2N6em93bXVhcmpqbXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NjQ4ODYsImV4cCI6MjA5MTM0MDg4Nn0.gi75Tn_ilxe01RXzy6_x2czUCqrd2duPe1C22Mg_blY';

export const supabase = createClient(supabaseUrl, supabaseKey);
