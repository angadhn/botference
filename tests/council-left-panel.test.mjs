// The web council's left panel: two pills (Chats / Projects), flat lists, one
// "more" menu per row, a search box, Settings at the foot.
//
// What the panel shows, what one row is doing and whether the panel is out
// are three named modes: one list, one field and one setter each, with a pure
// rule for the moves. These tests hold that shape, and the taps a person
// makes. Everything here is made up: no real chat, project or page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(HOME, 'frontends', 'council', 'assets');
const HAPPY = fs.existsSync(path.join(HOME, 'tests', 'node_modules', 'happy-dom'));
const dom = { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' };

// a fresh page with the network stubbed out; width 390 is a phone
async function mkPanel(t, { width = 390, fetchJson = null } = {}) {
  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  const w = new GlobalWindow({ url: 'http://localhost/', width, height: 844 });
  t.after(() => w.happyDOM.close());
  const doc = w.document;
  const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
  doc.write(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''));
  const posts = [];
  const gets = [];
  w.fetch = async (url, opts) => {
    if (opts && opts.body) posts.push({ url, body: JSON.parse(opts.body) });
    else gets.push(String(url));
    const made = fetchJson ? fetchJson(String(url), opts && opts.body ? JSON.parse(opts.body) : null) : null;
    return { ok: true, status: 200, json: async () => made || { ok: true } };
  };
  w.EventSource = class { constructor() { } close() { } };
  const wsUrls = [];
  w.WebSocket = class { constructor(url) { wsUrls.push(url); } close() { } send() { } };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ASSETS, 'app.js'), 'utf8'), w);
  const C = w.__council;
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const list = doc.getElementById('projects');
  const $ = sel => doc.querySelector(sel);
  const click = sel => { const el = $(sel); assert.ok(el, `there is a ${sel} to click`); el.click(); return el; };
  const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const type = (el, text) => { el.value = text; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
  return { w, doc, C, posts, gets, wsUrls, list, $, click, key, type, tick };
}
// only what was typed for the reader: the harness records every POST
const sent = posts => posts.filter(p => p.url === '/input').map(p => p.body.text);
// what the panel asked for on its own path (the tab's bridge id left out)
const asked = posts => posts.filter(p => p.url === '/panel').map(p => {
  const { bridge, ...rest } = p.body;
  return rest;
});
const rowsOf = list => [...list.querySelectorAll('.lp-row .t')].map(b => b.textContent.trim());

const NOW = Date.now();
const ago = h => new Date(NOW - h * 3600 * 1000).toISOString();
// four loose chats and three projects (one archived); nothing is open
const SNAP = (open = '') => ({
  type: 'projects', active_project_id: '', inbox_session_count: 4,
  inbox_sessions: [
    { session_id: 'loose001', title: 'Tea kettle notes', updated_at: ago(1), active: open === 'loose001' },
    { session_id: 'loose002', title: 'Packing list', updated_at: ago(5), active: open === 'loose002' },
    { session_id: 'loose003', title: 'A very long title about choosing a name for the garden shed door', updated_at: ago(30), active: false },
    { session_id: 'loose004', title: 'Bread timings', updated_at: ago(200), active: false },
  ],
  projects: [
    { id: 'orbit', title: 'Orbit notes book', status: 'active', active: open === 'orb00001', session_count: 2,
      sessions: [
        { session_id: 'orb00001', title: 'Chapter two outline', updated_at: ago(2), active: open === 'orb00001' },
        { session_id: 'orb00002', title: 'Kettle of fish', updated_at: ago(50), active: false },
      ] },
    { id: 'garden', title: 'Garden plan', status: 'active', active: false, session_count: 1,
      sessions: [{ session_id: 'gar00001', title: 'Seed order', updated_at: ago(3), active: false }] },
    { id: 'attic', title: 'Attic clear-out', status: 'archived', active: false, session_count: 1,
      sessions: [{ session_id: 'att00001', title: 'Box labels', updated_at: ago(900), active: false }] },
  ],
});

// ── the three named modes: pure rules ───────────────────────────────────────
test('panel view: one list, one pure rule for the moves', dom, async t => {
  const { C } = await mkPanel(t);
  assert.deepEqual([...C.PANEL_VIEWS], ['chats', 'projects', 'inside-project', 'search']);
  assert.ok(Object.isFrozen(C.PANEL_VIEWS));
  const chats = { view: 'chats' }, projects = { view: 'projects' };
  const inA = { view: 'inside-project', pid: 'a' }, inB = { view: 'inside-project', pid: 'b' };
  const s1 = { view: 'search', query: '' }, s2 = { view: 'search', query: 'ke' };
  for (const [from, to, ok] of [
    [chats, projects, true], [projects, chats, true], [projects, inA, true], [inA, projects, true],
    [inA, inB, true], [chats, s1, true], [s1, s2, true], [s2, chats, true], [s2, inA, true],
    [chats, chats, false], [projects, projects, false], [inA, inA, false], [s1, s1, false],
    [projects, { view: 'inside-project' }, false],        // inside which project?
    [chats, { view: 'search' }, false],                   // a search has words, even if none yet
    [chats, { view: 'recent' }, false], [{ view: 'recent' }, chats, false],
    [null, chats, false], [chats, null, false],
  ]) assert.equal(C.panelViewMove(from, to), ok, `${JSON.stringify(from)} > ${JSON.stringify(to)}`);
});

