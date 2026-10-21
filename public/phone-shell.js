// Phone presentation helpers. The phone layout reuses the Desktop views,
// quick-add defaults and row commands; it only changes how they are reached.
export const PHONE_QUERY = '(max-width: 680px)';
export const PHONE_TABS = ['today', 'inbox', 'next'];
const statusByView = {next: 'next', waiting: 'waiting', someday: 'someday'};

export function phoneTabFor({view, projectId}) {
  return !projectId && PHONE_TABS.includes(view) ? view : 'more';
}

// Same defaults as Desktop quick add: title only; project, status and today's
// date come from the current view.
export function quickAddDefaults({view, project, spaceId, today}) {
  return {
    spaceId: project?.spaceId || spaceId,
    projectId: project?.id || null,
    workflowStatus: statusByView[view] || 'inbox',
    priority: 3,
    plannedOn: view === 'today' ? today : null,
  };
}

export function quickAddContext({view, project, viewTitle}) {
  if (project) return `Adds to ${project.name}`;
  if (view === 'today') return 'Adds to Today with today’s date';
  const status = statusByView[view];
  return status ? `Adds to ${viewTitle}` : 'Adds to Inbox';
}

// Android Chrome's deferred beforeinstallprompt event; this is the browser's
// install sheet, not a window.prompt() text dialog.
export async function offerInstall(deferredEvent) {
  try { await deferredEvent.prompt(); return (await deferredEvent.userChoice)?.outcome ?? null; }
  catch { return null; }
}

export function installCardState({standalone, dismissed, ios, promptReady}) {
  if (standalone || dismissed) return {show: false, mode: null};
  if (promptReady) return {show: true, mode: 'prompt'};
  return {show: true, mode: ios ? 'ios' : 'manual'};
}

// Open phone layers (task details, quick add, search, More) share one history
// entry, so the system Back gesture closes the top layer instead of leaving
// Openza. Each Back press closes one layer.
export function createBackStack({history, schedule = callback => setTimeout(callback, 0)}) {
  const layers = [];
  let hasEntry = false, ignoreNext = false;
  const ensureEntry = () => {
    if (hasEntry || !layers.length) return;
    history.pushState({...(history.state || {}), openzaLayer: true}, '');
    hasEntry = true;
  };
  return {
    opened(name, {close}) {
      if (!layers.some(layer => layer.name === name)) layers.push({name, close});
      if (!ignoreNext) ensureEntry();
    },
    closed(name) {
      const index = layers.findIndex(layer => layer.name === name);
      if (index !== -1) layers.splice(index, 1);
      if (!layers.length && hasEntry && !ignoreNext) {
        hasEntry = false;
        ignoreNext = true;
        history.back();
      }
    },
    popped() {
      if (ignoreNext) { ignoreNext = false; ensureEntry(); return; }
      hasEntry = false;
      const layer = layers.at(-1);
      if (!layer) return;
      layer.close();
      // A layer that stays open (unsaved prompt, failed save) keeps an entry.
      schedule(ensureEntry);
    },
    depth: () => layers.length,
  };
}

// Touch long-press opens the row's command sheet; mouse users keep the ⋯ menu.
export function bindLongPress(element, onLongPress, {delay = 500, slop = 10} = {}) {
  let timer = null, start = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; start = null; };
  element.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    fired = false;
    start = {x: event.clientX, y: event.clientY};
    timer = setTimeout(() => { fired = true; timer = null; onLongPress(); }, delay);
  });
  element.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > slop) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) element.addEventListener(type, cancel);
  element.addEventListener('contextmenu', event => { if (timer || fired) event.preventDefault(); });
  // Suppress only the finger's own click after a long press; the handler's
  // programmatic click (for example opening the row menu) must pass.
  element.addEventListener('click', event => {
    if (fired && event.isTrusted) { fired = false; event.preventDefault(); event.stopPropagation(); }
  }, true);
}

// iOS keeps the layout viewport when the keyboard opens; bottom sheets follow
// the visual viewport instead so their Add button stays above the keyboard.
export function keyboardInset({innerHeight, viewportHeight, viewportOffsetTop}) {
  return Math.max(0, Math.round(innerHeight - viewportHeight - viewportOffsetTop));
}
