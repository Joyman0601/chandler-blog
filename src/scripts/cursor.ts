// Adapted from the saved cursor-studies "磁吸圆环" sample.
const cursor = document.querySelector<HTMLElement>(".magnetic-cursor");
if (cursor) {
  const root = document.documentElement;
  const fine = matchMedia("(hover: hover) and (pointer: fine)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const editable = "input, textarea, select, [contenteditable]:not([contenteditable='false']), iframe";
  const interactive = "a[href], button:not(:disabled), summary, [role='button']:not([aria-disabled='true'])";
  let x = 0, y = 0, rx = 0, ry = 0, tx = 0, ty = 0;
  let frame = 0, active = false, lastTime = 0;

  function render() {
    cursor!.style.setProperty("--cursor-x", `${x}px`);
    cursor!.style.setProperty("--cursor-y", `${y}px`);
    cursor!.style.setProperty("--ring-x", `${rx}px`);
    cursor!.style.setProperty("--ring-y", `${ry}px`);
  }

  function animate(time: number) {
    frame = 0;
    if (!active) return;
    // Keep the same following speed on 60 Hz and high-refresh displays.
    const weight = reduced.matches ? 1 : 1 - Math.pow(.75, Math.min(time - lastTime, 64) / (1000 / 60));
    lastTime = time;
    rx += (tx - rx) * weight;
    ry += (ty - ry) * weight;
    if (Math.hypot(tx - rx, ty - ry) < .05) { rx = tx; ry = ty; }
    render();
    if (rx !== tx || ry !== ty) frame = requestAnimationFrame(animate);
  }

  function wake() {
    if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(animate); }
  }

  function reset() {
    active = false;
    cancelAnimationFrame(frame);
    frame = 0;
    root.classList.remove("has-magnetic-cursor");
    cursor!.removeAttribute("data-magnet");
    cursor!.removeAttribute("data-pressed");
  }

  function update(target: Element | null) {
    if (!fine.matches || !target || target.closest(editable)) { reset(); return; }
    const entering = !active;
    active = true;
    tx = x; ty = y;
    const control = target.closest<HTMLElement>(interactive);
    // Use the hovered line of an inline link. Large article links keep a small
    // ring, so a title cannot pull the pointer halfway across the reading column.
    const rects = control ? Array.from(control.getClientRects()) : [];
    const bounds = rects.find(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    const magnet = bounds && bounds.width <= 320 && bounds.height <= 80;
    cursor!.toggleAttribute("data-magnet", Boolean(magnet));
    cursor!.style.setProperty("--cursor-width", `${magnet ? bounds.width + 12 : control ? 28 : 20}px`);
    cursor!.style.setProperty("--cursor-height", `${magnet ? bounds.height + 10 : control ? 28 : 20}px`);
    if (magnet) { tx = bounds.left + bounds.width / 2; ty = bounds.top + bounds.height / 2; }
    if (entering || reduced.matches) { rx = tx; ry = ty; }
    render();
    root.classList.add("has-magnetic-cursor");
    if (!reduced.matches) wake();
  }

  window.addEventListener("pointermove", event => {
    if (event.pointerType !== "mouse") { reset(); return; }
    x = event.clientX; y = event.clientY;
    update(event.target instanceof Element ? event.target : null);
  }, { passive: true });
  window.addEventListener("pointerdown", event => {
    if (event.pointerType !== "mouse") reset();
    else if (active) cursor.setAttribute("data-pressed", "");
  }, { passive: true });
  window.addEventListener("pointerup", () => cursor.removeAttribute("data-pressed"), { passive: true });
  // A fixed cursor must re-measure its target after the document moves.
  window.addEventListener("scroll", () => {
    if (active) update(document.elementFromPoint(x, y));
  }, { passive: true, capture: true });
  window.addEventListener("resize", reset, { passive: true });
  document.documentElement.addEventListener("pointerleave", reset);
  window.addEventListener("pointercancel", reset);
  window.addEventListener("blur", reset);
  window.addEventListener("pagehide", reset);
  window.addEventListener("keydown", reset);
  document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
  fine.addEventListener("change", reset);
  reduced.addEventListener("change", reset);
}
