// Format conversion of the existing brand asset. No generated garment images are edited.
const fs = require('node:fs');
const path = require('node:path');
const potrace = require('/private/tmp/zbc-merch-trace/node_modules/potrace');
const root = path.resolve(__dirname, '..');
potrace.trace(path.join(root, 'reference/brand-logo-transparent.png'), {
  threshold: 180, turdSize: 2, optTolerance: 0.15, color: '#000000',
}, (error, svg) => {
  if (error) throw error;
  fs.writeFileSync(path.join(root, 'reference/brand-logo-traced.svg'), svg);
  console.log('Saved scalable crest paths.');
});
