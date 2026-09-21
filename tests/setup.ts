/**
 * Runs before every test file, ahead of its imports.
 *
 * `npm test` should work with no database at all — the unit suites need none —
 * but src/config.ts validates the whole environment at import time and refuses
 * to boot without a DATABASE_URL. So: record whether a real one was supplied,
 * then give config a syntactically valid placeholder that is never connected
 * to. The integration suites skip themselves when the flag is not set.
 */
process.env['HAS_DATABASE'] = process.env['DATABASE_URL'] ? '1' : '';
process.env['DATABASE_URL'] ||= 'postgres://unused:unused@127.0.0.1:1/unused';
