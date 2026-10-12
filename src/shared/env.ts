// Build target is fixed at compile time (vite --mode chrome|firefox).
declare global {
  const __TARGET__: 'chrome' | 'firefox';
}

export const TARGET = __TARGET__;
export const IS_FIREFOX = TARGET === 'firefox';

/** Firefox-only `browser.sidebarAction`, typed loosely (not in @types/chrome). */
export interface SidebarAction {
  open(): Promise<void>;
  close(): Promise<void>;
  isOpen(details?: object): Promise<boolean>;
}

export function sidebarAction(): SidebarAction | undefined {
  const g = globalThis as unknown as { browser?: { sidebarAction?: SidebarAction } };
  return g.browser?.sidebarAction;
}
