export interface MenuEntry {
  label: string;
  action: () => void;
}

export interface ContextMenu {
  open(x: number, y: number, entries: MenuEntry[]): void;
  close(): void;
}

/** Keeps a menu of size w×h fully inside a viewport of vw×vh with a 4px margin. */
export function clampMenuPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.min(x, Math.max(4, vw - w - 4)),
    y: Math.min(y, Math.max(4, vh - h - 4)),
  };
}

export function createContextMenu(): ContextMenu {
  const el = document.createElement('div');
  el.className = 'context-menu hidden';
  el.setAttribute('role', 'menu');
  document.body.appendChild(el);

  const close = () => el.classList.add('hidden');

  function open(x: number, y: number, entries: MenuEntry[]): void {
    el.replaceChildren(
      ...entries.map((entry) => {
        const btn = document.createElement('button');
        btn.className = 'context-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = entry.label;
        btn.addEventListener('click', () => {
          close();
          entry.action();
        });
        return btn;
      }),
    );
    el.style.left = '0px';
    el.style.top = '0px';
    el.classList.remove('hidden');
    const rect = el.getBoundingClientRect();
    const pos = clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  document.addEventListener('click', (e) => {
    if (!el.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('blur', close);

  return { open, close };
}
