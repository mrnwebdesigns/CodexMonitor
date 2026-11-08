(() => {
  if (window !== window.top || window.__codexMonitorBrowser) return;
  let active = false;
  let outline = null;
  let selected = null;
  const selectorFor = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let node = element;
    while (node && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList || []).filter((name) => !name.startsWith('codex-monitor')).slice(0, 2);
      if (classes.length) part += classes.map((name) => '.' + CSS.escape(name)).join('');
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((item) => item.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part); node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const clear = () => { if (outline) outline.remove(); outline = null; selected = null; };
  const setActive = (value) => { active = Boolean(value); if (!active) clear(); };
  Object.defineProperty(window, '__codexMonitorBrowser', { value: { setActive }, writable: false });
  document.addEventListener('pointermove', (event) => {
    if (!active || !(event.target instanceof Element)) return;
    selected = event.target;
    if (!outline) {
      outline = document.createElement('div');
      outline.setAttribute('aria-hidden', 'true');
      outline.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #6554e8;background:rgba(101,84,232,.08);z-index:2147483647;box-sizing:border-box;';
      document.documentElement.appendChild(outline);
    }
    const rect = selected.getBoundingClientRect();
    Object.assign(outline.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }, true);
  document.addEventListener('click', (event) => {
    if (!active || !(event.target instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const element = event.target;
    const rect = element.getBoundingClientRect();
    // Capture visible page labels, never form values or hidden markup.
    const text = element.matches('input,textarea,select,[contenteditable]') ? '' : (element.innerText || element.textContent || '').slice(0, 1200);
    const payload = { url: location.href.slice(0, 4096), title: document.title.slice(0, 512), selector: selectorFor(element).slice(0, 1024), text, tag: element.tagName.toLowerCase(), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    setActive(false);
    location.href = 'codex-monitor-annotation://selection?payload=' + encodeURIComponent(JSON.stringify(payload));
  }, true);
  document.addEventListener('keydown', (event) => { if (active && event.key === 'Escape') { event.preventDefault(); setActive(false); } }, true);
})();
