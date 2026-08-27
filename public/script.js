
// Carry the current theme onto the incoming document before a view transition
// swap so client-side navigation never briefly flashes the default theme.
document.addEventListener('astro:before-swap', function (event) {
  var current = document.documentElement.getAttribute('data-theme');
  if (current) event.newDocument.documentElement.setAttribute('data-theme', current);
  // The incoming document's <html> is fresh (no 'js' class yet), so the inline
  // .tooltip-bubble fallback would flash alongside the JS portal without this.
  event.newDocument.documentElement.classList.add('js');
});

// Shared "portal" bubble for .hover-tooltip: appended directly to <body> so tooltips render
// above every div instead of being clipped by whichever ancestor has overflow:hidden. View
// transitions can remove/replace this node, so it's always re-fetched via getTooltipPortal()
// rather than cached in a closure.
function getTooltipPortal() {
  var portal = document.querySelector('.tooltip-bubble-portal');
  if (!portal) {
    portal = document.createElement('div');
    portal.className = 'tooltip-bubble-portal';
    portal.setAttribute('aria-hidden', 'true');
    document.body.appendChild(portal);
  }
  return portal;
}

function positionTooltipPortal(trigger, portal) {
  const rect = trigger.getBoundingClientRect();
  const gap = 8;
  const bubbleRect = portal.getBoundingClientRect();
  const margin = 8;

  const centerX = Math.min(
    Math.max(rect.left + rect.width / 2, bubbleRect.width / 2 + margin),
    window.innerWidth - bubbleRect.width / 2 - margin
  );

  const fitsAbove = rect.top - gap - bubbleRect.height >= margin;
  const top = fitsAbove ? rect.top - gap : rect.bottom + gap;
  const translateY = fitsAbove ? '-100%' : '0%';

  portal.style.left = `${centerX}px`;
  portal.style.top = `${top}px`;
  portal.style.transform = `translate(-50%, ${translateY})`;
}

// Keep the active bubble aligned with its trigger while the page scrolls/resizes. Bound once
// at script load (not inside astro:page-load) so it never gets duplicated across navigations.
function repositionActiveTooltip() {
  const active = document.querySelector('.hover-tooltip.is-tooltip-active');
  if (active) positionTooltipPortal(active, getTooltipPortal());
}
window.addEventListener('scroll', repositionActiveTooltip, { passive: true, capture: true });
window.addEventListener('resize', repositionActiveTooltip);

// Return to the page that opened database content; the href remains a fallback for direct visits.
document.addEventListener('click', function (event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  var link = event.target.closest('.article-return a, .article-return-top a');
  if (!link || window.history.length <= 1) return;

  event.preventDefault();
  window.history.back();
}, true);