test('row: one list, one field for the whole panel, one pure rule', dom, async t => {
  const { C } = await mkPanel(t);
  assert.deepEqual([...C.ROW_MODES],
    ['resting', 'menu', 'moving', 'renaming', 'confirming-delete', 'naming-new-project']);
  assert.ok(Object.isFrozen(C.ROW_MODES));
  const r = (mode, key = '') => ({ mode, key });
  for (const [from, to, ok] of [
    [r('resting'), r('menu', 'chat:a'), true],
    [r('resting'), r('naming-new-project', 'new-project'), true],
    [r('menu', 'chat:a'), r('menu', 'chat:b'), true],           // another row's menu takes over
    [r('menu', 'chat:a'), r('menu', 'chat:a'), false],
    [r('menu', 'chat:a'), r('moving', 'chat:a'), true],
    [r('menu', 'chat:a'), r('renaming', 'chat:a'), true],
    [r('menu', 'chat:a'), r('confirming-delete', 'chat:a'), true],
    [r('menu', 'chat:a'), r('moving', 'chat:b'), false],        // a step on stays with its row
    [r('moving', 'chat:a'), r('naming-new-project', 'chat:a'), true],
    [r('moving', 'chat:a'), r('naming-new-project', 'chat:b'), false],
    [r('resting'), r('moving', 'chat:a'), false],               // only by way of the menu
    [r('resting'), r('renaming', 'chat:a'), false],
    [r('resting'), r('confirming-delete', 'chat:a'), false],
    [r('renaming', 'chat:a'), r('moving', 'chat:a'), false],
    [r('resting'), r('menu'), false],                           // whose menu?
    [r('resting'), r('resting'), false],
    [r('menu', 'chat:a'), r('resting', 'chat:a'), false],       // resting is nobody's
    [r('resting'), r('open', 'chat:a'), false],
  ]) assert.equal(C.rowMove(from, to), ok, `${JSON.stringify(from)} > ${JSON.stringify(to)}`);
  for (const m of C.ROW_MODES) {
    if (m !== 'resting') assert.equal(C.rowMove(r(m, 'chat:a'), r('resting')), true, `${m} > resting`);
  }
});

test('slide-out and the file list: two more lists with pure rules', dom, async t => {
  const { C } = await mkPanel(t);
  assert.deepEqual([...C.SLIDE_MODES], ['open', 'closed']);
  assert.equal(C.slideMove('closed', 'open'), true);
  assert.equal(C.slideMove('open', 'closed'), true);
  assert.equal(C.slideMove('open', 'open'), false);
  assert.equal(C.slideMove('closed', 'half'), false);
  assert.deepEqual([...C.CONTENTS_LOADS], ['loading', 'ready', 'failed']);
  assert.equal(C.contentsMove(null, 'loading'), true);
  assert.equal(C.contentsMove('loading', 'ready'), true);
  assert.equal(C.contentsMove('loading', 'failed'), true);
  assert.equal(C.contentsMove('failed', 'loading'), true, 'a failed read is tried again');
  assert.equal(C.contentsMove('ready', 'loading'), false, 'read once per tab');
  assert.equal(C.contentsMove(null, 'ready'), false);
});

test('the setters refuse an illegal move, and the old on/off flags are gone', dom, async t => {
  const { C } = await mkPanel(t);
  C.handle(SNAP());
  for (const gone of ['openProjects', 'openContents', 'lastActivePid', 'menuKey', 'archOpen', 'filingAsked']) {
    assert.equal(gone in C.state, false, `state.${gone} is gone`);
  }
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
  assert.equal(C.setPanelView('chats'), false, 'already there');
  assert.equal(C.setPanelView('inside-project', { pid: 'nowhere' }), false, 'no such project');
  assert.equal(C.setPanelView('inside-project', {}), false);
  assert.equal(C.setPanelView('everything'), false);
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
  assert.equal(C.setPanelView('inside-project', { pid: 'orbit' }), true);
  assert.ok(Object.isFrozen(C.state.panel));

  assert.deepEqual({ ...C.state.row }, { mode: 'resting', key: '' });
  assert.equal(C.setRowMode('renaming', 'chat:orb00001'), false, 'only by way of the menu');
  assert.equal(C.setRowMode('menu', 'chat:orb00001'), true);
  assert.equal(C.setRowMode('menu', 'chat:orb00002'), true, 'the second menu replaces the first');
  assert.deepEqual({ ...C.state.row }, { mode: 'menu', key: 'chat:orb00002' });
  assert.equal(C.setRowMode('moving', 'chat:orb00001'), false);
  assert.equal(C.setRowMode('moving', 'chat:orb00002'), true);
  assert.equal(C.setRowMode('resting'), true);
  assert.equal(C.setRowMode('resting'), false);

  assert.equal(C.state.slideOut, 'closed', 'a phone starts with the panel away');
  assert.equal(C.setSlideOut('closed'), false);
  assert.equal(C.setSlideOut('ajar'), false);
  assert.equal(C.setSlideOut('open'), true);
});

// ── the two pills ───────────────────────────────────────────────────────────
test('Chats lists the chats filed nowhere; a filed chat lives only under Projects', dom, async t => {
  const { C, list, $, click } = await mkPanel(t);
  assert.match(list.textContent, /Loading/);
  C.handle(SNAP());
  assert.deepEqual(rowsOf(list), ['Tea kettle notes', 'Packing list',
    'A very long title about choosing a name for the garden shed door', 'Bread timings']);
  assert.ok($('#panel-pills [data-pill="chats"]').classList.contains('on'));
  assert.equal($('#panel-pills [data-pill="projects"]').classList.contains('on'), false);
  // none of the old furniture
  assert.doesNotMatch(list.textContent, /Recent|Inbox|contents|archive project/i);
  assert.equal(list.querySelector('h2'), null, 'no section headings');
  assert.equal($('#new-project'), null);
  assert.equal($('#new-chat-menu'), null);

  click('#panel-pills [data-pill="projects"]');
  assert.deepEqual({ ...C.state.panel }, { view: 'projects' });
  assert.ok($('#panel-pills [data-pill="projects"]').classList.contains('on'));
  const projs = [...list.querySelectorAll('.lp-proj')];
  assert.deepEqual(projs.map(p => p.querySelector('b').textContent), ['Orbit notes book', 'Garden plan', 'Attic clear-out']);
  assert.match(projs[0].textContent, /2 chats · 2h ago/);
  assert.match(projs[1].textContent, /1 chat · 3h ago/);
  assert.equal(rowsOf(list).length, 0, 'one level deep: no chats in the list of projects');
  // archived projects sit below, under their own small label
  assert.match(list.querySelector('.lp-label').textContent, /Archived/);
  assert.ok(projs[2].classList.contains('muted'));

  click('.lp-proj[data-pid="orbit"]');
  assert.deepEqual({ ...C.state.panel }, { view: 'inside-project', pid: 'orbit' });
  assert.deepEqual(rowsOf(list), ['Chapter two outline', 'Kettle of fish']);
  assert.equal(list.querySelector('.lp-ptitle b').textContent, 'Orbit notes book');
  assert.ok($('#panel-pills [data-pill="projects"]').classList.contains('on'), 'still under Projects');
  click('.lp-back');
  assert.deepEqual({ ...C.state.panel }, { view: 'projects' });
  click('#panel-pills [data-pill="chats"]');
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
});

