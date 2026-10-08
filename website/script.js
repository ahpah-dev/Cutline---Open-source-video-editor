(() => {
  const views = {
    effects: { src: '/assets/studio-effects.png', alt: 'Cutline effects library, video preview, inspector and multilayer timeline', caption: 'A flexible timeline. A preview that feels like your canvas.' },
    color: { src: '/assets/color-grading.png', alt: 'Cutline advanced color-grading controls with color wheels and a video preview', caption: 'Shape the look with color wheels, curves and selective adjustments.' },
    transitions: { src: '/assets/studio-transitions.png', alt: 'Cutline transition library beside the video preview and timeline', caption: '44 transitions that blend both sides of the cut.' },
    scenes: { src: '/assets/scene-cuts.png', alt: 'Cutline scene detection with before and after cut thumbnails and review controls', caption: 'Find hard cuts, review each suggestion, then split or mark the scenes.' },
    beats: { src: '/assets/auto-beats.png', alt: 'Cutline local automatic beat analysis and timeline marker review', caption: 'Find the rhythm locally. Put your next edit on the beat.' },
    codex: { src: '/assets/codex-media.png', alt: 'Cutline Codex editing panel with reasoning controls and media context', caption: 'Describe the edit. Share visual and local audio-analysis context with Codex.' },
    themes: { src: '/assets/theme-light.png', alt: 'Cutline in its light workspace theme with matching top bar', caption: 'Four workspace themes, including a bright, focused Light mode.' }
  };
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const image = document.getElementById('studio-image');
  const caption = document.getElementById('studio-caption');
  const panel = document.getElementById('gallery-panel');
  const dialog = document.getElementById('screenshot-dialog');
  let activeView = 'effects';
  function selectView(tab, focus = false) {
    const key = tab.dataset.view;
    const view = views[key];
    if (!view) return;
    activeView = key;
    tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    image.src = view.src;
    image.alt = view.alt;
    caption.textContent = view.caption;
    panel.setAttribute('aria-labelledby', tab.id);
    document.getElementById('gallery-index').textContent = `${String(tabs.indexOf(tab) + 1).padStart(2, '0')} / 07`;
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectView(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectView(tabs[next], true); }
    });
  });
  function openScreenshot(key) {
    const view = views[key];
    if (!view) return;
    const enlarged = document.getElementById('enlarged-image');
    enlarged.src = view.src;
    enlarged.alt = view.alt;
    document.getElementById('enlarged-caption').textContent = view.caption;
    document.getElementById('screenshot-title').textContent = `Cutline / ${tabs.find(tab => tab.dataset.view === key).textContent.replace('NEW', '').trim()}`;
    dialog.showModal();
  }
  document.getElementById('expand-gallery').addEventListener('click', () => openScreenshot(activeView));
  document.querySelectorAll('[data-open-view]').forEach(button => button.addEventListener('click', () => openScreenshot(button.dataset.openView)));
  document.getElementById('close-screenshot').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
})();
