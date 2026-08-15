
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
    var themeSwitchTimer = null;

    function beginThemeTransition(){
      if (!document.body) return;
      if (themeSwitchTimer) {
        clearTimeout(themeSwitchTimer);
      }

      document.documentElement.classList.add('theme-switching');
      document.body.classList.add('theme-switching');

      themeSwitchTimer = window.setTimeout(function(){
        document.documentElement.classList.remove('theme-switching');
        document.body.classList.remove('theme-switching');
        themeSwitchTimer = null;
      }, 600);
    }

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
        beginThemeTransition();
        applyTheme(next);
        updateToggle(next);
        try { localStorage.setItem('theme', next); } catch (_) {}
      });
    }
  })();

  // Header intro animation: run on homepage or first visit only
  (function(){
    if (!document.body) return;

    var pathname = '';
    try {
      pathname = (window.location && window.location.pathname ? window.location.pathname : '').toLowerCase();
    } catch (_) {
      pathname = '';
    }

    var normalizedPath = pathname.replace(/\/+$/, '');
    var isHome =
      normalizedPath === '' ||
      normalizedPath === '/' ||
      normalizedPath === '/axion' ||
      normalizedPath === '/axion/index.html';

    var introSeenKey = 'axion-intro-seen';
    var introSeen = false;
    try { introSeen = localStorage.getItem(introSeenKey) === '1'; } catch (_) {}

    var shouldRunIntro = isHome || !introSeen;
    document.body.classList.toggle('header-intro', shouldRunIntro);

    if (!introSeen) {
      try { localStorage.setItem(introSeenKey, '1'); } catch (_) {}
    }
  })();

  // Animation toggle: apply and persist atmospheric motion preference
  (function(){
    var storageKey = 'animations';
    var toggle = document.getElementById('animations-toggle');
    var mediaQuery = null;
    var userEnabled = true;

    try {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch (_) {
      mediaQuery = null;
    }

    function systemForcesOff(){
      return !!(mediaQuery && mediaQuery.matches);
    }

    function applyAnimations(enabled, lockedBySystem){
      if (!document.body) return;
      document.body.classList.toggle('animations-off', !enabled);
      document.documentElement.setAttribute('data-animations', enabled ? 'on' : 'off');

      if (!toggle) return;
      toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      toggle.textContent = enabled ? 'Animations On' : 'Animations Off';

      if (lockedBySystem) {
        toggle.disabled = true;
        toggle.setAttribute('aria-disabled', 'true');
        toggle.title = 'Animations disabled by system reduced-motion preference';
      } else {
        toggle.disabled = false;
        toggle.removeAttribute('aria-disabled');
        toggle.title = enabled ? 'Turn animations off' : 'Turn animations on';
      }
    }

    function updateEffectiveState(){
      var lockedBySystem = systemForcesOff();
      var enabled = lockedBySystem ? false : userEnabled;
      applyAnimations(enabled, lockedBySystem);
    }

    var stored = null;
    try { stored = localStorage.getItem(storageKey); } catch (_) {}
    userEnabled = stored !== 'off';
    updateEffectiveState();

    if (toggle) {
      toggle.addEventListener('click', function(){
        if (systemForcesOff()) return;
        userEnabled = !userEnabled;
        updateEffectiveState();
        try { localStorage.setItem(storageKey, userEnabled ? 'on' : 'off'); } catch (_) {}
      });
    }

    if (mediaQuery) {
      var onChange = function(){ updateEffectiveState(); };
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(onChange);
      }
    }
  })();
