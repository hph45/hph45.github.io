"""Resolve U.S. city centers against pinned Census metropolitan boundaries."""
import argparse,collections,hashlib,itertools,json,math,xml.etree.ElementTree as ET,zipfile
from pathlib import Path
from prepare import write

SOURCE='https://www2.census.gov/geo/tiger/GENZ2023/kml/cb_2023_us_cbsa_500k.zip'
NS={'k':'http://www.opengis.net/kml/2.2'}

def in_ring(x,y,ring):
    inside=False
    for (ax,ay),(bx,by) in zip(ring,ring[1:]+ring[:1]):
        if (ay>y)!=(by>y) and x<(bx-ax)*(y-ay)/(by-ay)+ax:inside=not inside
    return inside

def winding(x,y,ring):
    n=0
    for (ax,ay),(bx,by) in zip(ring,ring[1:]+ring[:1]):
        cross=(bx-ax)*(y-ay)-(x-ax)*(by-ay)
        if ay<=y<by and cross>0:n+=1
        elif by<=y<ay and cross<0:n-=1
    return n!=0

def polygons(path):
    with zipfile.ZipFile(path) as z:
        root=ET.fromstring(z.read(next(n for n in z.namelist() if n.endswith('.kml'))))
    result=[]
    for p in root.findall('.//k:Placemark',NS):
        data={x.attrib['name']:x.text for x in p.findall('.//k:SimpleData',NS)}
        if data['LSAD']!='M1':continue  # Do not silently broaden to combined statistical areas.
        for poly in p.findall('.//k:Polygon',NS):
            def ring(node):return [tuple(map(float,token.split(',')[:2])) for token in node.text.split()]
            outer=ring(poly.find('k:outerBoundaryIs/k:LinearRing/k:coordinates',NS))
            holes=[ring(x) for x in poly.findall('k:innerBoundaryIs/k:LinearRing/k:coordinates',NS)]
            xs,ys=zip(*outer)
            result.append({'id':data['CBSAFP'],'name':data['NAMELSAD'],'bbox':(min(xs),min(ys),max(xs),max(ys)),
                           'outer':outer,'holes':holes})
    return result

def main(directory):
    from engine import km
    directory=Path(directory);path=directory/'cb_2023_us_cbsa_500k.zip';shapes=polygons(path)
    snapshot=json.loads((directory/'snapshot.json').read_text());policy=json.loads((directory/'policy.json').read_text())
    cities={p['city_id']:{k:p[k] for k in ('city_id','city','region','country','latitude','longitude')}
            for p in snapshot['profiles'] if p['country']=='United States'}
    mapped={};unmapped=[];groups=collections.defaultdict(list)
    for cid,c in sorted(cities.items()):
        x,y=c['longitude'],c['latitude'];found={}
        for shape in shapes:
            left,bottom,right,top=shape['bbox']
            if not(left<=x<=right and bottom<=y<=top):continue
            ray=in_ring(x,y,shape['outer']) and not any(in_ring(x,y,h) for h in shape['holes'])
            independent=winding(x,y,shape['outer']) and not any(winding(x,y,h) for h in shape['holes'])
            if ray!=independent:raise ValueError('Geometric check disagrees for city '+str(cid))
            if ray:found[shape['id']]=shape['name']
        if len(found)==1:
            mid,name=next(iter(found.items()));mapped[cid]={**c,'metro_code':mid,'metro_name':name};groups[mid].append(cid)
        else:unmapped.append({'city_id':cid,'city':c['city'],'reason':'No unambiguous M1 metro polygon contains city center'})
    evidence={tuple(e['city_ids']):e for e in policy.get('verified_metro_evidence',[])}
    before=len(evidence);sha=hashlib.sha256(path.read_bytes()).hexdigest()
    for mid,ids in groups.items():
        for a,b in itertools.combinations(sorted(ids),2):
            if km(cities[a],cities[b])>75:continue
            evidence[(a,b)]={'city_ids':[a,b],'source_url':SOURCE,'source_sha256':sha,'metro_code':mid,
                             'basis':'Both stored city centers fall inside '+mapped[a]['metro_name']+'; centers within 75 km. No door-to-door travel claim.',
                             'checked_on':policy['as_of_date']}
    policy['verified_metro_city_pairs']=[list(k) for k in sorted(evidence)]
    policy['verified_metro_evidence']=[evidence[k] for k in sorted(evidence)]
    policy['us_metro_source']={'url':SOURCE,'sha256':sha,'boundary_vintage':2023,'class':'M1 metropolitan areas only',
                               'maximum_city_center_distance_km':75,'verification':'Ray crossing and independent winding-number tests agree.'}
    write(directory/'us-metro-cities.json',{'mapped':mapped,'unmapped':unmapped,'source':policy['us_metro_source']})
    write(directory/'policy.json',policy)
    print(json.dumps({'us_cities':len(cities),'mapped_to_metro':len(mapped),'unmapped':len(unmapped),
                      'verified_city_pairs_before':before,'verified_city_pairs_after':len(evidence)}))

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('run_dir');main(ap.parse_args().run_dir)
