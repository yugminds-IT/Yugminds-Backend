import * as path from 'path';
import * as fs from 'fs';

/**
 * One report document for every dashboard. Same vocabulary as the RoboCoders LMS UI:
 * navy hero with the blueprint grid, divided stat strip, hairline tables, Bricolage + Figtree.
 * RoboCoders is the product; Yugminds is the company behind it (footer mark).
 *
 * Cell conventions (so report builders stay plain string[][]):
 *  - a cell with "\n" is two-line: first line is the name, the rest is a muted detail line
 *  - kind 'bar' cells hold a number 0-100 (drawn as a bar + "72%"); '—' means no data
 *  - kind 'date' columns never wrap or shrink
 *  - kind 'status' cells get a coloured dot (Active/Published blue, Draft amber, anything else grey)
 */
export interface ReportColumn {
  label: string;
  kind?: 'text' | 'num' | 'bar' | 'status' | 'date';
}

export interface ReportChart {
  title: string;
  items: Array<{ label: string; value: number }>;
}

export interface ReportPdfOptions {
  title: string; // e.g. "School report"
  scope: string; // one plain sentence: who/what the report covers
  generatedAt: Date;
  stats: Array<{ label: string; value: string | number }>;
  focus?: string; // stat label this report is about; gets the amber marker
  charts?: ReportChart[]; // up to 2, drawn side by side above the table
  columns: ReportColumn[];
  rows: string[][];
  footnote?: string;
  landscape?: boolean; // wide tables
}

const C = {
  navy: '#0a1f4d',
  grid: '#12306f',
  navySoft: '#bccaf0',
  ink: '#0b1b3a',
  inkSoft: '#3d4b69',
  blue: '#2563eb',
  amber: '#fbbf24',
  amberDeep: '#f59e0b',
  line: '#d3dcef',
  wash: '#eef3fc',
  mute: '#8a97b5',
};

// src/common/reports → src/assets (ts-node/dev); dist/src/common/reports → dist/assets (built, copied by nest-cli).
const ASSETS =
  [
    path.join(__dirname, '../../assets'),
    path.join(__dirname, '../../../assets'),
  ].find((p) => fs.existsSync(path.join(p, 'fonts'))) ??
  path.join(__dirname, '../../../assets');
const FONTS = path.join(ASSETS, 'fonts');
const M = 44; // page margin