test('an older-chats note says how many are not listed', dom, async t => {
  const { C, list } = await mkPanel(t);
  C.handle({ ...SNAP(), inbox_session_count: 130 });
  assert.match(list.textContent, /126 older chats not shown/);
});

test('the panel opens where the open chat lives, once per chat', dom, async t => {
  const { C, list, click, wsUrls, tick } = await mkPanel(t);
  C.handle(SNAP('orb00001'));
  assert.deepEqual({ ...C.state.panel }, { view: 'inside-project', pid: 'orbit' });
  assert.ok(list.querySelector('.lp-row.active [data-sid="orb00001"]'));
  // browsing away is not undone by the next list that arrives
  click('#panel-pills [data-pill="chats"]');
  C.handle(SNAP('orb00001'));
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
  // opening a loose chat: the tab moves to it, and the panel shows Chats
  click('#panel-pills [data-pill="projects"]');
  click('#panel-pills [data-pill="chats"]');
  click('.lp-row [data-act="open"][data-sid="loose002"]');
  await tick();
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=loose002$/);
  C.setAttachMode('open');
  C.handle(SNAP('loose002'));
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
  // a project that goes away while it is on screen: back to the list
  C.setPanelView('inside-project', { pid: 'garden' });
  const without = SNAP('loose002');
  without.projects = without.projects.filter(p => p.id !== 'garden');
  C.handle(without);
  assert.deepEqual({ ...C.state.panel }, { view: 'projects' });
  assert.deepEqual({ ...C.homeView(SNAP(), 'gar00001') }, { view: 'inside-project', pid: 'garden' });
  assert.deepEqual({ ...C.homeView(SNAP(), 'loose001') }, { view: 'chats' });
  assert.deepEqual({ ...C.homeView(null, '') }, { view: 'chats' });
});

