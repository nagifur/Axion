export function getPersonnelImages() {
  const images = import.meta.globEager('../assets/images/*/*.{png,jpg,jpeg,webp}');
  return Object.fromEntries(
    Object.entries(images).map(([path, mod]) => {
      const key = path.replace(/^\.\.\/assets\/images\//, '');
      return [key, mod.default];
    })
  );
}
