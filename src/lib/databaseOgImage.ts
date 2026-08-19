export interface DatabaseOgField {
  label: string;
  value: string;
}

interface DatabaseOgImageOptions {
  title: string;
  subtitle?: string;
  id: string;
  tint?: string;
  image?: string;
  fields: DatabaseOgField[];
}

const escapeXml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const truncate = (value: string, length = 30) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

export const createDatabaseOgImage = ({
  title,
  subtitle,
  id,
  tint = '#7ef5ff',
  image,
  fields,
}: DatabaseOgImageOptions) => {
  const safeTint = escapeXml(tint);
  const safeTitle = escapeXml(title);
  const safeSubtitle = subtitle ? escapeXml(subtitle) : '';
  const safeId = escapeXml(id);
  const fieldMarkup = fields.slice(0, 7).map((field, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = column === 0 ? 280 : 690;
    const y = 190 + row * 92;
    const safeLabel = escapeXml(field.label.toUpperCase());
    const safeValue = escapeXml(truncate(field.value));

    return `
      <g transform="translate(${x} ${y})">
        <rect width="380" height="72" rx="7" fill="${safeTint}" fill-opacity=".16" stroke="${safeTint}" stroke-opacity=".35" />
        <rect width="4" height="72" rx="2" fill="${safeTint}" />
        <text x="18" y="27" class="label">${safeLabel}</text>
        <text x="18" y="54" class="value">${safeValue}</text>
      </g>`;
  }).join('');

  const imageMarkup = image
    ? `<clipPath id="profile-clip"><rect x="42" y="190" width="198" height="264" rx="7" /></clipPath>
       <image href="${escapeXml(image)}" x="42" y="190" width="198" height="264" preserveAspectRatio="xMidYMid slice" clip-path="url(#profile-clip)" />`
    : `<rect x="42" y="190" width="198" height="264" rx="7" fill="${safeTint}" fill-opacity=".12" stroke="${safeTint}" stroke-opacity=".35" />`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a1715" />
      <stop offset="1" stop-color="#020607" />
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${safeTint}" stop-opacity=".13" />
      <stop offset="1" stop-color="${safeTint}" stop-opacity=".04" />
    </linearGradient>
    <style>
      .title { fill: ${safeTint}; font: 800 54px 'Arial Black', Arial, sans-serif; letter-spacing: 3px; }
      .subtitle { fill: ${safeTint}; font: 700 22px Arial, sans-serif; }
      .eyebrow { fill: #9ab6bf; font: 700 16px monospace; letter-spacing: 4px; }
      .label { fill: #c4dce2; font: 15px monospace; letter-spacing: 1px; }
      .value { fill: #f0fbff; font: 20px monospace; }
      .id { fill: #aac4cb; font: 16px monospace; letter-spacing: 2px; }
      .brand { fill: #8faab2; font: 700 15px monospace; letter-spacing: 4px; }
    </style>
  </defs>
  <rect width="1200" height="630" fill="url(#background)" />
  <rect x="28" y="28" width="1144" height="574" rx="8" fill="none" stroke="${safeTint}" stroke-opacity=".45" />
  <path d="M28 28h60M28 28v60M1172 602h-60M1172 602v-60" stroke="${safeTint}" stroke-width="4" />
  <text x="58" y="76" class="brand">AXION LABS // DATABASE FILE</text>
  <text x="58" y="142" class="title">${safeTitle}</text>
  ${safeSubtitle ? `<text x="60" y="170" class="subtitle">&quot;${safeSubtitle}&quot;</text>` : ''}
  ${imageMarkup}
  <text x="141" y="485" text-anchor="middle" class="id">ID ${safeId}</text>
  <rect x="280" y="170" width="790" height="372" rx="9" fill="url(#panel)" stroke="${safeTint}" stroke-opacity=".22" />
  ${fieldMarkup}
  <text x="1128" y="574" text-anchor="end" class="eyebrow">SECURE CHANNEL</text>
</svg>`;
};
