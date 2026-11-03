/** Bounded motion: hide relocation, then reveal only a small local movement. */
const content = document.querySelector<HTMLElement>("#main-content")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
type Position = { id: string; y: number };
type Snapshot = Position & { focus?: HTMLElement; details?: [HTMLDetailsElement, boolean][] };
type Motion = { animation?: Animation; kind: "link" | "history" };
const snapshots = new Map<string, Snapshot>();
const stateKey = "blogNavigation";
const newId = () => crypto.randomUUID();
const initial = history.state?.[stateKey] as Position | undefined;
let entry = initial?.id ?? newId();
let motion: Motion | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function writePosition() {
  history.replaceState({ ...history.state, [stateKey]: { id: entry, y: scrollY } }, "");
}
function capture(focus = document.activeElement as HTMLElement, persist = true) {
  snapshots.set(entry, {
    id: entry, y: scrollY, focus,
    details: [...document.querySelectorAll<HTMLDetailsElement>(".article-aside details")].map(d => [d, d.open]),
  });
  if (persist) writePosition();
}
function cancel() {
  if (saveTimer) clearTimeout(saveTimer);
  const previous = motion;
  motion = undefined; // Invalidate before rejecting the old animation's promise.
  previous?.animation?.cancel();
  delete content.dataset.navigating;
  document.dispatchEvent(new Event("blog:navigation"));
}
function focusTarget(target?: HTMLElement) {
  if (!target?.isConnected) return;
  if (!target.hasAttribute("tabindex") && !target.matches("a[href], button, input, select, textarea, summary")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
function targetFor(hash: string) {
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); }
  catch { return null; }
}
function targetY(target: HTMLElement) {
  const offset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const transform = getComputedStyle(content).transform;
  const translation = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
  return scrollY + target.getBoundingClientRect().top - translation - offset - margin;
}

async function move(
  destination: () => number,
  options: { kind: Motion["kind"]; restore?: () => void; relocated?: () => void; focus?: HTMLElement } = { kind: "link" },
) {
  cancel();
  const owner: Motion = { kind: options.kind };
  motion = owner;
  const started = performance.now();
  const direction = destination() >= scrollY ? 1 : -1;
  const animate = !reducedMotion.matches && typeof content.animate === "function";
  try {
    if (animate) {
      content.dataset.navigating = "";
      owner.animation = content.animate([
        { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" },
        { opacity: 0, filter: "blur(3px)", transform: `translateY(${-8 * direction}px)` },
      ], { duration: 100, easing: "ease-out", fill: "forwards" });
      await owner.animation.finished;
      if (motion !== owner) return;
    }
    // Restore layout while hidden, and only then measure the destination.
    options.restore?.();
    window.scrollTo({ top: Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, destination())), behavior: "instant" });
    options.relocated?.();
    if (animate) {
      const outgoing = owner.animation;
      owner.animation = content.animate([
        { opacity: 0, filter: "blur(3px)", transform: `translateY(${12 * direction}px)` },
        { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" },
      ], { duration: Math.max(0, 350 - (performance.now() - started)), easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" });
      outgoing?.cancel();
      await owner.animation.finished;
      if (motion !== owner) return;
    }
    cancel();
    focusTarget(options.focus);
    capture();
  } catch {
    // Cancellation is expected. Only the current operation may clear presentation.
    if (motion === owner) cancel();
  }
}

writePosition();
snapshots.set(entry, { id: entry, y: initial?.y ?? scrollY });
history.scrollRestoration = "manual";
window.addEventListener("scroll", () => {
  if (motion) return;
  // Keep an immediate in-memory position for rapid Back, throttle history writes.
  const previous = snapshots.get(entry);
  snapshots.set(entry, { ...previous, id: entry, y: scrollY });
  if (saveTimer) clearTimeout(saveTimer);
  const owner = entry;
  saveTimer = setTimeout(() => { if (owner === entry && !motion) writePosition(); }, 180);
}, { passive: true });

document.addEventListener("click", event => {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute("download") || link.classList.contains("skip-link")) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) return;
  const target = targetFor(url.hash);
  if (!target) return;
  event.preventDefault();
  if (!motion) capture(link);
  void move(() => targetY(target), {
    kind: "link", focus: target,
    restore: () => {
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true;
      }
    },
    relocated: () => {
      if (location.hash !== url.hash) {
        entry = newId();
        history.pushState({ ...history.state, [stateKey]: { id: entry, y: scrollY } }, "", url.hash);
      }
    },
  });
});

window.addEventListener("popstate", event => {
  const savedState = event.state?.[stateKey] as Position | undefined;
  // The URL/state already belong to the destination; save only to the old map entry.
  if (!motion) capture(undefined, false);
  cancel();
  entry = savedState?.id ?? newId();
  const saved = snapshots.get(entry);
  const target = targetFor(location.hash);
  void move(() => saved?.y ?? savedState?.y ?? (target ? targetY(target) : 0), {
    kind: "history",
    restore: () => saved?.details?.forEach(([details, open]) => { details.open = open; }),
    focus: saved?.focus ?? target ?? content,
  });
});

document.getElementById("to-top")?.addEventListener("click", () => {
  if (!motion) capture();
  void move(() => 0, { kind: "link", focus: content });
});
// Wheel, touch and scroll keys take ownership immediately; animations never fight input.
window.addEventListener("wheel", cancel, { passive: true });
window.addEventListener("touchstart", cancel, { passive: true });
window.addEventListener("keydown", event => {
  if (["Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "Tab"].includes(event.key)) cancel();
});
document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
reducedMotion.addEventListener("change", cancel);
window.addEventListener("pagehide", () => {
  cancel(); capture();
  // Let native cross-document Back restore this page, including when bfcache is unavailable.
  history.scrollRestoration = "auto";
});
window.addEventListener("pageshow", event => {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (event.persisted || navigation?.type === "back_forward" || navigation?.type === "reload") {
    window.scrollTo({ top: snapshots.get(entry)?.y ?? initial?.y ?? 0, behavior: "instant" });
  }
  history.scrollRestoration = "manual";
});
