/** Thin wrapper around the physics worker. */
import type { Request, Response } from './protocol';

type Handler = (msg: Response) => void;

export class Physics {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private handlers = new Set<Handler>();
  private nextId = 1;
  ready: Promise<Extract<Response, { type: 'ready' }>>;

  constructor(onProgress: (done: number, total: number) => void) {
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      for (const h of [...this.handlers]) h(e.data);
    };
    this.ready = new Promise((resolve) => {
      const h: Handler = (m) => {
        if (m.type === 'progress') onProgress(m.done, m.total);
        else if (m.type === 'ready') {
          this.handlers.delete(h);
          resolve(m);
        }
      };
      this.handlers.add(h);
    });
    this.send({ type: 'init' });
  }

  id(): number {
    return this.nextId++;
  }

  send(msg: Request) {
    this.worker.postMessage(msg);
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** Send a request carrying an id and resolve with the response of the given type and same id. */
  request<T extends Response['type']>(msg: Request & { id: number }, type: T): Promise<Extract<Response, { type: T }>> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (m.type === type && (m as { id?: number }).id === msg.id) {
          off();
          resolve(m as Extract<Response, { type: T }>);
        }
      });
      this.send(msg);
    });
  }
}

/**
 * "Latest wins" scheduler: at most one request in flight; if several are
 * queued while waiting, only the most recent one is sent.
 */
export function latest<A, R>(run: (arg: A) => Promise<R>, done: (res: R, arg: A) => void): (arg: A) => void {
  let busy = false;
  let pending: { arg: A } | null = null;
  const pump = (arg: A) => {
    busy = true;
    run(arg).then((res) => {
      done(res, arg);
      busy = false;
      if (pending) {
        const p = pending;
        pending = null;
        pump(p.arg);
      }
    });
  };
  return (arg: A) => {
    if (busy) pending = { arg };
    else pump(arg);
  };
}
