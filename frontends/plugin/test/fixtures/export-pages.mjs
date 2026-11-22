// Pages and configs shared by the export golden test and the Studio paste
// tests. Everything here is made up: a synthetic site, a synthetic post id,
// and passages short enough to be excerpts of nothing.
export const READER = 'reader';
export const ORIGIN = 'https://blyg.example.org/';
export const POST_ID = '7c9wk2n4h6q1x8v0z3m5rjy2ke';
export const POST_PAGE = `${ORIGIN}t/${POST_ID}/`;
export const P1 = 'Attention is mostly a scheduling problem.';
export const P2 = 'The second claim is smaller.';

export const me = (text, extra = {}) => ({ author: READER, ts: text.slice(0, 8), text, ...extra });
export const bot = (text, author = 'claude', extra = {}) => ({ author, ts: 'b' + text.slice(0, 8), text, ...extra });

export const stamp = (extra = {}) => ({ status: 'blyg', origin: ORIGIN, id: POST_ID, version: 2, pinned: false,
  page: POST_PAGE, as_of: 'record', passage: { match: true }, ...extra });

export const webPage = (threads, chat = [], extra = {}) => ({
  url: 'https://news.example.com/story', title: 'A Story', site: 'news.example.com',
  threads, page_chat: chat, ...extra });

export const blygPage = (threads, chat = [], extra = {}) => ({
  url: POST_PAGE, title: 'On Scheduling', site: 'blyg.example.org',
  blyg: { status: 'blyg', checked: '2026-11-21T12:00:00.000Z', item: { origin: ORIGIN, id: POST_ID, kind: 'thread',
    version: 2, latest: 2, pinned: false, pinned_versions: [], page: POST_PAGE, pinned_page: '',
    json: `${ORIGIN}items/${POST_ID}.json`, source: 'Example Blyg', author: 'Some Author' } },
  export_response: 'not-a-response', threads, page_chat: chat, ...extra });

// a message the reader typed with one filled TK gap, as the companion stores it
export const gapped = (text, gapText, extra = {}) => ({
  ...me(text, { provenance: 'owner-typed' }),
  gaps: [{ instruction: 'say it shorter', mode: 'filled-by-agent', text: gapText, agent: 'claude',
    model: 'claude-test-1', at: '2026-11-21T10:00:00Z', ...extra }] });
