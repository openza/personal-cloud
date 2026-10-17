// Row commands share the inspector's validation, draft protection and CAS writes.
const fields = [
  ['Change date', 'details-planned'],
  ['Change project', 'details-project'],
  ['Change labels', 'details-new-label'],
  ['Change status', 'details-status'],
  ['Change priority', 'details-priority'],
  ['Move to Space', 'details-space'],
];

export function captureTaskRowInteraction(host) {
  const active = document.activeElement;
  const menu = host.querySelector('.task-actions-popover:popover-open');
  const row = (menu || (host.contains(active) ? active : null))?.closest('[data-task-id]');
  if (!row) return null;
  return {taskId: row.dataset.taskId, open: Boolean(menu),
    focus: row.contains(active) ? active.getAttribute('aria-label') || active.textContent : null};
}

export function restoreTaskRowInteraction(host, state) {
  if (!state) return;
  const row = [...host.querySelectorAll('[data-task-id]')].find(item => item.dataset.taskId === state.taskId);
  if (!row) return;
  const trigger = row.querySelector('.row-actions-trigger');
  if (state.open && trigger && !trigger.disabled) trigger.click();
  if (state.focus) {
    const target = [...row.querySelectorAll('button')].find(button =>
      (button.getAttribute('aria-label') || button.textContent) === state.focus);
    if (target && !target.disabled) target.focus({preventScroll: true});
  }
}

export function appendTaskRowActions({row, task, editable, onEdit, onDelete}) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'row-actions-trigger';
  trigger.textContent = '⋯';
  trigger.title = 'More actions';
  trigger.setAttribute('aria-label', `More actions for ${task.title}`);
  trigger.disabled = !editable;

  const actions = document.createElement('div');
  // A task can appear in several label groups. Every row needs its own target.
  actions.id = `task-actions-${crypto.randomUUID()}`;
  actions.className = 'task-actions-popover';
  actions.setAttribute('popover', 'auto');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', `Task actions for ${task.title}`);
  trigger.setAttribute('popovertarget', actions.id);
  for (const [label, field] of fields) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-button';
    button.textContent = label;
    button.addEventListener('click', () => {
      actions.hidePopover();
      onEdit(task.id, field);
    });
    actions.append(button);
  }
  if (!task.source) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet-button danger-text';
    remove.textContent = 'Delete task';
    remove.addEventListener('click', () => {
      actions.hidePopover();
      onDelete(task.id);
    });
    actions.append(remove);
  }
  row.append(trigger, actions);
}
