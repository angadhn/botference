// Where anything secret lives on this machine: one directory, one answer,
// for every frontend. ~/.botference unless BOTFERENCE_SECRETS_DIR says
// otherwise (which is how the test suites keep their hands off the real one).
//
// This used to be a line inside the plugin's identity.mjs. It moved here the
// day a second frontend (the council web server) needed the same directory:
// two definitions of "where the secrets are" is how one product writes a key
// the other cannot find.
import os from 'node:os';
import path from 'node:path';

export const secretsDir = () =>
  process.env.BOTFERENCE_SECRETS_DIR || path.join(os.homedir(), '.botference');
