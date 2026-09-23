export type Listener<T> = (event: T) => void;

/** A typed event emitter. */
export class Emitter<T> {
  private listeners: Listener<T>[] = [];

  on(listener: Listener<T>): () => void {
    this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: Listener<T>) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  emit(event: T) { for (const l of this.listeners) l(event); }
}

export enum Priority { Low, High }

/** Default emitter shared by the app. */
export const bus = new Emitter<string>();
export default interface Handler { handle(): void }
