import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {phoneTabFor, quickAddDefaults, quickAddContext, installCardState, createBackStack, keyboardInset} from '../public/phone-shell.js';

test('phone tabs highlight Today, Inbox and Next; every other Desktop view and projects live under More', () => {
  for (const view of ['today', 'inbox', 'next']) assert.equal(phoneTabFor({view, projectId: null}), view);
  for (const view of ['calendar', 'overdue', 'waiting', 'someday', 'all', 'completed']) assert.equal(phoneTabFor({view, projectId: null}), 'more');
  assert.equal(phoneTabFor({view: 'all', projectId: 'project'}), 'more');
});

test('quick add uses the Desktop defaults: title only, current project, view status and today in Today', () => {
  const today = '2026-10-21';
  assert.deepEqual(quickAddDefaults({view: 'inbox', project: null, spaceId: 'space', today}),
    {spaceId: 'space', projectId: null, workflowStatus: 'inbox', priority: 3, plannedOn: null});
  assert.deepEqual(quickAddDefaults({view: 'today', project: null, spaceId: 'space', today}),
    {spaceId: 'space', projectId: null, workflowStatus: 'inbox', priority: 3, plannedOn: today});
  for (const view of ['next', 'waiting', 'someday']) assert.equal(quickAddDefaults({view, project: null, spaceId: 's', today}).workflowStatus, view);
  for (const view of ['calendar', 'overdue', 'all', 'completed']) assert.equal(quickAddDefaults({view, project: null, spaceId: 's', today}).workflowStatus, 'inbox');
  const project = {id: 'project', spaceId: 'work', name: 'Hiring'};
  assert.deepEqual(quickAddDefaults({view: 'all', project, spaceId: 'personal', today}),
    {spaceId: 'work', projectId: 'project', workflowStatus: 'inbox', priority: 3, plannedOn: null});
});

test('quick add explains where the task goes', () => {
  assert.equal(quickAddContext({view: 'today', project: null, viewTitle: 'Today'}), 'Adds to Today with today’s date');
  assert.equal(quickAddContext({view: 'next', project: null, viewTitle: 'Next Actions'}), 'Adds to Next Actions');
  assert.equal(quickAddContext({view: 'calendar', project: null, viewTitle: 'Calendar'}), 'Adds to Inbox');
  assert.equal(quickAddContext({view: 'all', project: {name: 'Hiring'}, viewTitle: 'Tasks'}), 'Adds to Hiring');
});

test('install card hides once installed or dismissed and picks the platform instructions', () => {
  assert.deepEqual(installCardState({standalone: true, dismissed: false, ios: true, promptReady: false}), {show: false, mode: null});
  assert.deepEqual(installCardState({standalone: false, dismissed: true, ios: false, promptReady: true}), {show: false, mode: null});
  assert.deepEqual(installCardState({standalone: false, dismissed: false, ios: false, promptReady: true}), {show: true, mode: 'prompt'});
  assert.deepEqual(installCardState({standalone: false, dismissed: false, ios: true, promptReady: false}), {show: true, mode: 'ios'});
  assert.deepEqual(installCardState({standalone: false, dismissed: false, ios: false, promptReady: false}), {show: true, mode: 'manual'});
});

function fakeHistory() {
  const calls = [];
  return {calls, state: null, pushState(state) { calls.push('push'); this.state = state; }, back() { calls.push('back'); }};
}

test('Back closes the top phone layer; programmatic close removes the history entry once', () => {
  const history = fakeHistory(), scheduled = [];
  const stack = createBackStack({history, schedule: callback => scheduled.push(callback)});
  let detailsOpen = true;
  stack.opened('details', {close: () => { detailsOpen = false; stack.closed('details'); }});
  assert.deepEqual(history.calls, ['push']);
  stack.popped();
  assert.equal(detailsOpen, false);
  scheduled.splice(0).forEach(callback => callback());
  assert.deepEqual(history.calls, ['push'], 'a user Back press must not add another history step');

  stack.opened('quick-add', {close() {}});
  stack.closed('quick-add');
  assert.deepEqual(history.calls, ['push', 'push', 'back']);
  stack.popped();
  assert.deepEqual(history.calls, ['push', 'push', 'back'], 'the programmatic back is ignored');
  assert.equal(stack.depth(), 0);
});

test('a layer that stays open after Back (unsaved prompt or failed save) keeps a history entry', () => {
  const history = fakeHistory(), scheduled = [];
  const stack = createBackStack({history, schedule: callback => scheduled.push(callback)});
  stack.opened('details', {close() {}});
  stack.popped();
  scheduled.splice(0).forEach(callback => callback());
  assert.deepEqual(history.calls, ['push', 'push']);
  assert.equal(stack.depth(), 1);
});

test('stacked layers close one per Back press', () => {
  const history = fakeHistory(), scheduled = [], closed = [];
  const stack = createBackStack({history, schedule: callback => scheduled.push(callback)});
  for (const name of ['more', 'search']) stack.opened(name, {close: () => { closed.push(name); stack.closed(name); }});
  stack.popped();
  scheduled.splice(0).forEach(callback => callback());
  assert.deepEqual(closed, ['search']);
  assert.equal(stack.depth(), 1);
  stack.popped();
  scheduled.splice(0).forEach(callback => callback());
  assert.deepEqual(closed, ['search', 'more']);
  assert.equal(stack.depth(), 0);
});

