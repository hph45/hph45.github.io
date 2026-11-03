"""Build native, outlined SVG artwork and transparent 300-DPI supplier exports.

This authors vector graphics; it never retouches or composites the AI garment renders.
Renders visualize the design direction. These flat masters govern manufacturing.
Run with PyMuPDF, Pillow and fontTools installed. macOS font paths are used only
to create outlines; no font binaries are included in the supplier handoff.
"""
from pathlib import Path
import json, math, re, html, io
from functools import lru_cache
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artwork'
OUT.mkdir(exist_ok=True)
BLACK, CREAM = '#111111', '#f4efdf'
FONT_ROOT = Path('/System/Library/Fonts/Supplemental')
FONTS = {k: TTFont(FONT_ROOT / f) for k, f in {
    'serif':'Times New Roman.ttf', 'bold':'Times New Roman Bold.ttf',
    'italic':'Times New Roman Italic.ttf', 'sans':'Arial Bold.ttf'
}.items()}

@lru_cache(None)
def metrics(s, face='bold', tracking=0):
    font=FONTS[face]; gs=font.getGlyphSet(); cmap=font.getBestCmap()
    positions=[]; x=0; all_bounds=[]
    for ch in s:
        name=cmap[ord(ch)]; g=gs[name]; b=BoundsPen(gs); g.draw(b)
        positions.append((name,x))
        if b.bounds:
            a,c,d,e=b.bounds; all_bounds.append((a+x,c,d+x,e))
        x+=font['hmtx'][name][0]+tracking
    return positions, (min(b[0] for b in all_bounds),min(b[1] for b in all_bounds),max(b[2] for b in all_bounds),max(b[3] for b in all_bounds))

def textpath(s,x,y,w,h=None,face='bold',tracking=0):
    gs=FONTS[face].getGlyphSet(); positions,b=metrics(s,face,tracking)
    sx=w/(b[2]-b[0]); sy=sx if h is None else h/(b[3]-b[1])
    pen=SVGPathPen(gs)
    for name,offset in positions:
        gs[name].draw(TransformPen(pen,(sx,0,0,-sy,x+(offset-b[0])*sx,y+b[3]*sy)))
    return pen.getCommands()

def path(d,c=BLACK,extra=''):
    return f'<path d="{d}" fill="{c}" {extra}/>'
def text(s,x,y,w,h=None,c=BLACK,face='bold',tracking=0):
    return path(textpath(s,x,y,w,h,face,tracking),c)
def rectpath(x,y,w,h):
    return f'M{x} {y}h{w}v{h}h{-w}Z'
def rect(x,y,w,h,c=BLACK): return path(rectpath(x,y,w,h),c)
def group(body,transform): return f'<g transform="{transform}">{body}</g>'
def ring(x,y,w,h,t,c):
    return path(rectpath(x,y,w,h)+rectpath(x+t,y+t,w-2*t,h-2*t),c,'fill-rule="evenodd"')
def ellipse(cx,cy,rx,ry,c,stroke=None,sw=0):
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{c}" stroke="{stroke or "none"}" stroke-width="{sw}"/>'

def arc(s,cx,cy,r,size,c,lower=False):
    font=FONTS['bold']; gs=font.getGlyphSet(); cm=font.getBestCmap(); scale=size/font['head'].unitsPerEm
    widths=[font['hmtx'][cm[ord(ch)]][0]*scale+2 for ch in s]; total=sum(widths); offset=-total/2
    out=''
    for ch,adv in zip(s,widths):
        a=(offset+adv/2)/r; px=cx+r*math.sin(a); py=cy+(r*math.cos(a) if lower else -r*math.cos(a))
        p=SVGPathPen(gs); gs[cm[ord(ch)]].draw(p)
        out+=group(group(path(p.getCommands(),c),f'translate({-adv/2} 0) scale({scale} {-scale})'),f'translate({px} {py}) rotate({math.degrees(-a if lower else a)})')
        offset+=adv
    return out

