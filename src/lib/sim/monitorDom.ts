/** Small DOM helpers shared by the monitoring page modules. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const clock = (date: Date, seconds = false) =>
  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: false });

/** Owns listeners for one monitoring-page mount, including inline handlers. */
export class EventListeners {
  private readonly disposers: (() => void)[] = [];

  listen<T extends Event = Event>(
    target: EventTarget,
    type: string,
    listener: (event: T) => void,
    options?: boolean | AddEventListenerOptions,
  ) {
    const handler: EventListener = (event) => listener(event as T);
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  dispose() {
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }
}
