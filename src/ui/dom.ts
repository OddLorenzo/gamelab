export interface ElOptions {
  cls?: string;
  /** Always set through textContent: never markup. */
  text?: string;
  testid?: string;
  attrs?: Record<string, string>;
}

/** Tiny element builder shared by the scenes. Text goes in through textContent only. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.cls !== undefined) node.className = opts.cls;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.testid !== undefined) node.dataset.testid = opts.testid;
  for (const [name, value] of Object.entries(opts.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}