export function buildReportPdf(o: ReportPdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PDFDocument = require('pdfkit');
    // Bottom margin 0: we place every element ourselves, so pdfkit must never auto-add a page.
    const doc = new PDFDocument({
      size: 'A4',
      layout: o.landscape ? 'landscape' : 'portrait',
      margins: { top: M, left: M, right: M, bottom: 0 },
      bufferPages: true,
      info: { Title: o.title, Author: 'Yugminds', Creator: 'RoboCoders LMS' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const font = (name: string, file: string, fallback: string) => {
      try {
        doc.registerFont(name, path.join(FONTS, file));
      } catch {
        doc.registerFont(name, fallback);
      }
    };
    font(
      'Display',
      'bricolage-grotesque-latin-800-normal.woff',
      'Helvetica-Bold',
    );
    font('Body', 'figtree-latin-400-normal.woff', 'Helvetica');
    font('BodySemi', 'figtree-latin-600-normal.woff', 'Helvetica-Bold');
    font('BodyBold', 'figtree-latin-700-normal.woff', 'Helvetica-Bold');

    const W = doc.page.width;
    const H = doc.page.height;
    const CW = W - M * 2;
    const FOOT_Y = H - 40; // content must end above this
    const logo = (file: string, x: number, y: number, height: number) => {
      const p = path.join(ASSETS, file);
      if (!fs.existsSync(p)) return;
      try {
        doc.image(p, x, y, { height });
      } catch {
        /* logo is optional */
      }
    };

    // pdfkit's `ellipsis` does not hold with lineBreak:false, so shorten by measuring.
    const fit = (text: string, width: number) => {
      if (doc.widthOfString(text) <= width) return text;
      let t = text;
      while (t.length > 1 && doc.widthOfString(`${t}…`) > width)
        t = t.slice(0, -1);
      return `${t.trimEnd()}…`;
    };

    const date = o.generatedAt.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = o.generatedAt
      .toLocaleTimeString('en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      .toLowerCase();

    // ── Masthead: product mark left, when it was made right ────────────────────
    logo('robocoders-logo.png', M - 4, 30, 50);
    doc
      .font('Body')
      .fontSize(9.5)
      .fillColor(C.inkSoft)
      .text(`Generated ${date}, ${time}`, M, 48, {
        width: CW,
        align: 'right',
        lineBreak: false,
      });

    // ── Hero: navy card with the dashboard's blueprint grid ───────────────────
    const heroY = 94;
    const heroH = 138;
    doc.save();
    doc.roundedRect(M, heroY, CW, heroH, 18).clip();
    doc.rect(M, heroY, CW, heroH).fill(C.navy);
    doc.lineWidth(0.6).strokeColor(C.grid);
    for (let gx = M + 22; gx < M + CW; gx += 22)
      doc
        .moveTo(gx, heroY)
        .lineTo(gx, heroY + heroH)
        .stroke();
    for (let gy = heroY + 22; gy < heroY + heroH; gy += 22)
      doc
        .moveTo(M, gy)
        .lineTo(M + CW, gy)
        .stroke();
    doc.restore();
    doc.roundedRect(M + 28, heroY + 30, 34, 4, 2).fill(C.amber);
    let titleSize = 34; // long titles shrink to stay on one line
    doc.font('Display');
    while (
      titleSize > 22 &&
      doc.fontSize(titleSize).widthOfString(o.title) > CW - 56
    )
      titleSize -= 1;
    doc
      .fillColor('#ffffff')
      .text(o.title, M + 28, heroY + 46 + (34 - titleSize) / 2, {
        width: CW - 56,
        lineBreak: false,
      });
    doc
      .font('Body')
      .fontSize(11.5)
      .fillColor(C.navySoft)
      .text(o.scope, M + 28, heroY + 94, {
        width: CW - 56,
        height: 32,
        ellipsis: true,
      });

    let y = heroY + heroH + 16;

    const runningHeader = () => {
      logo('robocoders-logo.png', M - 2, 26, 26);
      doc
        .font('BodySemi')
        .fontSize(9.5)
        .fillColor(C.inkSoft)
        .text(o.title, M, 36, { width: CW, align: 'right', lineBreak: false });
      y = 82;
    };

    // ── Stat strip: one bordered band, hairline dividers, amber marks the subject ──
    if (o.stats.length) {
      const sh = 66;
      const cw = CW / o.stats.length;
      doc
        .roundedRect(M, y, CW, sh, 14)
        .lineWidth(1)
        .strokeColor(C.line)
        .stroke();
      o.stats.forEach((s, i) => {
        const x = M + i * cw;
        if (i > 0)
          doc
            .moveTo(x, y + 14)
            .lineTo(x, y + sh - 14)
            .lineWidth(1)
            .strokeColor(C.line)
            .stroke();
        const shown =
          typeof s.value === 'number'
            ? s.value.toLocaleString('en-IN')
            : s.value;
        doc
          .font('Display')
          .fontSize(24)
          .fillColor(C.ink)
          .text(shown, x + 18, y + 11, { width: cw - 30, lineBreak: false });
        doc
          .font('Body')
          .fontSize(9.5)
          .fillColor(C.inkSoft)
          .text(s.label, x + 18, y + 42, { width: cw - 30, lineBreak: false });
        if (o.focus && s.label.toLowerCase() === o.focus.toLowerCase()) {
          doc.roundedRect(x + 18, y + sh - 5, 28, 3, 1.5).fill(C.amberDeep);
        }
      });
      y += sh + 18;
    } else y += 10;

    // ── Charts: horizontal bars in washed cards, side by side ─────────────────
    const charts = (o.charts ?? [])
      .filter((c) => c.items.length > 0)
      .slice(0, 2);
    if (charts.length) {
      const gap = 14;
      const cardW = (CW - gap * (charts.length - 1)) / charts.length;
      const rowH = 17;
      const cardH = 40 + Math.max(...charts.map((c) => c.items.length)) * rowH;
      if (y + cardH > FOOT_Y - 20) {
        doc.addPage();
        runningHeader();
      }
      charts.forEach((ch, ci) => {
        const x = M + ci * (cardW + gap);
        doc.roundedRect(x, y, cardW, cardH, 14).fill(C.wash);
        doc
          .font('BodyBold')
          .fontSize(10.5)
          .fillColor(C.ink)
          .text(ch.title, x + 16, y + 14, {
            width: cardW - 32,
            lineBreak: false,
          });
        const max = Math.max(...ch.items.map((i) => i.value), 1);
        const labelW = Math.min(cardW * 0.38, 110);
        const trackX = x + 16 + labelW + 6;
        const trackW = cardW - 32 - labelW - 6 - 30;
        ch.items.forEach((it, ri) => {
          const ry = y + 36 + ri * rowH;
          doc
            .font('Body')
            .fontSize(9)
            .fillColor(C.inkSoft)
            .text(fit(it.label, labelW), x + 16, ry + 2, { lineBreak: false });
          doc.roundedRect(trackX, ry + 3, trackW, 7, 3.5).fill('#ffffff');
          if (it.value > 0)
            doc
              .roundedRect(
                trackX,
                ry + 3,
                Math.max((it.value / max) * trackW, 7),
                7,
                3.5,
              )
              .fill(C.blue);
          doc
            .font('BodySemi')
            .fontSize(9)
            .fillColor(C.ink)
            .text(
              it.value.toLocaleString('en-IN'),
              trackX + trackW + 6,
              ry + 2,
              { width: 24, lineBreak: false },
            );
        });
      });
      y += cardH + 24;
    }

    // ── Table ─────────────────────────────────────────────────────────────────
    const cols = o.columns;
    const PAD = 10;
    const BAR_COL = 86;
    // Widths are measured, not guessed: every column fits its header and widest cell (text capped),
    // spare room goes to text columns, and if the page is too narrow only the text columns give way.
    const measure = (c: string, font: string, size: number) =>
      doc.font(font).fontSize(size).widthOfString(c);
    const minW = cols.map((c) => measure(c.label, 'BodyBold', 9) + PAD + 2);
    const natW = cols.map((c, ci) => {
      if (c.kind === 'bar') return BAR_COL;
      const widest = o.rows.reduce((m, r) => {
        const [main, ...rest] = String(r[ci] ?? '').split('\n');
        return Math.max(
          m,
          measure(main, ci === 0 ? 'BodySemi' : 'Body', 9.5),
          rest.length ? measure(rest.join(' · '), 'Body', 8) : 0,
        );
      }, 0);
      return Math.max(
        Math.min(widest, 190) + PAD + (c.kind === 'status' ? 12 : 0),
        minW[ci],
      );
    });
    const flex = cols.map((c) => c.kind === undefined || c.kind === 'text');
    const total = natW.reduce((a, b) => a + b, 0);
    const colW = natW.map((w, i) => {
      if (total <= CW)
        return flex[i]
          ? w +
              ((CW - total) * w) /
                natW.reduce((a, b, j) => a + (flex[j] ? b : 0), 0)
          : w;
      const give =
        natW.reduce((a, b, j) => a + (flex[j] ? b - minW[j] : 0), 0) || 1;
      return flex[i] ? w - ((total - CW) * (w - minW[i])) / give : w;
    });
    const colX = colW.map(
      (_, i) => M + colW.slice(0, i).reduce((a, b) => a + b, 0),
    );
    const textX = (i: number) => colX[i] + (i === 0 ? 0 : PAD / 2);
    const innerW = (i: number) =>
      colW[i] - PAD - (cols[i].kind === 'status' ? 12 : 0);

    const drawHead = () => {
      cols.forEach((c, i) => {
        doc
          .font('BodyBold')
          .fontSize(9)
          .fillColor(C.ink)
          .text(c.label, textX(i), y, {
            width: colW[i] - PAD,
            align: c.kind === 'num' ? 'right' : 'left',
            lineBreak: false,
            ellipsis: true,
          });
      });
      y += 17;
      doc
        .moveTo(M, y)
        .lineTo(M + CW, y)
        .lineWidth(1.4)
        .strokeColor(C.ink)
        .stroke();
      y += 2;
    };

    const dotColour = (v: string) =>
      /^(active|published|approved|present)$/i.test(v)
        ? C.blue
        : /^(draft|pending)$/i.test(v)
          ? C.amberDeep
          : C.mute;

    if (cols.length) {
      if (y + 80 > FOOT_Y) {
        doc.addPage();
        runningHeader();
      }
      drawHead();
      o.rows.forEach((row) => {
        const cells = cols.map((_, i) => String(row[i] ?? '—'));
        const h =
          Math.max(
            ...cells.map((c, i) => {
              if (cols[i].kind === 'bar') return 12;
              const [main, ...rest] = c.split('\n');
              let t = doc
                .font(i === 0 ? 'BodySemi' : 'Body')
                .fontSize(9.5)
                .heightOfString(main, { width: innerW(i) });
              if (rest.length)
                t += doc
                  .font('Body')
                  .fontSize(8)
                  .heightOfString(rest.join(' · '), { width: innerW(i) });
              return t;
            }),
          ) + 14;
        if (y + h > FOOT_Y - 10) {
          doc.addPage();
          runningHeader();
          drawHead();
        }
        cells.forEach((c, i) => {
          const k = cols[i].kind;
          const x = textX(i);
          if (k === 'bar') {
            const v = Number(c);
            if (c === '—' || Number.isNaN(v)) {
              doc
                .font('Body')
                .fontSize(9.5)
                .fillColor(C.mute)
                .text('—', x, y + 7, { lineBreak: false });
              return;
            }
            const tw = colW[i] - PAD - 30;
            doc.roundedRect(x, y + 9, tw, 6, 3).fill(C.wash);
            if (v > 0)
              doc
                .roundedRect(
                  x,
                  y + 9,
                  Math.max((Math.min(v, 100) / 100) * tw, 6),
                  6,
                  3,
                )
                .fill(C.blue);
            doc
              .font('BodySemi')
              .fontSize(9)
              .fillColor(C.ink)
              .text(`${Math.round(v)}%`, x + tw + 4, y + 7.5, {
                width: 26,
                lineBreak: false,
              });
            return;
          }
          const [main, ...rest] = c.split('\n');
          const dot = k === 'status' && c !== '—';
          if (dot) doc.circle(x + 3, y + 13.2, 3).fill(dotColour(c));
          const tx = x + (dot ? 12 : 0);
          doc
            .font(i === 0 ? 'BodySemi' : 'Body')
            .fontSize(9.5)
            .fillColor(i === 0 ? C.ink : C.inkSoft)
            .text(main, tx, y + 7, {
              width: innerW(i),
              align: k === 'num' ? 'right' : 'left',
            });
          if (rest.length) {
            doc
              .font('Body')
              .fontSize(8)
              .fillColor(C.mute)
              .text(rest.join(' · '), tx, doc.y + 1, {
                width: innerW(i),
                align: k === 'num' ? 'right' : 'left',
              });
          }
        });
        y += h;
        doc
          .moveTo(M, y)
          .lineTo(M + CW, y)
          .lineWidth(0.6)
          .strokeColor(C.line)
          .stroke();
      });

      if (o.rows.length === 0) {
        doc.roundedRect(M, y + 8, CW, 54, 14).fill(C.wash);
        doc
          .font('BodySemi')
          .fontSize(11)
          .fillColor(C.ink)
          .text('Nothing matches these filters.', M + 20, y + 22, {
            lineBreak: false,
          });
        doc
          .font('Body')
          .fontSize(10)
          .fillColor(C.inkSoft)
          .text(
            'Change the filters and download the report again.',
            M + 20,
            y + 38,
            { lineBreak: false },
          );
        y += 62;
      }
    }

    if (o.footnote) {
      if (y + 24 > FOOT_Y) {
        doc.addPage();
        runningHeader();
      }
      doc
        .font('Body')
        .fontSize(9)
        .fillColor(C.inkSoft)
        .text(o.footnote, M, y + 10, { width: CW, lineBreak: false });
    }

    // ── Footer on every page (after layout, so "of N" is known) ───────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc
        .moveTo(M, FOOT_Y)
        .lineTo(M + CW, FOOT_Y)
        .lineWidth(0.6)
        .strokeColor(C.line)
        .stroke();
      logo('yugminds-logo.png', M - 6, FOOT_Y + 3, 30);
      doc
        .font('BodySemi')
        .fontSize(8.5)
        .fillColor(C.ink)
        .text('Yugminds', M + 26, FOOT_Y + 11, { lineBreak: false });
      doc
        .font('Body')
        .fontSize(8.5)
        .fillColor(C.inkSoft)
        .text('Confidential. For school use only.', M + 26, FOOT_Y + 22, {
          lineBreak: false,
        });
      doc
        .font('Body')
        .fontSize(8.5)
        .fillColor(C.inkSoft)
        .text(`Page ${i + 1} of ${range.count}`, M, FOOT_Y + 16, {
          width: CW,
          align: 'right',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
