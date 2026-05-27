// Generic event system with typed event maps

export interface EventMap {
  [event: string]: unknown;
}

export interface Listener<T> {
  (data: T): void;
}

export interface Disposable {
  dispose(): void;
}

export class EventBus<TMap extends EventMap> {
  private listeners = new Map<keyof TMap, Set<Listener<any>>>();

  on<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): Disposable {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return {
      dispose: () => {
        this.listeners.get(event)?.delete(listener);
      },
    };
  }

  emit<K extends keyof TMap>(event: K, data: TMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        fn(data);
      }
    }
  }

  once<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): Disposable {
    const disposable = this.on(event, (data) => {
      disposable.dispose();
      listener(data);
    });
    return disposable;
  }
}
