// Adds Subresource Integrity hashes to the built index.html (D-16).
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

export function sriPlugin(): Plugin {
  return {
    name: 'advence-sri',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') return;
      let src = String(html.source);
      src = src.replace(/<(script|link)([^>]*?)(src|href)="\.\/([^"]+)"([^>]*)>/g, (m, tag, pre, attr, file, post) => {
        const asset = bundle[file];
        if (!asset) return m;
        const content = asset.type === 'chunk' ? asset.code : asset.source;
        const hash = createHash('sha384').update(content).digest('base64');
        if (/integrity=/.test(m)) return m;
        const co = /crossorigin/.test(m) ? '' : ' crossorigin="anonymous"';
        return `<${tag}${pre}${attr}="./${file}" integrity="sha384-${hash}"${co}${post}>`;
      });
      html.source = src;
    },
  };
}
