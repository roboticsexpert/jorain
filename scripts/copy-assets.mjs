// Copies non-TS assets (SQL migrations) next to the compiled output.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
