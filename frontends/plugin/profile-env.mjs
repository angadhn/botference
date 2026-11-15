// Imported FIRST by server.mjs, so the active profile's dirs are in
// process.env before any module reads them at load time (store.mjs's DIR,
// keys.mjs's key file, the work dir). See shared/profiles.mjs.
import { applyActiveProfile } from '../shared/profiles.mjs';

export const PROFILE = applyActiveProfile('discuss');
