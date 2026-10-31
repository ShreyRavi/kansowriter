// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, flushOpenDrafts, addFlusher } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  flushOpenDrafts: vi.fn(async () => true),
  addFlusher: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../storage/lifecycle', () => ({ flushOpenDrafts, addFlusher }));
const { getDesktop } = await import('../ui/desktopBridge');

const { beforeQuit, startDesktop, showQuitNotice, SAVE_BEFORE_QUIT_MS, QUIT_NOTICE_MS, QUIT_NOTICE_TEXT } = await import('./desktop');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  invoke.mockClear();
  flushOpenDrafts.mockReset().mockResolvedValue(true);
  document.body.innerHTML = '';
});

const notice = () => document.getElementById('kanso-quit-notice');

/** run beforeQuit to completion under fake timers */
async function quit(timeoutMs = SAVE_BEFORE_QUIT_MS) {
  const done = beforeQuit(undefined, undefined, timeoutMs);
  await vi.advanceTimersByTimeAsync(timeoutMs + 100);
  await done;
}

describe('desktop: save before quitting', () => {
  it('saves every open draft (twice, for keys still on their way), then tells the app it may quit', async () => {
    const order: string[] = [];
    flushOpenDrafts.mockImplementation(async () => (order.push('flush'), true));
    invoke.mockImplementation(async () => void order.push('quit_ready'));
    await quit();
    expect(order).toEqual(['flush', 'flush', 'quit_ready']);
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: true });
    expect(notice()).toBeNull();
  });

  it('keys that land after the first save are saved before the app quits', async () => {
    // first save clean, then the last keystrokes arrive: dirty again, then clean twice
    flushOpenDrafts.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    await quit();
    expect(flushOpenDrafts).toHaveBeenCalledTimes(4);
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: true });
  });

  it('reports unsaved words when saving keeps failing, so the app stays open on the first quit', async () => {
    flushOpenDrafts.mockResolvedValue(false);
    await quit();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: false });
    expect(notice()?.textContent).toBe(QUIT_NOTICE_TEXT);
  });

  it('a save that throws still answers, as unsaved', async () => {
    flushOpenDrafts.mockRejectedValue(new Error('IndexedDB closed'));
    await quit();
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: false });
  });

  it('a save that hangs answers unsaved at the timeout instead of blocking the quit', async () => {
    flushOpenDrafts.mockReturnValue(new Promise<boolean>(() => {}));
    const done = beforeQuit(undefined, undefined, 2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: false });
    // the ignored quit is not silent
    expect(notice()?.getAttribute('role')).toBe('alert');
  });

  it("the notice uses the app's notice bar, replaces an older one and goes once a second quit stops being forced", async () => {
    showQuitNotice();
    const el = showQuitNotice();
    expect(document.querySelectorAll('#kanso-quit-notice')).toHaveLength(1);
    expect(el.className).toBe('notice');
    await vi.advanceTimersByTimeAsync(QUIT_NOTICE_MS);
    expect(notice()).toBeNull();
  });

  it('a notice that fails to show never blocks the answer', async () => {
    flushOpenDrafts.mockResolvedValue(false);
    const done = beforeQuit(undefined, undefined, 200, () => {
      throw new Error('no body');
    });
    await vi.advanceTimersByTimeAsync(300);
    await done;
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: false });
  });

  it('startDesktop installs the hooks the native side calls, the file bridge, and a quit flusher for linked files', async () => {
    const target = { addEventListener: vi.fn(), document } as unknown as Window;
    startDesktop(target);
    expect(getDesktop()).not.toBeNull();
    expect(typeof target.__kansoOpened).toBe('function');
    expect(typeof target.__kansoMenu).toBe('function');
    // flushOpenDrafts (the quit path) waits for linked files too
    expect(addFlusher).toHaveBeenCalledOnce();
    await expect((addFlusher.mock.calls[0] as unknown as [() => Promise<boolean>])[0]()).resolves.toBe(true);
    expect(target.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
    target.__kansoBeforeQuit!();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: true });
  });
});