trace=(ROOT/'reference/brand-logo-traced.svg').read_text()
TRACE_D=re.search(r'<path[^>]*d="([^"]+)"',trace).group(1)
bp=BoundsPen(None); parse_path(TRACE_D,bp); TX,TY,TX2,TY2=bp.bounds

def crest(c=BLACK,patch=False):
    if patch:
        rectangular=patch=='rect'
        h=960 if rectangular else 760; sc=h/(TY2-TY); w=(TX2-TX)*sc
        if rectangular:
            body='<rect x="5" y="5" width="990" height="1190" rx="65" fill="'+CREAM+'"/>'
        else:
            body=ellipse(500,500,495,495,CREAM)+ellipse(500,500,472,472,'none',BLACK,7)
        body+=group(path(TRACE_D,BLACK,'fill-rule="evenodd"'),f'translate({(1000-w)/2} 110) scale({sc}) translate({-TX} {-TY})')
        return 1000,1200 if rectangular else 1000,body
    sc=1000/(TX2-TX)
    return 1000,(TY2-TY)*sc,group(path(TRACE_D,c,'fill-rule="evenodd"'),f'scale({sc}) translate({-TX} {-TY})')

def wordmark(c=BLACK): return 1000,104,text('ZEBRA BOOK CLUB',0,0,1000,104,c)
def initials(c=BLACK): return 1000,325,text('ZBC',0,0,1000,325,c)
def editorial(c=BLACK):
    return 1000,495,text('ZEBRA',0,0,1000,285,c)+text('BOOK CLUB',0,330,1000,165,c)

def varsity(c=BLACK,cap=False):
    z='M0 0H280V65L105 300H280V365H0V300L175 65H0Z'
    b='M345 0H570L620 45V140L590 180L625 220V320L580 365H345ZM425 70V145H525L545 125V90L525 70ZM425 218V295H530L547 278V238L530 218Z'
    cc='M735 0H940L1000 60V130H920V90L900 70H780L760 90V275L780 295H900L920 275V235H1000V305L940 365H735L675 305V60Z'
    shapes=z+b+cc
    body=path(shapes,c,'fill-rule="evenodd"')
    if not cap:
        body=group(path(shapes,CREAM,'fill-rule="evenodd" stroke="'+CREAM+'" stroke-width="20" stroke-linejoin="miter"')+body,'translate(12 12) scale(.976)')
    body+=text('BOOK CLUB',150,415,700,75,c,'sans',180)
    return 1000,490,body

def stripe(c=BLACK,with_brand=False):
    d1='M70 0H930L895 64C742 176 441 255 271 429C333 241 599 139 741 61H148L77 182H45Z'
    d2='M862 181C782 408 421 452 167 684C236 462 625 352 862 181Z'
    d3='M142 727C342 545 635 498 817 340C758 532 443 614 269 747H791L881 552H918L866 810H75Z'
    body=path(d1+d2+d3,c)
    if with_brand:
        body=group(body,'translate(175 0) scale(.65)')+group(editorial(c)[2],'translate(0 620) scale(1 .65)')
        return 1000,942,body
    return 1000,810,body

def open_book(c=BLACK,with_brand=True):
    wing=''
    for n in range(4):
        x=150-45*n; y=60*n
        wing+=path(f'M{x} {y}C{320+n*7} {y+3} 440 {245+n*25} 500 350C405 {245+n*22} 280 {y+46} {x-20} {y+46}Z',c)
    body=wing+group(wing,'translate(1000 0) scale(-1 1)')
    if with_brand: body+=text('ZEBRA BOOK CLUB',15,405,970,88,c)
    return 1000,493 if with_brand else 350,body

