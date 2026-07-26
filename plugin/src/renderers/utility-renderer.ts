/**
 * SVG pixmap renderer for the Volume dial.
 * #0f172a bg, header, centred content, accent bar.
 */

const W = 200;
const H = 100;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

export interface UtilityRenderData {
  title: string;
  icon?: string;
  value?: string;
  indicator: { value: number; bar_fill_c: string };
}

/**
 * Volume dial LCD.
 *
 * The mode-dots row and the media variant were dropped along with the
 * multi-mode utility dial \u2014 with a single mode there is nothing to page
 * through, so the value sits on the vertical centre line.
 */
export function renderUtilityGeneric(data: UtilityRenderData): string {
  const { title, icon, value, indicator } = data;
  const barColor = indicator.bar_fill_c || '#22c55e';
  const barW = Math.round((180 * indicator.value) / 100);
  const valueY = 62;
  const valStr = value || '--';

  // Text-only values (Muted, Dark, Light) use smaller font — icon conveys state
  const isNumeric = /\d/.test(valStr);
  const valFontSize = isNumeric ? 24 : 18;
  const charPx = Math.round(valFontSize * 0.55);

  let valueSvg: string;
  if (icon) {
    // Center icon+value as a group: estimate widths, compute offset
    const iconPx = 20;                       // emoji ≈ 1em at 20px
    const gap = 4;
    const valPx = valStr.length * charPx;
    const groupX = Math.round(100 - (iconPx + gap + valPx) / 2);
    const iconX = groupX + 10;               // center of icon slot
    const valueX = groupX + iconPx + gap;    // start of value text
    valueSvg = `<text x="${iconX}" y="${valueY}" text-anchor="middle" font-family="Arial,'Yu Gothic UI',Meiryo,sans-serif" font-size="20" fill="${barColor}" opacity="0.7">${icon}</text>`
      + `<text x="${valueX}" y="${valueY}" font-family="Arial,'Yu Gothic UI',Meiryo,sans-serif" font-size="${valFontSize}" font-weight="bold" fill="${barColor}" opacity="0.9">${escapeXml(valStr)}</text>`;
  } else {
    valueSvg = `<text x="100" y="${valueY}" text-anchor="middle" font-family="Arial,'Yu Gothic UI',Meiryo,sans-serif" font-size="${valFontSize}" font-weight="bold" fill="${barColor}" opacity="0.9">${escapeXml(valStr)}</text>`;
  }

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,'Yu Gothic UI',Meiryo,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">${escapeXml(title)}</text>
    ${valueSvg}
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${Math.max(2, barW)}" height="2" rx="1" fill="${barColor}" opacity="0.4"/>
  `);
}
