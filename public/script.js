
  function setImageState(img) {
    if (!img || !img.getAttribute('src') || img.dataset.imageStateBound === 'true') return;
    img.dataset.imageStateBound = 'true';
    img.classList.add('image-loading');

    function finish(state) {
      img.classList.remove('image-loading');
      img.classList.toggle('image-error', state === 'error');
      img.dataset.imageState = state;
    }

    img.addEventListener('load', () => finish('loaded'), { once: true });
    img.addEventListener('error', () => finish('error'), { once: true });
    if (img.complete) finish(img.naturalWidth > 0 ? 'loaded' : 'error');
  }

  document.querySelectorAll('img').forEach(setImageState);

  const overlay = document.getElementById('lightbox');
  const overlayImg = overlay ? overlay.querySelector('img') : null;
  const closeBtn = document.getElementById('lightbox-close');

  function openLightbox(src, alt) {
    if (!overlay || !overlayImg) return;
    overlayImg.src = src;
    overlayImg.alt = alt || '';
    setImageState(overlayImg);
    overlay.hidden = false;
    overlay.focus();
  }

  function closeLightbox() {
    if (!overlay || !overlayImg) return;
    overlay.hidden = true;
    overlayImg.src = '';
    overlayImg.alt = '';
  }

  // Make gallery images clickable
  document.querySelectorAll('.gallery-grid img').forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => {
      // Prefer currentSrc when srcset is in use
      const src = img.currentSrc || img.src;
      openLightbox(src, img.alt);
    });
    // Keyboard accessibility
    img.tabIndex = 0;
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const src = img.currentSrc || img.src;
        openLightbox(src, img.alt);
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
    var lightMediaQuery = null;
    try { lightMediaQuery = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)'); } catch (_) {}
    var prefersLight = lightMediaQuery ? lightMediaQuery.matches : false;
    var initial = stored || (prefersLight ? 'light' : 'dark');
    applyTheme(initial);
    updateToggle(initial);

    // Follow the OS theme live until the user picks one manually.
    if (lightMediaQuery){
      var handleOsThemeChange = function(e){
        if (stored) return;
        var next = e.matches ? 'light' : 'dark';
        beginThemeTransition();
        applyTheme(next);
        updateToggle(next);
      };
      if (lightMediaQuery.addEventListener) {
        lightMediaQuery.addEventListener('change', handleOsThemeChange);
      } else if (lightMediaQuery.addListener) {
        lightMediaQuery.addListener(handleOsThemeChange);
      }
    }

    var toggle = document.getElementById('theme-toggle');
    if (toggle){
      toggle.addEventListener('click', function(){
        var currentIsLight = document.body.classList.contains('light');
        var next = currentIsLight ? 'dark' : 'light';
        beginThemeTransition();
        applyTheme(next);
        updateToggle(next);
        stored = next;
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
      normalizedPath === '/' ||
      normalizedPath === '/index.html';

    var introSeenKey = 'axion-intro-seen';
    var introSeen = false;
    try { introSeen = localStorage.getItem(introSeenKey) === '1'; } catch (_) {}

    var shouldRunIntro = isHome || !introSeen;
    document.body.classList.toggle('header-intro', shouldRunIntro);

    if (!introSeen) {
      try { localStorage.setItem(introSeenKey, '1'); } catch (_) {}
    }
  })();

  // Database tablist: instant in-page panel switching
  (function(){
    var tablist = document.querySelector('.db-pane-nav[role="tablist"]');
    if (!tablist) return;

    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('.db-panel[role="tabpanel"]'));
    if (!tabs.length || !panels.length) return;

    function setActiveTab(tab, shouldFocus){
      var controlsId = tab.getAttribute('aria-controls');

      tabs.forEach(function(item){
        var isActive = item === tab;
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        item.setAttribute('tabindex', isActive ? '0' : '-1');
      });

      panels.forEach(function(panel){
        var isTarget = panel.id === controlsId;
        panel.hidden = !isTarget;
        panel.classList.toggle('db-panel-active', isTarget);
      });

      if (shouldFocus) {
        tab.focus();
      }
    }

    tabs.forEach(function(tab){
      tab.addEventListener('click', function(){
        setActiveTab(tab, false);
      });

      tab.addEventListener('keydown', function(event){
        var currentIndex = tabs.indexOf(tab);
        if (currentIndex < 0) return;

        var nextIndex = currentIndex;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          nextIndex = (currentIndex + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabs.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        setActiveTab(tabs[nextIndex], true);
      });
    });

    var initial = tabs.find(function(tab){ return tab.getAttribute('aria-selected') === 'true'; }) || tabs[0];
    setActiveTab(initial, false);
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