def checker(c=BLACK,cap=False):
    # A single opaque ink with transparent negative lettering for screenprint.
    body=''; rows=2 if cap else 3; cell=100; band_top=rows*cell; band_h=210
    for row in range(rows):
        for col in range(10):
            if (row+col)%2==0:
                body+=rect(col*cell,row*cell,cell,cell,c)
                body+=rect(col*cell,band_top+band_h+row*cell,cell,cell,c)
    title='ZBC' if cap else 'ZEBRA BOOK CLUB'
    if c==CREAM:
        body+=ring(0,band_top,1000,band_h,4,c)+text(title,65,band_top+45,870,120,c)
    else:
        d=rectpath(0,band_top,1000,band_h)+textpath(title,65,band_top+45,870,120)
        body+=path(d,c,'fill-rule="evenodd"')
    h=2*rows*cell+band_h
    if cap:
        # The patch's contrasting ground is a woven yarn color, not garment ink.
        body=rect(0,0,1000,h,BLACK)+body
    return 1000,h,body

def book_lines(c=BLACK):
    d='M0 125L15 15Q90 -15 150 30Q210 -15 285 15L300 125Q225 102 150 145Q75 102 0 125ZM150 30V145M20 112Q80 95 140 130M160 130Q220 95 280 112M27 22L15 116M273 22L285 116'
    return f'<path d="{d}" fill="none" stroke="{c}" stroke-width="7" stroke-linejoin="round"/>'

def seal(c=BLACK,patch=False):
    body=ellipse(500,325,490,315,'none',c,10)+ellipse(500,325,469,294,'none',c,4)
    body+=arc('ZEBRA BOOK CLUB',500,520,420,68,c)
    body+=group(book_lines(c),'translate(355 250) scale(.97 .8)')
    body+=text('SAN FRANCISCO',205,425,590,48,c,'serif',160)
    body+=text('2025',390,520,220,56,c,'serif',200)
    if patch: body=ellipse(500,325,500,325,BLACK)+seal(CREAM)[2]
    return 1000,650,body

def shelf(c=BLACK,cap=False):
    d=''
    for x,y,ch in [(0,160,'Z'),(340,0,'B'),(680,270,'C')]:
        d+=rectpath(x,y,300,1000-y)
        d+=rectpath(x,y+70,300,20)+rectpath(x,y+120,300,20)
        d+=rectpath(x,900,300,20)+rectpath(x,955,300,20)
        d+=textpath(ch,x+55,y+260,190,310,face='serif')
    body=path(d,c,'fill-rule="evenodd"')
    if cap: body=group(body,'scale(1 .625)')
    return 980,625 if cap else 1000,body

def ornament(c):
    return path('M0 0C28 4 34 32 6 47C2 29 7 17 0 0ZM16 0C43 -3 58 7 62 21C38 28 25 15 16 0ZM0 19C-7 38 -1 58 16 64C23 41 17 29 0 19Z',c)
def bookplate(c=BLACK,patch=False):
    body=ring(7,7,986,1316,12,c)+ring(39,39,922,1252,5,c)
    for transform in ['translate(80 80)','translate(920 80) scale(-1 1)','translate(80 1250) scale(1 -1)','translate(920 1250) scale(-1 -1)']:
        body+=group(ornament(c),transform)
    body+=text('EX LIBRIS',175,190,650,90,c,tracking=90)
    body+=text('Z',225,355,550,570,c,'serif')
    body+=text('ZEBRA',240,990,520,105,c)+text('BOOK CLUB',150,1130,700,90,c)
    if patch: body=rect(0,0,1000,1330,CREAM)+bookplate(BLACK)[2]
    return 1000,1330,body
def quiet(c=BLACK): return 1000,100,text('zebra book club.',0,0,1000,100,c)

def globe(c=BLACK):
    body=ellipse(500,500,490,490,'none',c,22)+ellipse(500,500,220,490,'none',c,18)
    body+=rect(490,10,20,980,c)+rect(10,490,980,20,c)
    body+=rect(76,245,848,18,c)+rect(76,737,848,18,c)
    return 1000,1000,body
