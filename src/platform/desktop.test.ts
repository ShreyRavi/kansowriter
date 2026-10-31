import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, flushOpenDrafts } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  flushOpenDrafts: vi.fn(async () => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../storage/lifecycle', () => ({ flushOpenDrafts }));

const { beforeQuit, startDesktop, SAVE_BEFORE_QUIT_MS } = await import('./desktop');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  invoke.mockClear();
  flushOpenDrafts.mockReset().mockResolvedValue(true);
});

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
  });

  it('startDesktop installs the hook the native side calls', async () => {
    const target = {} as Window;
    startDesktop(target);
    target.__kansoBeforeQuit!();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith('quit_ready', { saved: true });
  });
});