// ── one way to start a chat ─────────────────────────────────────────────────
test('New chat is one button; inside a project it says so and files the chat there', dom, async t => {
  const { C, $, click, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  assert.equal($('#new-chat-label').textContent, 'New chat');
  click('#new-chat');
  await tick();
  assert.deepEqual(sent(posts), ['/new --inbox'], 'one tap, and nobody is asked where it goes');
  C.setPanelView('inside-project', { pid: 'orbit' });
  assert.equal($('#new-chat-label').textContent, 'New chat in Orbit notes book');
  click('#new-chat');
  await tick();
  assert.deepEqual(sent(posts), ['/new --inbox', '/new --project orbit']);
  // an archived project takes no new chats
  C.setPanelView('inside-project', { pid: 'attic' });
  assert.equal($('#new-chat-label').textContent, 'New chat');
  click('#new-chat');
  await tick();
  assert.equal(sent(posts)[2], '/new --inbox');
});

test('the first message just goes: no "where should this go?" card', dom, async t => {
  const { C, doc, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  doc.getElementById('input').value = 'hello there';
  C.submit();
  await tick();
  assert.equal(doc.querySelector('.msg.card.filing'), null);
  assert.deepEqual(sent(posts), ['hello there']);
});

// ── search ──────────────────────────────────────────────────────────────────
test('search: the latest chats from everywhere, then titles as you type', dom, async t => {
  const { C, list, $, click, type, key, wsUrls, tick } = await mkPanel(t);
  C.handle(SNAP());
  const box = $('#panel-search');
  box.focus();
  assert.equal(C.state.panel.view, 'search');
  assert.match(list.querySelector('.lp-label').textContent, /Latest chats/);
  assert.deepEqual(rowsOf(list).slice(0, 4),
    ['Tea kettle notes', 'Chapter two outline', 'Seed order', 'Packing list'], 'newest first, from everywhere');
  assert.equal(list.querySelector('.lp-row [data-sid="orb00001"]').parentElement.querySelector('.lp-tag').textContent,
    'Orbit notes book', 'a filed chat says which project');
  assert.equal($('#panel-pills .on'), null, 'neither pill is lit while searching');
  assert.equal($('#panel-search-x').hasAttribute('hidden'), false);

  type(box, 'KETTLE');
  assert.deepEqual({ view: C.state.panel.view, query: C.state.panel.query }, { view: 'search', query: 'KETTLE' });
  assert.deepEqual(rowsOf(list), ['Tea kettle notes', 'Kettle of fish']);
  assert.match(list.querySelector('.lp-label').textContent, /2 chats found/);
  type(box, 'box');
  assert.deepEqual(rowsOf(list), ['Box labels'], 'archived projects are searched too');
  type(box, 'zzz');
  assert.match(list.textContent, /No chat is called anything like “zzz”/);
  assert.deepEqual([...C.searchRows('seed')].map(c => c.s.session_id), ['gar00001']);

  // the cross puts back the list that was there before
  click('#panel-search-x');
  assert.deepEqual({ ...C.state.panel }, { view: 'chats' });
  assert.equal(box.value, '');
  // …and so does Escape, from inside a project
  C.setPanelView('inside-project', { pid: 'garden' });
  box.focus();
  type(box, 'pack');
  key(box, 'Escape');
  assert.deepEqual({ ...C.state.panel }, { view: 'inside-project', pid: 'garden' });
  // picking a result opens it and shows where it lives
  box.focus();
  type(box, 'chapter');
  click('.lp-row [data-act="open"][data-sid="orb00001"]');
  await tick();
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=orb00001$/);
  assert.deepEqual({ ...C.state.panel }, { view: 'inside-project', pid: 'orbit' });
  // a pill leaves the search as well
  box.focus();
  click('#panel-pills [data-pill="projects"]');
  assert.deepEqual({ ...C.state.panel }, { view: 'projects' });
});

// ── the row's one menu ──────────────────────────────────────────────────────
test('only one row is ever busy; a tap elsewhere puts it to rest', dom, async t => {
  const { C, doc, list, click } = await mkPanel(t);
  C.handle(SNAP());
  click('.more[data-key="chat:loose001"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'menu', key: 'chat:loose001' });
  assert.equal(list.querySelectorAll('.lp-menu').length, 1);
  assert.deepEqual([...list.querySelectorAll('.lp-menu [role="menuitem"]')].map(b => b.textContent.trim()),
    ['Rename', 'Move to project…', 'Archive', 'Delete…'], 'every chat, open or not, has the same four');
  click('.more[data-key="chat:loose002"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'menu', key: 'chat:loose002' });
  assert.equal(list.querySelectorAll('.lp-menu').length, 1, 'the first menu closed');
  assert.ok(list.querySelector('.lp-row[data-key="chat:loose002"]').classList.contains('has-menu'));
  // the same button closes it
  click('.more[data-key="chat:loose002"]');
  assert.equal(C.state.row.mode, 'resting');
  // a tap outside the panel
  click('.more[data-key="chat:loose003"]');
  doc.getElementById('input').click();
  assert.equal(C.state.row.mode, 'resting');
  // Escape
  click('.more[data-key="chat:loose003"]');
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(C.state.row.mode, 'resting');
  // a list that no longer has the chat
  click('.more[data-key="chat:loose004"]');
  const without = SNAP();
  without.inbox_sessions = without.inbox_sessions.filter(s => s.session_id !== 'loose004');
  C.handle(without);
  assert.equal(C.state.row.mode, 'resting');
  // changing list
  click('.more[data-key="chat:loose001"]');
  click('#panel-pills [data-pill="projects"]');
  assert.equal(C.state.row.mode, 'resting');
});

test('Move to project: pick from the list; the note says where it went and offers Undo', dom, async t => {
  const { C, list, $, click, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  C.setSlideOut('open');
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="move"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'moving', key: 'chat:loose002' });
  assert.match(list.querySelector('.lp-menu-label').textContent, /Move to/);
  const choices = [...list.querySelectorAll('.lp-menu [data-act="move-to"]')];
  assert.deepEqual(choices.map(b => b.textContent.trim()), ['Orbit notes book', 'Garden plan', 'No project'],
    'live projects only, then "No project"');
  assert.ok(choices[2].classList.contains('here'), 'where it is now is ticked');
  assert.match(list.querySelector('.lp-menu [data-act="move-new"]').textContent, /New project…/);
  choices[1].click();
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'move', sid: 'loose002', project: 'garden' }]);
  assert.equal(posts[0].body.bridge, 'b1', 'the request names this tab');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(C.state.slideOut, 'open', 'the panel stays, so the note can be read');
  const note = $('#panel-note');
  assert.equal(note.hasAttribute('hidden'), false);
  assert.match(note.textContent, /Moved to Garden plan\./);
  assert.doesNotMatch(note.textContent, /\//, 'a note never names a command');
  click('#panel-note [data-act="undo"]');
  await tick();
  assert.deepEqual(asked(posts)[1], { action: 'move', sid: 'loose002', project: '' });
  assert.match(note.textContent, /Undone\./);
  assert.equal(note.querySelector('[data-act="undo"]'), null);

  // out of a project: "No project", and the project it is in is ticked
  C.setPanelView('inside-project', { pid: 'orbit' });
  click('.more[data-key="chat:orb00002"]');
  click('.lp-menu [data-act="move"]');
  assert.ok(list.querySelector('.lp-menu [data-pid="orbit"]').classList.contains('here'));
  // picking where it already is does nothing
  click('.lp-menu [data-pid="orbit"]');
  await tick();
  assert.equal(asked(posts).length, 2);
  click('.more[data-key="chat:orb00002"]');
  click('.lp-menu [data-act="move"]');
  click('.lp-menu [data-act="move-to"][data-pid=""]');
  await tick();
  assert.deepEqual(asked(posts)[2], { action: 'move', sid: 'orb00002', project: '' });
  assert.match(note.textContent, /Moved to Chats\./);
  assert.equal(sent(posts).length, 0, 'nothing was typed into the open chat');
});

test('the note is one field with one setter; its timer only clears it', dom, async t => {
  const { C, $ } = await mkPanel(t);
  C.handle(SNAP());
  assert.equal(C.state.panelNote, null);
  C.setPanelNote({ text: 'Moved to Garden plan.', undo: { action: 'move', args: { sid: 'x', pid: '' } } });
  assert.ok(Object.isFrozen(C.state.panelNote));
  assert.equal($('#panel-note').hasAttribute('hidden'), false);
  C.setPanelNote(null);
  assert.equal(C.state.panelNote, null);
  assert.equal($('#panel-note').hasAttribute('hidden'), true);
  C.setPanelNote({ text: '' });
  assert.equal(C.state.panelNote, null, 'a note with nothing to say is no note');
});

test('Archive from the row, with Undo', dom, async t => {
  const { C, $, click, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  click('.more[data-key="chat:loose004"]');
  click('.lp-menu [data-act="archive"]');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'archive', sid: 'loose004' }]);
  assert.match($('#panel-note').textContent, /Archived\./);
  click('#panel-note [data-act="undo"]');
  await tick();
  assert.deepEqual(asked(posts)[1], { action: 'unarchive', sid: 'loose004' });
  assert.equal(sent(posts).length, 0);
});