def world(c=BLACK,cap=False):
    if cap:
        return 1000,400,group(globe(c)[2],'scale(.4)')+text('ZBC',475,85,525,230,c)
    body=group(globe(c)[2],'translate(230 230) scale(.64)')
    body+=arc('A WORLD OF READERS',550,550,455,74,c)
    body+=arc('ZEBRA BOOK CLUB',550,550,490,74,c,True)
    return 1100,1115,body
def edition(c=BLACK,cap=False):
    if cap:
        return 1000,520,text('01',200,0,600,355,c,'serif')+rect(0,392,1000,10,c)+text('ZEBRA BOOK CLUB',0,440,1000,80,c)
    return 1000,1015,text('01',35,0,930,800,c,'serif')+rect(0,862,1000,10,c)+text('ZEBRA BOOK CLUB',0,935,1000,80,c)

def title_stack(c=CREAM):
    ref=metrics('Zebra')[1]; scale=1000/(ref[2]-ref[0]); body=''; bottom=0
    for row,word in enumerate(['Zebra','Book','Club']):
        b=metrics(word)[1]; w=(b[2]-b[0])*scale; h=(b[3]-b[1])*scale
        y=row*390; body+=text(word,0,y,w,h,c); bottom=y+h
    return 1000,bottom,body

def arched_title(c=BLACK):
    s='Zebra Book Club'; font=FONTS['bold']; gs=font.getGlyphSet(); cm=font.getBestCmap()
    size=90; scale=size/font['head'].unitsPerEm; r=640
    widths=[font['hmtx'][cm[ord(ch)]][0]*scale+2 for ch in s]
    offset=-sum(widths)/2; pen=SVGPathPen(gs)
    for ch,adv in zip(s,widths):
        a=(offset+adv/2)/r; co=math.cos(a); si=math.sin(a)
        x=r*si-adv/2*co; y=-r*co-adv/2*si
        gs[cm[ord(ch)]].draw(TransformPen(pen,(co*scale,si*scale,si*scale,-co*scale,x,y)))
        offset+=adv
    d=pen.getCommands(); b=BoundsPen(None); parse_path(d,b); x,y,x2,y2=b.bounds
    return x2-x,y2-y,group(path(d,c),f'translate({-x} {-y})')

FAMILY_BUILDERS={
 'founders-crest':crest,'editorial-stack':editorial,'varsity-zbc':varsity,
 'stripe-z':stripe,'open-chapter':open_book,'checkerboard':checker,
 'library-seal':seal,'the-shelf':shelf,'ex-libris':bookplate,
 'quiet-club':quiet,'world-of-readers':world,'edition-01':edition,
}

def svg_file(name,art,width_mm,title):
    w,h,body=art; height_mm=width_mm*h/w
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{width_mm:.3f}mm" height="{height_mm:.3f}mm" viewBox="0 0 {w} {h}"><title>{html.escape(title)}</title><desc>Supplier-neutral outlined vector artwork. Dimensions are proposed; proof on selected blank before production.</desc>{body}</svg>'
    dst=OUT/(name+'.svg'); dst.write_text(svg)
    doc=fitz.open(stream=svg.encode(),filetype='svg')
    pix=doc[0].get_pixmap(matrix=fitz.Matrix(300/72,300/72),alpha=True)
    # Encode the vector rasterization with a 300-DPI pHYs tag. No interpolation.
    im=Image.open(io.BytesIO(pix.tobytes('png')))
    im.save(OUT/(name+'-300dpi.png'),dpi=(300,300))
    return {'svg':f'artwork/{name}.svg','png':f'artwork/{name}-300dpi.png','width_mm':round(width_mm,2),'height_mm':round(height_mm,2),'pixels':[im.width,im.height]}

