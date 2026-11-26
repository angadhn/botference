// Posts WITHOUT a /quote marker line, as the note writer built them before the marker existed. Their output is kept in
// quotemark-golden.json (written by the note writer of the commit before the marker) and must stay byte for byte the same.
// Some hold the letters /quote where they are NOT a marker: in a sentence, in code, in an agent's passage or its instruction.
export const NOW = new Date('2026-11-23T12:00:00Z');
export const ID = '0123456789abcdefghjkmnpqrs';
export const ORIGIN = 'https://blyg.example.test/notes/';
export const POST = `${ORIGIN}t/${ID}/`;
export const BID = '0000000000000000000000000z';
export const HOME = { template: 'title: ${title}\n' + 'created: ${created}\nreleased: "${released}"\nblyg: true\nblyg_id: "${id}"\npermalink: /b/${id}\n${blyg_keys}\n', escape: 'liquid', timezone: 'Europe/London' };
const mine = (text, ts = '2026-11-22T10:00:00Z', extra = {}) => ({ author: 'owner', ts, text, provenance: 'owner-typed', ...extra });
const stamp = { status: 'blyg', id: ID, version: 2, origin: ORIGIN, page: POST, passage: { match: true } };
const blygPage = threads => ({ url: POST, title: 'A made-up post', blyg: { status: 'blyg', item: { origin: ORIGIN, id: ID, version: 2, page: POST } }, threads });
const webPage = (threads, extra = {}) => ({ url: 'https://news.example.test/a/story?id=7', title: 'A story', threads, ...extra });
const gap = (instruction, text) => ({ instruction, mode: 'filled-by-agent', agent: 'claude', model: 'm', text });
export const CASES = {
  'blyg one comment': blygPage([{ id: 't1', quote: 'A sentence that the post really says.', blyg: stamp, msgs: [mine('I agree.')] }]),
  'blyg three comments': blygPage([{ id: 't1', quote: 'A sentence that the post really says.', blyg: stamp,
    msgs: [mine('First.'), mine('Second.', '2026-11-22T10:01:00Z'), mine('Third.', '2026-11-22T10:02:00Z')] }]),
  'web page, url card': webPage([{ id: 't1', quote: 'Hiring is slowing.\nFor juniors.', msgs: [mine('This matches.\n\nAnd more.')] }]),
  'web response': webPage([{ id: 't1', quote: 'Hiring is slowing.', msgs: [mine('A reply.')] }], { export_response: 'response' }),
  'no quote': webPage([{ id: 't1', quote: '', msgs: [mine('Only my words.')] }]),
  'two threads (add to an earlier post)': webPage([{ id: 't1', quote: 'One.', msgs: [mine('About one.')] },
    { id: 't2', quote: 'Two.', msgs: [mine('About two.', '2026-11-22T11:00:00Z')] }]),
  'the letters in a sentence': webPage([{ id: 't1', quote: 'Q.', msgs: [mine('Type /quote to move it.\n/quote it\nnot /quote')] }]),
  'in code': webPage([{ id: 't1', quote: 'Q.', msgs: [mine('Before\n\n```\n/quote\n```\n\nAfter `/quote`\n\n    x')] }]),
  'in an agent passage': webPage([{ id: 't1', quote: 'Q.', msgs: [{ ...mine('Mine.\n/tk write /quote\nAfter.'), gaps: [gap('write /quote', 'Agent line.\n/quote\nMore agent.')] }] }]),
  'inline agent passage': webPage([{ id: 't1', quote: 'Q.', msgs: [{ ...mine('A /tk(go) b'), gaps: [gap('go', '/quote')] }] }]),
  'an earlier post': webPage([{ id: 't1', quote: 'Q.', msgs: [mine('Words.')] }]),
};
export const EXTRA = { 'an earlier post': { earlier: { title: 'Before', link: '/b/before' } } };