test('New project: a text box in the list; typed words survive a redraw', dom, async t => {
  const { C, list, click, key, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  click('#panel-pills [data-pill="projects"]');
  click('.lp-quiet[data-act="new-project"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'naming-new-project', key: 'new-project' });
  let box = list.querySelector('.lp-input');
  assert.ok(box, 'the row became a text box');
  box.value = 'Shed rebu';
  C.handle(SNAP());                        // a list arrives mid-typing
  box = list.querySelector('.lp-input');
  assert.equal(box.value, 'Shed rebu', 'nothing typed is lost');
  // Escape throws the box away without sending anything
  key(box, 'Escape');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(posts.length, 0);
  // Enter makes the project
  click('.lp-quiet[data-act="new-project"]');
  box = list.querySelector('.lp-input');
  box.value = '  Shed   rebuild ';
  key(box, 'Enter');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'new-project', title: 'Shed rebuild' }]);
  assert.equal(C.state.row.mode, 'resting');
  // an empty name makes nothing
  click('.lp-quiet[data-act="new-project"]');
  key(list.querySelector('.lp-input'), 'Enter');
  await tick();
  assert.equal(asked(posts).length, 1);
  // a tap elsewhere keeps what was typed, as if Enter had been pressed
  click('.lp-quiet[data-act="new-project"]');
  list.querySelector('.lp-input').value = 'Loft';
  click('#panel-pills [data-pill="chats"]');
  await tick();
  assert.deepEqual(asked(posts)[1], { action: 'new-project', title: 'Loft' });
  assert.equal(sent(posts).length, 0);
});

test('a project keeps its own actions in its one "more" menu', dom, async t => {
  const { C, list, $, click, posts, tick } = await mkPanel(t);
  const snap = SNAP();
  snap.projects[1].github = 'https://example.invalid/me/garden';
  C.handle(snap);
  C.setPanelView('inside-project', { pid: 'orbit' });
  click('.more[data-key="project:orbit"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'menu', key: 'project:orbit' });
  assert.deepEqual([...list.querySelectorAll('.lp-menu [role="menuitem"]')].map(b => b.textContent.trim()),
    ['Publish to GitHub…', 'Archive project', 'Delete project…']);
  click('.lp-menu [data-act="proj-archive"]');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'project-archive', project: 'orbit' }]);
  assert.match($('#panel-note').textContent, /Archived Orbit notes book\./);
  click('#panel-note [data-act="undo"]');
  await tick();
  assert.deepEqual(asked(posts)[1], { action: 'project-unarchive', project: 'orbit' });
  // a project already on GitHub offers a push; publishing is confirmed by the bots, in the chat
  C.setPanelView('inside-project', { pid: 'garden' });
  click('.more[data-key="project:garden"]');
  assert.match(list.querySelector('.lp-menu [data-act="proj-github"]').textContent, /Push to GitHub/);
  click('.lp-menu [data-act="proj-github"]');
  await tick();
  assert.deepEqual(sent(posts), ['/project github garden'], 'the one job that is the bots’ own goes to the chat');
  // an archived project: bring it back, or delete it
  C.setPanelView('inside-project', { pid: 'attic' });
  assert.match(list.querySelector('.lp-ptitle .lp-tag').textContent, /archived/);
  click('.more[data-key="project:attic"]');
  assert.deepEqual([...list.querySelectorAll('.lp-menu [role="menuitem"]')].map(b => b.textContent.trim()),
    ['Unarchive project', 'Delete project…']);
  click('.lp-menu [data-act="proj-unarchive"]');
  await tick();
  assert.deepEqual(asked(posts)[2], { action: 'project-unarchive', project: 'attic' });
});

test('Rename from the row: any chat, open or not', dom, async t => {
  const { C, list, $, click, key, posts, tick } = await mkPanel(t);
  C.handle(SNAP('loose001'));
  // a chat that is NOT the open one
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="rename"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'renaming', key: 'chat:loose002' });
  let box = list.querySelector('.lp-input');
  assert.equal(box.value, 'Packing list', 'the box starts with the name it has');
  // Escape leaves the name alone
  key(box, 'Escape');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(posts.length, 0);
  // the same name again is no rename
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="rename"]');
  key(list.querySelector('.lp-input'), 'Enter');
  await tick();
  assert.equal(posts.length, 0);
  // a new name
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="rename"]');
  box = list.querySelector('.lp-input');
  box.value = '  Packing   for the coast ';
  key(box, 'Enter');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'rename', sid: 'loose002', title: 'Packing for the coast' }]);
  assert.equal(sent(posts).length, 0, 'the open chat is not told anything');
  assert.match($('#panel-note').textContent, /Renamed\./);
  click('#panel-note [data-act="undo"]');
  await tick();
  assert.deepEqual(asked(posts)[1], { action: 'rename', sid: 'loose002', title: 'Packing list' });
  // and the open chat the same way
  click('.more[data-key="chat:loose001"]');
  click('.lp-menu [data-act="rename"]');
  box = list.querySelector('.lp-input');
  box.value = 'Kettle';
  key(box, 'Enter');
  await tick();
  assert.deepEqual(asked(posts)[2], { action: 'rename', sid: 'loose001', title: 'Kettle' });
});