def item_parts(item):
    c=BLACK if item['ink']=='black' else CREAM
    if item['id']=='H01-R1': return [('front',title_stack(CREAM),70),('back',crest(CREAM),270)]
    if item['id']=='T01-R1': return [('front',crest(BLACK),70),('back',wordmark(BLACK),95)]
    if item['id']=='C04-R1':
        art=crest(BLACK)
        return [('front',art,55*art[0]/art[1]),('back',arched_title(BLACK),110)]
    n=int(item['id'][1:]); cat=item['category']; cap=cat=='cap'
    fn=FAMILY_BUILDERS[item['family']]
    if cap:
        if n==1: art=crest(c,True)
        elif n==3: art=varsity(c,True)
        elif n==5: art=open_book(c,False)
        elif n==6: art=checker(c,True)
        elif n==7: art=seal(c,True)
        elif n==8: art=shelf(c,True)
        elif n==9: art=bookplate(c,True)
        elif n==11: art=world(c,True)
        elif n==12: art=edition(c,True)
        else: art=fn(c)
        patch='patch' in item['method'].lower()
        width=min(item['main'],(60 if patch else 50)*art[0]/art[1])
        out=[('front',art,width)]
        if item['secondary']: out.append(('back',initials(c),item['secondary']))
        return out
    if cat=='hoodie':
        if n==1: return [('front',crest(c,'rect'),70),('back',crest(c),270)]
        if n==2: return [('front',fn(c),285),('back',initials(c),70)]
        if n==4: return [('front',fn(c),120),('back',editorial(c),260)]
        if n==6: return [('front',initials(c),65),('back',fn(c),280)]
        if n==8: return [('front',fn(c),235),('back',wordmark(c),200)]
        if n==9: return [('front',(1000,1000,text('Z',0,0,1000,1000,c,'serif')),65),('back',fn(c),260)]
        if n==11: return [('front',globe(c),65),('back',fn(c),275)]
        if n==12: return [('front',editorial(c),100),('back',fn(c),275)]
        return [('front',fn(c),item['main'])]
    if n==1: return [('front',fn(c),250),('back',wordmark(c),95)]
    if n==2: return [('front',fn(c),280),('back',initials(c),70)]
    if n==4: return [('front',stripe(c,True),220)]
    if n==7: return [('front',fn(c),110),('back',fn(c),280)]
    return [('front',fn(c),item['main'])]

def main():
    manifest=json.loads((ROOT/'plans/collection.json').read_text())
    # Reconcile the final selected renders with their decoration specs.
    changes={
        'T03':{'method':'Felt appliqué + screenprint','front':'280 mm black felt ZBC with ivory stitched outline; BOOK CLUB printed beneath'},
        'T10':{'method':'Flat embroidery','front':'110 mm lowercase zebra book club. embroidery on wearer’s left chest'},
        'C03':{'method':'3D puff + flat embroidery','front':'100 mm raised cream ZBC; BOOK CLUB in flat embroidery beneath'},
        'C11':{'color':'ivory crown and black brim'},
        'C12':{'main':95,'front':'95 mm compact 01 with rule and ZEBRA BOOK CLUB underneath'},
        'H08':{'secondary':200,'back':'200 mm ZEBRA BOOK CLUB upper-back wordmark'},
    }
    for item in manifest['items']:
        item.update(changes.get(item['id'],{}))
        item['status']='rendered'; item['artwork_files']=[]
        for side,art,width in item_parts(item):
            info=svg_file(item['artwork']+'-'+side,art,width,item['id']+' '+item['name']+' / '+side)
            info['side']=side; item['artwork_files'].append(info)
        item['production_stage']='Supplier-neutral artwork; blank selection, template fit, digitization and physical sample pending.'
    (ROOT/'plans/collection.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (ROOT/'collection-data.js').write_text('window.ZBC_MERCH = '+json.dumps(manifest,ensure_ascii=False)+';\n')
    print('Built',sum(len(i['artwork_files']) for i in manifest['items']),'outlined SVG masters and 300-DPI PNG exports for',len(manifest['items']),'designs.')

if __name__=='__main__': main()
