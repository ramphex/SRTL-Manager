import type { JobEventPage, JobEventRecord } from "../shared/types";

export function mergeJobEventPages(pages: JobEventPage[]): JobEventRecord[] {
  const eventsById = new Map<number, JobEventRecord>();
  for (const page of pages) {
    for (const event of page.events) eventsById.set(event.id, event);
  }
  return [...eventsById.values()].sort((left, right) => left.id - right.id);
}

export function jobEventCountLabel(loaded: number, total: number): string {
  if (total <= loaded) return `${total} event${total === 1 ? "" : "s"}`;
  return `${loaded} of ${total} events`;
}
