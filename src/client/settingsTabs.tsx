import { useEffect, useRef, type ReactNode } from "react";

export type SettingsTab<K extends string> = { key: K; label: ReactNode };

export function SettingsTabs<K extends string>({ label, idPrefix, tabs, active, onSelect, className }: { label: string; idPrefix: string; tabs: ReadonlyArray<SettingsTab<K>>; active: K; onSelect: (key: K) => void; className?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = tabs.findIndex((tab) => tab.key === active);
  useEffect(() => {
    // Narrow screens scroll the tab row, so a restored tab may start out of view.
    const row = list.current;
    const button = buttons.current[activeIndex];
    if (!row || !button) return;
    const offset = button.getBoundingClientRect().left - row.getBoundingClientRect().left;
    if (offset < 0 || offset + button.offsetWidth > row.clientWidth) row.scrollLeft += offset - (row.clientWidth - button.offsetWidth) / 2;
  }, [activeIndex]);
  return <div ref={list} className={className ? `settings-tabs ${className}` : "settings-tabs"} role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.key} type="button" role="tab" id={`${idPrefix}-tab-${tab.key}`} aria-controls={`${idPrefix}-panel-${tab.key}`} aria-selected={activeIndex === index} tabIndex={activeIndex === index ? 0 : -1} ref={(element) => { buttons.current[index] = element; }} onClick={() => onSelect(tab.key)} onKeyDown={(event) => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      onSelect(tabs[next]!.key);
      buttons.current[next]?.focus();
    }}>{tab.label}</button>)}
  </div>;
}
