
  const overlay = document.getElementById('lightbox');
  const overlayImg = overlay.querySelector('img');
  const closeBtn = document.getElementById('lightbox-close');

  function openLightbox(src) {
    overlayImg.src = src;
    overlay.hidden = false;
    overlay.focus();
  }

  function closeLightbox() {
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

  // Close interactions
  closeBtn.addEventListener('click', closeLightbox);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeLightbox();
  });