// Astro view transitions swap the document without reloading script.js, so all
// DOM bindings must be re-run after every navigation via astro:page-load.
document.addEventListener('astro:page-load', function () {
  var topWindowZ = 9996;

  function getOwnFullscreenButton(card) {
    return card.querySelector(':scope > .window-controls .window-control-fullscreen');
  }

  function rememberWindowTint(card) {
    var profileTint = getComputedStyle(card).getPropertyValue('--profile-tint').trim();
    if (profileTint) {
      card.style.setProperty('--window-fullscreen-tint', profileTint);
    }
  }

  function createWindowPlaceholder(card) {
    if (card._windowPlaceholder && card._windowPlaceholder.parentNode) return card._windowPlaceholder;
    if (!card.parentNode) return null;

    var rect = card.getBoundingClientRect();
    var placeholder = document.createElement('div');
    placeholder.className = 'window-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.style.setProperty('--window-placeholder-height', Math.round(rect.height) + 'px');
    card.parentNode.insertBefore(placeholder, card);
    card._windowPlaceholder = placeholder;
    return placeholder;
  }

  function setFloatingPosition(card, left, top) {
    card.style.setProperty('--window-x', Math.round(left) + 'px');
    card.style.setProperty('--window-y', Math.round(top) + 'px');
  }

  function enterFloatingWindow(card, left, top) {
    createWindowPlaceholder(card);
    rememberWindowTint(card);

    var rect = card.getBoundingClientRect();
    card.style.setProperty('--window-width', Math.round(rect.width) + 'px');
    document.body.appendChild(card);
    card.classList.add('is-window-floating');
    card.style.zIndex = String(++topWindowZ);
    setFloatingPosition(card, left, top);
  }

  function restoreWindowPlacement(card) {
    var placeholder = card._windowPlaceholder;
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(card, placeholder);
      placeholder.remove();
    }
    card._windowPlaceholder = null;
    card.classList.remove('is-window-floating', 'is-window-dragging');
    card.style.removeProperty('--window-x');
    card.style.removeProperty('--window-y');
    card.style.removeProperty('--window-width');
    card.style.zIndex = '';
  }

  function enterFullscreenWindow(card) {
    createWindowPlaceholder(card);
    rememberWindowTint(card);
    document.body.appendChild(card);
    card.classList.remove('is-window-floating', 'is-window-dragging');
    card.classList.add('is-window-fullscreen');
    card.style.zIndex = '';
  }

  function clearFullscreenWindow(activeCard) {
    document.querySelectorAll('.card.is-window-fullscreen').forEach(function(card){
      if (!activeCard || card !== activeCard) {
        card.classList.remove('is-window-fullscreen');
        restoreWindowPlacement(card);
        var fullscreenButton = getOwnFullscreenButton(card);
        if (fullscreenButton) fullscreenButton.setAttribute('aria-pressed', 'false');
      }
    });

    if (!activeCard) {
      document.body.classList.remove('has-fullscreen-window');
    }
  }

  function initializeWindowControls() {
    document.querySelectorAll('.card').forEach(function(card){
      if (card.dataset.windowControlsBound === 'true') return;
      card.dataset.windowControlsBound = 'true';

      var controls = document.createElement('div');
      controls.className = 'window-controls';
      controls.setAttribute('aria-label', 'Window controls');

      var dragHandle = document.createElement('div');
      dragHandle.className = 'window-drag-handle';
      dragHandle.setAttribute('aria-hidden', 'true');

      var closeButton = document.createElement('button');
      closeButton.className = 'window-control window-control-close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', 'Close window');
      closeButton.title = 'Close window';

      var minimizeButton = document.createElement('button');
      minimizeButton.className = 'window-control window-control-minimize';
      minimizeButton.type = 'button';
      minimizeButton.setAttribute('aria-label', 'Minimize window');
      minimizeButton.setAttribute('aria-pressed', 'false');
      minimizeButton.title = 'Minimize window';

      var fullscreenButton = document.createElement('button');
      fullscreenButton.className = 'window-control window-control-fullscreen';
      fullscreenButton.type = 'button';
      fullscreenButton.setAttribute('aria-label', 'Toggle fullscreen window');
      fullscreenButton.setAttribute('aria-pressed', 'false');
      fullscreenButton.title = 'Toggle fullscreen window';

      controls.append(closeButton, minimizeButton, fullscreenButton);
      card.prepend(dragHandle);
      card.prepend(controls);

      function beginWindowDrag(event) {
        if (card._windowDragActive || event.button !== 0) return;
        if (card.classList.contains('is-window-fullscreen') || card.classList.contains('is-window-closing') || card.classList.contains('is-window-closed')) return;

        event.preventDefault();
        card._windowDragActive = true;
        var rect = card.getBoundingClientRect();
        var offsetX = event.clientX - rect.left;
        var offsetY = event.clientY - rect.top;
        var startLeft = rect.left + window.scrollX;
        var startTop = rect.top + window.scrollY;

        enterFloatingWindow(card, startLeft, startTop);
        card.classList.add('is-window-dragging');

        function moveWindow(moveEvent) {
          setFloatingPosition(card, moveEvent.clientX + window.scrollX - offsetX, moveEvent.clientY + window.scrollY - offsetY);
        }

        function stopDragging() {
          card._windowDragActive = false;
          card.classList.remove('is-window-dragging');
          document.removeEventListener('pointermove', moveWindow);
          document.removeEventListener('pointerup', stopDragging);
          document.removeEventListener('pointercancel', stopDragging);
          document.removeEventListener('mousemove', moveWindow);
          document.removeEventListener('mouseup', stopDragging);
          try { dragHandle.releasePointerCapture(event.pointerId); } catch (_) {}
        }

        if (event.type === 'pointerdown') {
          try { dragHandle.setPointerCapture(event.pointerId); } catch (_) {}
          document.addEventListener('pointermove', moveWindow);
          document.addEventListener('pointerup', stopDragging, { once: true });
          document.addEventListener('pointercancel', stopDragging, { once: true });
        } else {
          document.addEventListener('mousemove', moveWindow);
          document.addEventListener('mouseup', stopDragging, { once: true });
        }
      }

      dragHandle.addEventListener('pointerdown', beginWindowDrag);
      dragHandle.addEventListener('mousedown', beginWindowDrag);

      closeButton.addEventListener('click', function(event){
        event.preventDefault();
        event.stopPropagation();
        restoreWindowPlacement(card);
        var animationsOff = document.body.classList.contains('animations-off') || document.documentElement.getAttribute('data-animations') === 'off';
        var closeTimer = null;
        function closeWindow() {
          if (card.classList.contains('is-window-closed')) return;
          if (closeTimer) window.clearTimeout(closeTimer);
          card.classList.add('is-window-closed');
          card.classList.remove('is-window-closing');
        }
        if (animationsOff) {
          closeWindow();
        } else {
          card.classList.add('is-window-closing');
          card.addEventListener('animationend', function(event){
            if (event.target === card) closeWindow();
          }, { once: true });
          closeTimer = window.setTimeout(closeWindow, 320);
        }
        card.classList.remove('is-window-minimized', 'is-window-fullscreen');
        if (!document.querySelector('.card.is-window-fullscreen')) {
          document.body.classList.remove('has-fullscreen-window');
        }
      });

      minimizeButton.addEventListener('click', function(event){
        event.preventDefault();
        event.stopPropagation();
        var wasFullscreen = card.classList.contains('is-window-fullscreen');
        var isMinimized = card.classList.toggle('is-window-minimized');
        if (isMinimized) {
          card.classList.remove('is-window-fullscreen');
          if (wasFullscreen) restoreWindowPlacement(card);
          fullscreenButton.setAttribute('aria-pressed', 'false');
          if (!document.querySelector('.card.is-window-fullscreen')) {
            document.body.classList.remove('has-fullscreen-window');
          }
        }
        minimizeButton.setAttribute('aria-pressed', isMinimized ? 'true' : 'false');
        minimizeButton.title = isMinimized ? 'Restore window' : 'Minimize window';
      });

      fullscreenButton.addEventListener('click', function(event){
        event.preventDefault();
        event.stopPropagation();
        var willFullscreen = !card.classList.contains('is-window-fullscreen');
        clearFullscreenWindow(card);
        if (willFullscreen) {
          enterFullscreenWindow(card);
        } else {
          card.classList.remove('is-window-fullscreen');
          restoreWindowPlacement(card);
        }
        card.classList.remove('is-window-minimized');
        minimizeButton.setAttribute('aria-pressed', 'false');
        minimizeButton.title = 'Minimize window';
        fullscreenButton.setAttribute('aria-pressed', willFullscreen ? 'true' : 'false');
        document.body.classList.toggle('has-fullscreen-window', willFullscreen);
      });
    });
  }

  initializeWindowControls();

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

  document.querySelectorAll('.hover-tooltip').forEach((tooltip) => {
    const setActive = () => {
      tooltip.classList.add('is-tooltip-active');
      const portal = getTooltipPortal();
      portal.textContent = tooltip.dataset.tooltip || '';
      positionTooltipPortal(tooltip, portal);
      portal.classList.add('is-active');
    };
    const setInactive = () => {
      tooltip.classList.remove('is-tooltip-active');
      getTooltipPortal().classList.remove('is-active');
    };
    tooltip.addEventListener('mouseenter', setActive);
    tooltip.addEventListener('mouseleave', setInactive);
    tooltip.addEventListener('focus', setActive);
    tooltip.addEventListener('blur', setInactive);
  });

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
  document.querySelectorAll('.gallery-grid img, .level-preview img').forEach((img) => {
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
        var currentIsLight = document.documentElement.getAttribute('data-theme') === 'light';
        var next = currentIsLight ? 'dark' : 'light';
        beginThemeTransition();
        applyTheme(next);
        updateToggle(next);
        stored = next;
        try { localStorage.setItem('theme', next); } catch (_) {}
      });
    }
  })();

  // Header intro animation: run once per browser until the visit flag is cleared.
  (function(){
    if (!document.body) return;

    var introSeenKey = 'axion-intro-seen';
    var introSeen = false;
    try { introSeen = localStorage.getItem(introSeenKey) === '1'; } catch (_) {}

    var shouldRunIntro = !introSeen;
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

    function updateScrollCue(){
      var maxScroll = tablist.scrollWidth - tablist.clientWidth;
      var progress = maxScroll > 0 ? tablist.scrollLeft / maxScroll : 0;
      var scrollWrap = tablist.parentElement;
      if (scrollWrap) {
        scrollWrap.style.setProperty('--scroll-cue-opacity', String(Math.max(0.25, 1 - progress * 0.7)));
      }
    }

    tablist.addEventListener('scroll', updateScrollCue, { passive: true });
    window.addEventListener('resize', updateScrollCue);
    updateScrollCue();

    var tabStorageKey = 'db-active-tab';

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

      try { localStorage.setItem(tabStorageKey, tab.id); } catch (_) {}

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

    var storedTabId = null;
    try { storedTabId = localStorage.getItem(tabStorageKey); } catch (_) {}
    var initial = (storedTabId && tabs.find(function(tab){ return tab.id === storedTabId; }))
      || tabs.find(function(tab){ return tab.getAttribute('aria-selected') === 'true'; })
      || tabs[0];
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
});