test('keyboard inset follows the visual viewport and never goes negative', () => {
  assert.equal(keyboardInset({innerHeight: 844, viewportHeight: 520, viewportOffsetTop: 0}), 324);
  assert.equal(keyboardInset({innerHeight: 844, viewportHeight: 520, viewportOffsetTop: 24}), 300);
  assert.equal(keyboardInset({innerHeight: 844, viewportHeight: 844, viewportOffsetTop: 0}), 0);
  assert.equal(keyboardInset({innerHeight: 844, viewportHeight: 900, viewportOffsetTop: 0}), 0);
});

test('installable app metadata and phone markup are present', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const id of ['phone-tabs', 'phone-add', 'quick-add-dialog', 'quick-add-title', 'install-card', 'details-back']) assert.match(html, new RegExp(`id="${id}"`));
  // Enter in the full add form creates the task (Desktop default) instead of opening it.
  assert.ok(html.indexOf('id="create-task"') < html.indexOf('id="create-open-task"'));
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const phone = css.slice(css.lastIndexOf('@media (max-width: 680px)'));
  assert.match(phone, /input, select, textarea \{ font-size: 16px; \}/);
});

function fakeElement() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    dispatch(type, event = {}) {
      const record = {defaultPrevented: false, stopped: false, isTrusted: true, ...event,
        preventDefault() { record.defaultPrevented = true; }, stopPropagation() { record.stopped = true; }};
      for (const listener of listeners[type] || []) listener(record);
      return record;
    },
  };
}

test('long press opens the row menu through a programmatic click and swallows only the finger click', async () => {
  const {bindLongPress} = await import('../public/phone-shell.js');
  const row = fakeElement();
  let menuClicks = 0;
  bindLongPress(row, () => { const click = row.dispatch('click', {isTrusted: false}); if (!click.stopped) menuClicks++; }, {delay: 5});
  row.dispatch('pointerdown', {pointerType: 'touch', clientX: 10, clientY: 10});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(menuClicks, 1, 'the programmatic menu click is not cancelled');
  row.dispatch('pointerup');
  const fingerClick = row.dispatch('click');
  assert.equal(fingerClick.stopped, true, 'the release click does not also open details');
  const nextTap = row.dispatch('click');
  assert.equal(nextTap.stopped, false, 'later taps work normally');
});

test('long press is cancelled by movement and ignored for mouse input', async () => {
  const {bindLongPress} = await import('../public/phone-shell.js');
  const row = fakeElement();
  let fired = 0;
  bindLongPress(row, () => fired++, {delay: 5});
  row.dispatch('pointerdown', {pointerType: 'touch', clientX: 0, clientY: 0});
  row.dispatch('pointermove', {clientX: 0, clientY: 40});
  row.dispatch('pointerdown', {pointerType: 'mouse', clientX: 0, clientY: 0});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fired, 0);
});

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
import vm from 'node:vm';
function extract(context, name) { vm.runInContext(appSource.match(new RegExp(`^(?:async )?function ${name}\\(.*$`, 'm'))[0], context); }

test('Back answers an open Save/Discard or confirmation prompt instead of saving the editor beneath it', () => {
  const dialogs = {'#unsaved-dialog': {open: true}, '#confirmation-dialog': {open: false, close(value) { this.open = false; this.value = value; }}};
  let keepEditing = 0, saves = 0;
  const context = vm.createContext({
    $: id => id === '#keep-editing' ? {click: () => { keepEditing++; dialogs['#unsaved-dialog'].open = false; }} : dialogs[id],
    detailsDialog: {open: true}, isPhone: () => true, currentEditable: true, detailLabelBusy: false, detailPendingSave: null,
    captureDetailDraft: () => ({'details-notes': 'draft'}), saveAndCloseDetails: () => { saves++; }, requestDetailsClose: () => { saves++; },
  });
  for (const name of ['detailsPromptOpen', 'backFromDetails', 'closeDetailsFromUser']) extract(context, name);
  context.backFromDetails();
  assert.equal(keepEditing, 1);
  assert.equal(saves, 0);
  dialogs['#confirmation-dialog'].open = true;
  context.backFromDetails();
  assert.equal(dialogs['#confirmation-dialog'].value, 'cancel');
  assert.equal(saves, 0);
  dialogs['#unsaved-dialog'].open = true;
  context.closeDetailsFromUser();
  assert.equal(saves, 0, 'no save starts beneath an open prompt');
});

test('sign-out closes quick add and a Settings tab tap always navigates', () => {
  assert.match(appSource.match(/^async function signOut\(.*$/m)[0], /resetQuickAdd\(\)/);
  assert.match(appSource.match(/^function selectPhoneTab\(.*$/m)[0], /if\(!settingsRoute&&tab===currentView/);
});