test('Delete asks in the row itself: Keep or Delete', dom, async t => {
  const { C, list, $, click, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  C.setSlideOut('open');
  click('.more[data-key="chat:loose004"]');
  click('.lp-menu [data-act="delete"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'confirming-delete', key: 'chat:loose004' });
  assert.equal(posts.length, 0, 'asking deletes nothing');
  const row = list.querySelector('.lp-row[data-key="chat:loose004"]');
  assert.ok(row.classList.contains('asking'));
  assert.match(row.textContent, /Delete “Bread timings”\?/);
  assert.deepEqual([...row.querySelectorAll('button')].map(b => b.textContent.trim()), ['Delete', 'Keep']);
  assert.equal(list.querySelectorAll('.asking').length, 1, 'in that row and nowhere else');
  // a tap on the question itself does not answer it
  row.querySelector('.t').click();
  assert.equal(C.state.row.mode, 'confirming-delete');
  // Keep
  click('.lp-row.asking [data-act="cancel"]');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(posts.length, 0);
  assert.equal(list.querySelector('.asking'), null);
  // a tap elsewhere is a Keep too
  click('.more[data-key="chat:loose004"]');
  click('.lp-menu [data-act="delete"]');
  click('#panel-pills [data-pill="projects"]');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(posts.length, 0);
  click('#panel-pills [data-pill="chats"]');
  // Delete
  click('.more[data-key="chat:loose004"]');
  click('.lp-menu [data-act="delete"]');
  click('.lp-row.asking [data-act="delete-yes"]');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'delete', sid: 'loose004' }]);
  assert.equal(sent(posts).length, 0, 'no "are you sure" in the chat');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(C.state.slideOut, 'open', 'the panel stays where it was');
  const note = $('#panel-note');
  assert.match(note.textContent, /Deleted\./);
  assert.equal(note.querySelector('[data-act="undo"]'), null, 'a delete cannot be undone, so no Undo is offered');
});

test('a refusal is said in plain words in the note, with no Undo', dom, async t => {
  const why = 'The bots are still working in that chat. Try again when they finish.';
  const { C, $, click, posts, tick } = await mkPanel(t, {
    fetchJson: url => (url === '/panel' ? { ok: false, error: why } : null),
  });
  C.handle(SNAP('loose001'));
  click('.more[data-key="chat:loose001"]');
  click('.lp-menu [data-act="archive"]');
  await tick();
  assert.equal(asked(posts).length, 1);
  const note = $('#panel-note');
  assert.equal(note.textContent.trim(), why);
  assert.equal(note.querySelector('[data-act="undo"]'), null);
  assert.equal(sent(posts).length, 0);
  // only the nine named things can be asked for
  assert.deepEqual([...C.PANEL_ACTIONS], ['rename', 'move', 'archive', 'unarchive', 'delete',
    'new-project', 'project-archive', 'project-unarchive', 'project-delete']);
  assert.equal(await C.panelAct('reformat-disk', { sid: 'loose001' }), null);
  assert.equal(asked(posts).length, 1, 'anything else is not even sent');
});

test('a server that cannot be reached says so in the note', dom, async t => {
  const { C, $, click, tick } = await mkPanel(t, {
    fetchJson: url => { if (url === '/panel') throw new Error('offline'); return null; },
  });
  C.handle(SNAP());
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="archive"]');
  await tick();
  assert.match($('#panel-note').textContent, /Could not reach the council\. Try again\./);
});

