
  const overlay = document.getElementById('lightbox');
  const overlayImg = overlay ? overlay.querySelector('img') : null;
  const closeBtn = document.getElementById('lightbox-close');

  function openLightbox(src) {
    if (!overlay || !overlayImg) return;
    overlayImg.src = src;
    overlay.hidden = false;
    overlay.focus();
  }

  function closeLightbox() {
    if (!overlay || !overlayImg) return;
    overlay.hidden = true;
    overlayImg.src = '';
  }

  // Make gallery images clickable
  document.querySelectorAll('.gallery-grid img').forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => {
      // Prefer currentSrc when srcset is in use
      const src = img.currentSrc || img.src;
      openLightbox(src);
    });
    // Keyboard accessibility
    img.tabIndex = 0;
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const src = img.currentSrc || img.src;
        openLightbox(src);
      }
    });
  });

  // Close interactions (only if lightbox exists)
  if (overlay && closeBtn) {
    closeBtn.addEventListener('click', closeLightbox);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeLightbox();
    });
  }

  // Theme toggle: apply and persist light/dark mode
  (function(){
    function applyTheme(theme){
      if (!document.body) return;
      document.body.classList.toggle('light', theme === 'light');
      document.documentElement.setAttribute('data-theme', theme);
    }

    function updateToggle(theme){
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var isLight = theme === 'light';
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      btn.textContent = isLight ? 'Dark Mode' : 'Light Mode';
      btn.title = btn.textContent;
    }

    var stored = null;
    try { stored = localStorage.getItem('theme'); } catch (_) {}
    var prefersLight = false;
    try { prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches; } catch (_) {}
    var initial = stored || (prefersLight ? 'light' : 'dark');
    applyTheme(initial);
    updateToggle(initial);

    var toggle = document.getElementById('theme-toggle');
    if (toggle){
      toggle.addEventListener('click', function(){
        var currentIsLight = document.body.classList.contains('light');
        var next = currentIsLight ? 'dark' : 'light';
        applyTheme(next);
        updateToggle(next);
        try { localStorage.setItem('theme', next); } catch (_) {}
      });
    }
  })();
