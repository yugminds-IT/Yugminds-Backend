/**
 * Certificate SVG/JPEG rendering — extracted from StudentExtraController so
 * the shared CertificateService (used by student self-issuance, admin
 * batch-generate, and the auto-issuance hook) can build a certificate
 * without depending on the student controller. StudentExtraController's own
 * static methods of the same name now just delegate here, so every existing
 * caller (admin regenerate/batch-generate) is unaffected.
 */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Derives a short, human-readable certificate code from a UUID (e.g. "YM-A1B2C3D4") */
export function shortCertId(fullId: string): string {
  return 'YM-' + fullId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export async function svgToJpegBuffer(svg: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require('sharp') as typeof import('sharp');
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

export function buildCertificateSvg(
  params: {
    studentName: string;
    courseTitle: string;
    issuedAt: string;
    certificateId: string;
  },
  templateSvg?: string | null,
): string {
  const student = escapeXml(params.studentName);
  const course = escapeXml(params.courseTitle);
  const issued = escapeXml(params.issuedAt);
  const shortId = escapeXml(shortCertId(params.certificateId));

  // If a custom template is provided, replace placeholders and return it
  if (templateSvg) {
    return templateSvg
      .replace(/\{\{studentName\}\}/g, student)
      .replace(/\{\{courseTitle\}\}/g, course)
      .replace(/\{\{issuedAt\}\}/g, issued)
      .replace(/\{\{certificateId\}\}/g, shortId);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="850" viewBox="0 0 1200 850">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f2a6d"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="850" fill="#f8fafc"/>
  <rect x="40" y="40" width="1120" height="770" rx="28" fill="white" stroke="#e2e8f0" stroke-width="4"/>
  <rect x="40" y="40" width="1120" height="140" rx="28" fill="url(#g)"/>
  <text x="600" y="125" font-family="Inter, Arial" font-size="44" font-weight="700" text-anchor="middle" fill="white">Certificate of Achievement</text>

  <text x="600" y="260" font-family="Inter, Arial" font-size="22" text-anchor="middle" fill="#334155">This certifies that</text>
  <text x="600" y="340" font-family="Georgia, 'Times New Roman'" font-size="56" font-weight="700" text-anchor="middle" fill="#0f172a">${student}</text>
  <text x="600" y="410" font-family="Inter, Arial" font-size="20" text-anchor="middle" fill="#475569">has successfully completed</text>
  <text x="600" y="470" font-family="Inter, Arial" font-size="34" font-weight="700" text-anchor="middle" fill="#111827">${course}</text>

  <g>
    <circle cx="150" cy="670" r="54" fill="#fef3c7" stroke="#f59e0b" stroke-width="6"/>
    <path d="M150 630 L162 656 L190 659 L168 677 L175 705 L150 690 L125 705 L132 677 L110 659 L138 656 Z" fill="#f59e0b"/>
  </g>

  <text x="600" y="615" font-family="Inter, Arial" font-size="18" text-anchor="middle" fill="#475569">Issued: ${issued}</text>
  <text x="600" y="648" font-family="Inter, Arial" font-size="15" font-weight="600" text-anchor="middle" fill="#1e40af">Certificate ID: ${shortId}</text>
  <text x="600" y="675" font-family="Inter, Arial" font-size="12" text-anchor="middle" fill="#64748b">Verify at: yugminds.com/robocoders/lms/verify/${shortId}</text>

  <line x1="820" y1="710" x2="1080" y2="710" stroke="#cbd5e1" stroke-width="2"/>
  <text x="950" y="740" font-family="Inter, Arial" font-size="16" text-anchor="middle" fill="#334155">Yugminds</text>
</svg>`;
}
