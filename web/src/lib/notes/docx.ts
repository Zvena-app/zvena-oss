// zvena Documents: Word (.docx) → HTML for the importer (mammoth, BSD-2).
// Headings 1–4, lists, tables, bold/italic/underline/strike and links come
// through; images go to `upload` (Documents' own files) instead of staying
// data: URIs. The HTML then becomes blocks through the editor's parser.

import mammoth from "mammoth";

/** Word styles mammoth does not map by itself (Notion's import reads them as these blocks). */
const STYLE_MAP = [
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "r[style-name='Strong'] => strong",
  "u => u",
  "strike => s",
];

export interface DocxResult {
  html: string;
  /** The document title (a leading Title paragraph), when there is one. */
  title: string | null;
  images: number;
}

export async function docxToHtml(buf: ArrayBuffer, upload?: (file: File) => Promise<string>): Promise<DocxResult> {
  let images = 0;
  const convertImage = upload
    ? mammoth.images.imgElement(async (image) => {
        images += 1;
        const bytes = await image.readAsArrayBuffer();
        const ext = (/^image\/([a-z0-9.+-]+)$/.exec(image.contentType)?.[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
        try {
          return { src: await upload(new File([bytes], `image-${images}.${ext}`, { type: image.contentType })) };
        } catch {
          // An image that cannot be uploaded is left out (a data: URI would bloat the page).
          return { src: "" };
        }
      })
    : undefined;
  // The browser build takes an ArrayBuffer, Node's (tests) a Buffer.
  const input = typeof window === "undefined" ? { buffer: Buffer.from(buf) } : { arrayBuffer: buf };
  const res = await mammoth.convertToHtml(input, { styleMap: STYLE_MAP, ...(convertImage ? { convertImage } : {}) });
  let html = res.value.replace(/<img src=""[^>]*>/g, "");
  // Word's Title paragraph at the top becomes the page title; any other is a heading.
  let title: string | null = null;
  const m = /^<h1 class="doc-title">([\s\S]*?)<\/h1>/.exec(html);
  if (m && !/<(img|a)\b/.test(m[1])) {
    title = m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim() || null;
    if (title) html = html.slice(m[0].length);
  }
  html = html.replace(/<h1 class="doc-title">/g, "<h1>");
  return { html, title, images };
}
