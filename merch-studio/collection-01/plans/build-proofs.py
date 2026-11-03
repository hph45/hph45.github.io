from pathlib import Path
import json, math, re, html
import fitz
root=Path(__file__).resolve().parent.parent
data=json.loads((root/'plans/collection.json').read_text())
out=root/'proofs';out.mkdir(exist_ok=True)
arts=[(item,art) for item in data['items'] for art in item['artwork_files']]
for page in range(math.ceil(len(arts)/12)):
    svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1080" viewBox="0 0 1200 1080"><rect width="1200" height="1080" fill="#f7f5f0"/>'
    for j,(item,art) in enumerate(arts[page*12:(page+1)*12]):
        x=(j%4)*300;y=(j//4)*360;raw=(root/art['svg']).read_text()
        w,h=map(float,re.search('viewBox="([^"]+)"',raw).group(1).split()[2:])
        scale=min(260/w,280/h);body=raw[raw.index('>')+1:raw.rindex('</svg>')]
        bg='#292929' if item['ink']=='cream' else '#e8e4dc'
        svg+=f'<rect x="{x+10}" y="{y+10}" width="280" height="300" fill="{bg}"/><g transform="translate({x+150-w*scale/2} {y+160-h*scale/2}) scale({scale})">{body}</g><text x="{x+12}" y="{y+334}" font-size="15" fill="#111">{html.escape(item["id"])} / {art["side"]}</text><text x="{x+12}" y="{y+353}" font-size="12" fill="#555">{art["width_mm"]} × {art["height_mm"]} mm</text>'
    svg+='</svg>';doc=fitz.open(stream=svg.encode(),filetype='svg')
    doc[0].get_pixmap(alpha=False).save(out/f'artwork-proof-{page+1}.png')
print('Artwork proofs updated.')