test('Move to project: "New project…" makes one and files the chat in it', dom, async t => {
  const { C, list, $, click, key, posts, tick } = await mkPanel(t, {
    fetchJson: (url, body) => (url === '/panel' && body.action === 'new-project' ? { ok: true, project: 'loft' } : null),
  });
  C.handle(SNAP());
  click('.more[data-key="chat:loose002"]');
  click('.lp-menu [data-act="move"]');
  click('.lp-menu [data-act="move-new"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'naming-new-project', key: 'chat:loose002' });
  const box = list.querySelector('.lp-row[data-key="chat:loose002"] .lp-input');
  assert.ok(box, 'the chat’s own row became the text box');
  assert.match(box.getAttribute('placeholder'), /Packing list/, 'and still says which chat it is');
  box.value = 'Loft';
  key(box, 'Enter');
  await tick(30);
  assert.deepEqual(asked(posts), [
    { action: 'new-project', title: 'Loft' },
    { action: 'move', sid: 'loose002', project: 'loft' },
  ]);
  assert.match($('#panel-note').textContent, /Moved to Loft\./);
  click('#panel-note [data-act="undo"]');
  await tick();
  assert.deepEqual(asked(posts)[2], { action: 'move', sid: 'loose002', project: '' });
});

test('Delete project asks in place, and says what goes with it', dom, async t => {
  const { C, list, $, click, posts, tick } = await mkPanel(t);
  C.handle(SNAP());
  C.setPanelView('inside-project', { pid: 'orbit' });
  click('.more[data-key="project:orbit"]');
  click('.lp-menu [data-act="proj-delete"]');
  assert.deepEqual({ ...C.state.row }, { mode: 'confirming-delete', key: 'project:orbit' });
  const ask = list.querySelector('.lp-ptitle.asking');
  assert.match(ask.textContent, /Delete “Orbit notes book”, its 2 chats and its files\?/);
  assert.deepEqual([...ask.querySelectorAll('button')].map(b => b.textContent.trim()), ['Delete', 'Keep']);
  assert.equal(posts.length, 0);
  click('.lp-ptitle.asking [data-act="cancel"]');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(posts.length, 0);
  click('.more[data-key="project:orbit"]');
  click('.lp-menu [data-act="proj-delete"]');
  click('.lp-ptitle.asking [data-act="proj-delete-yes"]');
  await tick();
  assert.deepEqual(asked(posts), [{ action: 'project-delete', project: 'orbit' }]);
  assert.equal(sent(posts).length, 0);
  assert.match($('#panel-note').textContent, /Deleted Orbit notes book\./);
  // the list that comes back no longer has it: the panel steps out to Projects
  const without = SNAP();
  without.projects = without.projects.filter(pr => pr.id !== 'orbit');
  C.handle(without);
  assert.equal(C.state.panel.view, 'projects');
});

test('a project’s files are read once, when the project is opened in the panel', dom, async t => {
  const files = [
    { path: 'figures', name: 'figures', dir: true, size: 0, depth: 0, truncated: false },
    { path: 'figures/fig1.png', name: 'fig1.png', dir: false, size: 2048, depth: 1 },
    { path: 'PLAN.md', name: 'PLAN.md', dir: false, size: 512, depth: 0 },
  ];
  const { C, list, gets, posts, click, tick } = await mkPanel(t, {
    fetchJson: url => (url.startsWith('/project-contents') ? { ok: true, files } : null),
  });
  const snap = SNAP();
  snap.projects[0].github = 'https://example.invalid/me/orbit';
  C.handle(snap);
  const asked = () => gets.filter(u => u.startsWith('/project-contents'));
  assert.equal(asked().length, 0, 'nothing is read until the project is opened');
  click('#panel-pills [data-pill="projects"]');
  click('.lp-proj[data-pid="orbit"]');
  assert.equal(C.state.contents.orbit.load, 'loading');
  assert.match(list.textContent, /Reading the folder/);
  await tick(20);
  assert.deepEqual(asked(), ['/project-contents?id=orbit']);
  assert.equal(C.state.contents.orbit.load, 'ready');
  assert.match(list.textContent, /figures\//);
  assert.match(list.textContent, /fig1\.png/);
  assert.match(list.textContent, /2\.0 KB/);
  assert.equal(list.querySelector('.lp-file a').getAttribute('href'), 'https://example.invalid/me/orbit');
  // leaving and coming back does not ask twice
  click('.lp-back');
  click('.lp-proj[data-pid="orbit"]');
  await tick(20);
  assert.equal(asked().length, 1);
  assert.equal(sent(posts).length, 0, 'and none of it spends a turn');
});

// ── Settings, and the panel itself ──────────────────────────────────────────
test('Settings at the foot holds the theme, the typing switch and Project connections', dom, async t => {
  const { C, doc, $, click } = await mkPanel(t);
  C.handle(SNAP());
  const pop = $('#settings-pop');
  assert.equal(pop.hasAttribute('hidden'), true);
  click('#panel-settings');
  assert.deepEqual({ ...C.state.row }, { mode: 'menu', key: 'settings' }, 'Settings is a row like any other');
  assert.equal(pop.hasAttribute('hidden'), false);
  assert.equal($('#panel-settings').getAttribute('aria-expanded'), 'true');
  assert.ok(pop.querySelector('#theme-toggle [data-theme-opt="dark"]'));
  assert.ok(pop.querySelector('#typing-toggle [data-typing-opt="instant"]'));
  assert.equal(pop.querySelector('a.network-nav').getAttribute('href'), '/project-network/view');
  // choosing inside it does not close it
  click('#theme-toggle [data-theme-opt="dark"]');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(pop.hasAttribute('hidden'), false);
  // a row's menu takes over from it: still only one thing open
  click('.more[data-key="chat:loose001"]');
  assert.equal(pop.hasAttribute('hidden'), true);
  click('#panel-settings');
  click('#panel-settings');
  assert.equal(C.state.row.mode, 'resting');
});

test('phone: the burger slides the panel out and back; it opens where the open chat lives', dom, async t => {
  const { C, doc, $, click, tick } = await mkPanel(t);
  C.handle(SNAP('orb00001'));
  const body = doc.body;
  assert.equal(body.classList.contains('side-open'), false);
  click('#panel-pills [data-pill="chats"]');
  click('#burger');
  assert.equal(C.state.slideOut, 'open');
  assert.ok(body.classList.contains('side-open'));
  assert.equal($('#backdrop').hasAttribute('hidden'), false);
  assert.equal($('#burger').getAttribute('aria-expanded'), 'true');
  assert.deepEqual({ ...C.state.panel }, { view: 'inside-project', pid: 'orbit' }, 'opened where the open chat lives');
  // closing puts a busy row to rest
  click('.more[data-key="chat:orb00002"]');
  click('#side-close');
  assert.equal(C.state.slideOut, 'closed');
  assert.equal(C.state.row.mode, 'resting');
  assert.equal(body.classList.contains('side-open'), false);
  assert.equal($('#backdrop').hasAttribute('hidden'), true);
  // the backdrop closes it too, and so does opening a chat
  click('#burger');
  click('#backdrop');
  assert.equal(C.state.slideOut, 'closed');
  click('#burger');
  click('.lp-row [data-act="open"][data-sid="orb00002"]');
  await tick();
  assert.equal(C.state.slideOut, 'closed');
  assert.equal(body.classList.contains('side-collapsed'), false, 'a phone never uses the wide fold');
});

test('wide screen: the panel starts out; folding it away is remembered', dom, async t => {
  const { C, w, doc, click } = await mkPanel(t, { width: 1280 });
  C.handle(SNAP());
  assert.equal(C.state.slideOut, 'open');
  assert.equal(doc.body.classList.contains('side-collapsed'), false);
  click('#burger');
  assert.equal(C.state.slideOut, 'closed');
  assert.ok(doc.body.classList.contains('side-collapsed'));
  assert.equal(w.localStorage.getItem('council-side'), 'collapsed');
  click('#burger');
  assert.equal(C.state.slideOut, 'open');
  assert.equal(w.localStorage.getItem('council-side'), '');
  // opening a chat does not fold a wide panel away
  click('.lp-row [data-act="open"][data-sid="loose001"]');
  assert.equal(C.state.slideOut, 'open');
});

test('times read short: minutes to years', dom, async t => {
  const { C } = await mkPanel(t);
  const at = s => new Date(Date.now() - s * 1000).toISOString();
  assert.equal(C.relTime(at(20)), '1m');
  assert.equal(C.relTime(at(40 * 60)), '40m');
  assert.equal(C.relTime(at(5 * 3600)), '5h');
  assert.equal(C.relTime(at(3 * 86400)), '3d');
  assert.equal(C.relTime(at(15 * 86400)), '2w');
  assert.equal(C.relTime(at(100 * 86400)), '3mo');
  assert.equal(C.relTime(at(800 * 86400)), '2y');
  assert.equal(C.relTime(''), '');
});

// ── the server's /panel path, with a stand-in for the controller ────────────
// (tests/fixtures/fake-council-bridge.mjs: it writes every panel request it
// is sent to <rx>.panel and every typed message to <rx>)
const SERVER = path.join(HOME, 'frontends', 'council', 'server.mjs');
const FAKE = path.join(HOME, 'tests', 'fixtures', 'fake-council-bridge.mjs');
// a developer's real keys never reach a test server
const KEY_VARS = /^(ANTHROPIC_|OPENAI_|CODEX_|AWS_BEARER_TOKEN|CLAUDE_CODE_USE_)/;
function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => ([4177, 4180, 4187, 4189].includes(port) ? resolve(freePort()) : resolve(port)));
    });
  });
}
async function startServer(t, { hosted = false, env = {} } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-panel-'));
  const rx = path.join(dir, 'rx.txt');
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_VARS.test(k)));
  const proc = spawn(process.execPath, hosted ? [SERVER, '--hosted'] : [SERVER], {
    env: {
      ...base,
      PORT: String(port),
      BOTFERENCE_PROJECT_ROOT: dir,
      BOTFERENCE_HOME: HOME,
      BOTFERENCE_SECRETS_DIR: path.join(dir, 'secrets'),
      COUNCIL_BRIDGE_CMD: JSON.stringify([process.execPath, FAKE, rx]),
      COUNCIL_PASSWORD: hosted ? 'made-up-pw' : '',
      BOTFERENCE_GDOC_WATCH: '0',
      ...env,
    },
  });
  t.after(() => {
    proc.kill();
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* a child still writing */ }
    }
  });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  const deadline = Date.now() + 15000;
  while (!/Council live at/.test(out)) {
    if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
    await new Promise(r => setTimeout(r, 50));
  }
  const lines = file => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    base: `http://127.0.0.1:${port}`,
    typed: () => lines(rx),
    panel: () => lines(`${rx}.panel`).map(l => JSON.parse(l)),
  };
}
// everything a tab that connects NOW is sent, up to the end of the replay
async function replay(base) {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { signal: ac.signal });
  const reader = r.body.getReader();
  const events = [];
  let buf = '';
  const deadline = Date.now() + 8000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const m = /^data: (.*)$/m.exec(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (m) { try { events.push(JSON.parse(m[1])); } catch { /* a comment line */ } }
      }
      if (events.some(e => e.type === 'replay_done') && events.some(e => e.type === 'ready')) return events;
    }
  } finally { ac.abort(); }
  throw new Error(`the replay did not finish; got: ${events.map(e => e.type).join(',')}`);
}
const ask = async (base, body, headers = {}) => {
  const r = await fetch(base + '/panel', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('POST /panel: the controller does it and answers; nothing is said in the chat', async t => {
  const s = await startServer(t);
  const before = await replay(s.base);
  const r = await ask(s.base, { action: 'rename', sid: 'abc12345', title: 'Seed order, second try' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const got = s.panel();
  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'panel');
  assert.match(got[0].id, /^p\d+$/);
  assert.deepEqual({ action: got[0].action, sid: got[0].sid, title: got[0].title },
    { action: 'rename', sid: 'abc12345', title: 'Seed order, second try' });
  assert.deepEqual(s.typed(), [], 'no command was typed into the chat on the reader’s behalf');
  // a tab that connects afterwards: the list has the new name, the chat is as it was
  const after = await replay(s.base);
  const list = after.filter(e => e.type === 'projects').pop();
  assert.equal(list.projects[0].sessions[0].title, 'Seed order, second try');
  assert.equal(after.some(e => e.type === 'panel_result'), false, 'the answer to one request is not replayed');
  const said = evs => evs.filter(e => e.type === 'room' || e.type === 'user_echo').map(e => e.text);
  assert.deepEqual(said(after), said(before), 'not a line was added to the chat');
});

test('POST /panel: a new project comes back with its id; a refusal comes back in plain words', async t => {
  const s = await startServer(t);
  await replay(s.base);
  const made = await ask(s.base, { action: 'new-project', title: 'Loft' });
  assert.deepEqual(made.body, { ok: true, project: 'p-new' });
  const no = await ask(s.base, { action: 'archive', sid: 'refuse01' });
  assert.equal(no.status, 200);
  assert.deepEqual(no.body, { ok: false, error: 'The bots are still working in that chat. Try again when they finish.' });
  // only the named actions get as far as the controller
  for (const bad of [{ action: 'reformat-disk' }, { action: '' }, {}, { action: ['rename'] }]) {
    const r = await ask(s.base, bad);
    assert.deepEqual(r.body, { ok: false, error: 'The panel cannot do that.' });
  }
  assert.deepEqual(s.panel().map(m => m.action), ['new-project', 'archive']);
  // odd fields are dropped, long ones cut
  await ask(s.base, { action: 'rename', sid: 'abc12345', title: 'x'.repeat(5000).slice(0, 3000), extra: { deep: 1 }, project: 7 });
  const last = s.panel().pop();
  assert.equal(last.title.length, 300);
  assert.equal('extra' in last, false);
  assert.equal('project' in last, false);
  // the chat still takes a message afterwards
  const r = await fetch(s.base + '/input', {
    method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await r.json(), { ok: true });
});

test('POST /panel: a controller that never answers is not waited on for ever', async t => {
  const s = await startServer(t, { env: { COUNCIL_PANEL_WAIT_MS: '300' } });
  await replay(s.base);
  const started = Date.now();
  const r = await ask(s.base, { action: 'delete', sid: 'silent01' });
  assert.deepEqual(r.body, { ok: false, error: 'No answer from the council. Try again.' });
  assert.ok(Date.now() - started < 5000);
  // and the next request is answered as usual
  assert.deepEqual((await ask(s.base, { action: 'unarchive', sid: 'abc12345' })).body, { ok: true });
});

test('POST /panel is behind the password like every other request', async t => {
  const s = await startServer(t, { hosted: true });
  const r = await ask(s.base, { action: 'delete', sid: 'abc12345' });
  assert.equal(r.status, 401);
  assert.deepEqual(s.panel(), [], 'nothing reached the controller');
});
